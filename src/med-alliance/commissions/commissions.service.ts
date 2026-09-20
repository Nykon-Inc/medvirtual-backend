import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommissionStatus, Prisma, USER } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ListCommissionsDto } from './dto/list-commissions.dto';
import { ListMedAllianceAuditLogsDto } from './dto/list-med-alliance-audit-logs.dto';
import {
  DecideCommissionDto,
  VoidCommissionDto,
  ReinstateCommissionDto,
  UpdateBaseAmountDto,
} from './dto/decide-commission.dto';
import { AFFILIATE_VISIBLE_STATUSES } from '../../common/constant/commissions';
import { buildCommissionIdempotencyKey } from '../../common/utils/commission-idempotency';
import { AllianceNotificationsService } from '../notifications/notifications.service';
import { computeLineItemCommissionEligibility } from '../shared/commission-eligibility.util';

// Terminal statuses — transitions out of these are not allowed.
const TERMINAL_STATUSES = ['paid', 'void', 'rejected'];

// Statuses eligible for an admin eligibility decision.
// 'detected' is excluded: commissions must reach 'pending_admin_confirmation' via the 30-day cron before admins can decide.
const DECIDABLE_STATUSES = ['pending_admin_confirmation'];

// Reusable Staff → Candidate name projection, so admins can see *which collaborator*
// a commission (or a line item) is for. Kept as its own const since it's included at
// two levels below: on the commission itself (denormalized staff_id) and per line item.
const STAFF_SELECT = {
  select: {
    id: true,
    candidate: { select: { first_name: true, last_name: true } },
  },
};

const COMMISSION_SELECT = {
  id: true,
  affiliate_id: true,
  affiliate_profile_id: true,
  organization_id: true,
  hubspot_invoice_snapshot_id: true,
  hubspot_line_item_snapshot_id: true,
  staff_id: true,
  commission_percent_snapshot: true,
  base_amount_snapshot: true,
  commission_amount: true,
  status: true,
  idempotency_key: false, // never expose the idempotency key
  admin_decision_by: true,
  admin_decision_reason: true,
  admin_decision_at: true,
  createdAt: true,
  updatedAt: true,
  organization: {
    select: {
      id: true,
      name: true,
      business_unit: true,
      organization_role: true,
      status: true,
      admin: { select: { id: true, first_name: true, last_name: true } },
    },
  },
  staff: STAFF_SELECT,
  hubspotLineItemSnapshot: {
    select: { id: true, name: true, amount: true, staff: STAFF_SELECT },
  },
  hubspotInvoiceSnapshot: {
    select: {
      id: true,
      hubspot_id: true,
      invoice_number: true,
      invoice_status: true,
      invoice_amount: true,
      currency: true,
      paid_at: true,
      due_date: true,
      hubspot_pdf_link: true,
      lineItems: {
        select: {
          id: true,
          name: true,
          description: true,
          quantity: true,
          amount: true,
          discount: true,
          staff: STAFF_SELECT,
        },
      },
    },
  },
};

// Payout linkage — included in admin responses to trace which payout request
// paid a given commission.
const PAYOUT_LINKAGE_SELECT = {
  payoutRequestCommissions: {
    select: {
      payoutRequest: {
        select: {
          id: true,
          status: true,
          requested_amount: true,
          approved_amount: true,
          paid_amount: true,
          payment_method: true,
          payment_reference: true,
          transaction_reference: true,
          paid_at: true,
          createdAt: true,
        },
      },
    },
  },
};

@Injectable()
export class CommissionsService {
  private readonly logger = new Logger(CommissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly allianceNotifications: AllianceNotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Shared: write an audit log entry for a commission transition.
  // ---------------------------------------------------------------------------
  private async writeAuditLog(params: {
    actorUserId: string | null;
    entityId: string;
    event: string;
    oldStatus: string | null;
    newStatus: string | null;
    reason?: string;
    source: 'user' | 'sync' | 'admin_action';
    metadata?: object;
  }) {
    await this.prisma.medAllianceAuditLog.create({
      data: {
        actor_user_id: params.actorUserId,
        entity_type: 'commission',
        entity_id: params.entityId,
        event: params.event,
        old_status: params.oldStatus,
        new_status: params.newStatus,
        reason: params.reason ?? null,
        source: params.source,
        metadata: params.metadata ? (params.metadata as any) : undefined,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Affiliate: list own commissions.
  // ---------------------------------------------------------------------------
  async findAllForAffiliate(dto: ListCommissionsDto, currentUser: USER) {
    const {
      page = 1,
      limit = 20,
      status,
      created_from,
      created_to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = dto;
    const skip = (page - 1) * limit;

    const where: any = { affiliate_id: currentUser.id };
    if (status && AFFILIATE_VISIBLE_STATUSES.includes(status)) {
      where.status = status;
    } else {
      where.status = { in: AFFILIATE_VISIBLE_STATUSES };
    }
    if (created_from || created_to) {
      where.createdAt = {};
      if (created_from) where.createdAt.gte = new Date(created_from);
      if (created_to) where.createdAt.lte = new Date(created_to);
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.affiliateCommission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: COMMISSION_SELECT,
      }),
      this.prisma.affiliateCommission.count({ where }),
    ]);

    return { data, pagination: { page, limit, total } };
  }

  // ---------------------------------------------------------------------------
  // Affiliate: get one commission — scoped to the requesting affiliate.
  // ---------------------------------------------------------------------------
  async findOneForAffiliate(id: string, currentUser: USER) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: { ...COMMISSION_SELECT, affiliate_id: true },
    });
    if (!commission) throw new NotFoundException('Commission not found');
    if (commission.affiliate_id !== currentUser.id) {
      throw new ForbiddenException('You do not have access to this commission');
    }
    return commission;
  }

  // ---------------------------------------------------------------------------
  // Admin: list all commissions with full filter support.
  // ---------------------------------------------------------------------------
  async findAllForAdmin(dto: ListCommissionsDto) {
    const {
      page = 1,
      limit = 20,
      status,
      organization_id,
      affiliate_id,
      created_from,
      created_to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (organization_id) where.organization_id = organization_id;
    if (affiliate_id) where.affiliate_id = affiliate_id;
    if (created_from || created_to) {
      where.createdAt = {};
      if (created_from) where.createdAt.gte = new Date(created_from);
      if (created_to) where.createdAt.lte = new Date(created_to);
    }

    const adminSelect = {
      ...COMMISSION_SELECT,
      ...PAYOUT_LINKAGE_SELECT,
      affiliate: {
        select: { id: true, first_name: true, last_name: true, email: true },
      },
      adminDecisionBy: {
        select: { id: true, first_name: true, last_name: true },
      },
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.affiliateCommission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: adminSelect,
      }),
      this.prisma.affiliateCommission.count({ where }),
    ]);

    return { data, pagination: { page, limit, total } };
  }

  // ---------------------------------------------------------------------------
  // Admin: get one commission — no scoping.
  // ---------------------------------------------------------------------------
  async findOneForAdmin(id: string) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: {
        ...COMMISSION_SELECT,
        ...PAYOUT_LINKAGE_SELECT,
        affiliate: {
          select: { id: true, first_name: true, last_name: true, email: true },
        },
        adminDecisionBy: {
          select: { id: true, first_name: true, last_name: true },
        },
      },
    });
    if (!commission) throw new NotFoundException('Commission not found');
    return commission;
  }

  // ---------------------------------------------------------------------------
  // Admin: approve or reject a commission.
  // ---------------------------------------------------------------------------
  async decide(id: string, dto: DecideCommissionDto, adminUser: USER) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: { id: true, status: true, organization_id: true },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    if (!DECIDABLE_STATUSES.includes(commission.status)) {
      throw new BadRequestException(
        `Commission in status "${commission.status}" cannot be decided. Only ${DECIDABLE_STATUSES.join(', ')} are allowed.`,
      );
    }

    // MA-004 guard: block approval if the referred organization was matched as an active client.
    // An admin can still reject, but cannot approve a commission from an ineligible referral.
    if (dto.decision === 'eligible' && commission.organization_id) {
      const org = await this.prisma.organization.findUnique({
        where: { id: commission.organization_id },
        select: { med_alliance_referral_status: true },
      });
      if (org?.med_alliance_referral_status === 'not_eligible') {
        throw new BadRequestException(
          'Cannot approve commission: referred organization is not eligible for the Med Alliance program.',
        );
      }
    }

    const newStatus = dto.decision === 'eligible' ? 'eligible' : 'rejected';

    const updated = await this.prisma.affiliateCommission.update({
      where: { id },
      data: {
        status: newStatus,
        admin_decision_by: adminUser.id,
        admin_decision_reason: dto.reason ?? null,
        admin_decision_at: new Date(),
      },
      select: COMMISSION_SELECT,
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'admin_decision',
      oldStatus: commission.status,
      newStatus,
      reason: dto.reason,
      source: 'admin_action',
    });

    if (newStatus === 'eligible') {
      const full = await this.prisma.affiliateCommission.findUnique({
        where: { id },
        select: {
          commission_amount: true,
          commission_percent_snapshot: true,
          affiliate: { select: { email: true, first_name: true } },
          organization: { select: { name: true } },
        },
      });
      if (full?.affiliate?.email) {
        void this.allianceNotifications.notifyCommissionEligible(
          {
            email: full.affiliate.email,
            first_name: full.affiliate.first_name ?? '',
          },
          {
            organizationName: full.organization?.name ?? '',
            commissionAmount: parseFloat(String(full.commission_amount ?? 0)),
            commissionPercent: parseFloat(
              String(full.commission_percent_snapshot ?? 0),
            ),
          },
        );
      }
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Admin: void a commission from any non-terminal status.
  // ---------------------------------------------------------------------------
  async void(id: string, dto: VoidCommissionDto, adminUser: USER) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    if (TERMINAL_STATUSES.includes(commission.status)) {
      throw new BadRequestException(
        `Commission is already in a terminal status: "${commission.status}". Cannot void.`,
      );
    }

    const updated = await this.prisma.affiliateCommission.update({
      where: { id },
      data: {
        status: 'void',
        admin_decision_by: adminUser.id,
        admin_decision_reason: dto.reason,
        admin_decision_at: new Date(),
      },
      select: COMMISSION_SELECT,
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'status_changed',
      oldStatus: commission.status,
      newStatus: 'void',
      reason: dto.reason,
      source: 'admin_action',
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Admin: revert an eligible commission back to pending_admin_confirmation.
  // ---------------------------------------------------------------------------
  async revertToPending(id: string, adminUser: USER) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    if (commission.status !== 'eligible') {
      throw new BadRequestException(
        `Only commissions in "eligible" status can be reverted to pending. Current status: "${commission.status}".`,
      );
    }

    const updated = await this.prisma.affiliateCommission.update({
      where: { id },
      data: {
        status: 'pending_admin_confirmation',
        admin_decision_by: null,
        admin_decision_reason: null,
        admin_decision_at: null,
      },
      select: COMMISSION_SELECT,
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'admin_reverted_to_pending',
      oldStatus: 'eligible',
      newStatus: 'pending_admin_confirmation',
      source: 'admin_action',
    });

    /*
    removed on 2026-05-27 asked By Pauli: https://regenta-company.monday.com/boards/9328303960/pulses/12100540751
    const full = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: {
        commission_amount: true,
        affiliate: { select: { first_name: true, last_name: true } },
        organization: { select: { name: true } },
      },
    });
    if (full) {
      void this.allianceNotifications.notifyAdminCommissionReverted({
        organizationName: full.organization?.name ?? '',
        affiliateName:
          `${full.affiliate?.first_name ?? ''} ${full.affiliate?.last_name ?? ''}`.trim(),
        commissionAmount: parseFloat(String(full.commission_amount ?? 0)),
        commissionId: id,
        revertedByName: `${adminUser.first_name} ${adminUser.last_name}`.trim(),
      });
    }
    */

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Admin: unvoid a voided commission back to detected or pending_admin_confirmation.
  // Restores to pending_admin_confirmation if the company is already confirmed eligible,
  // otherwise restores to detected so it waits for an admin eligibility decision.
  // ---------------------------------------------------------------------------
  async unvoid(id: string, dto: { reason: string }, adminUser: USER) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        organization: { select: { med_alliance_referral_status: true } },
      },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    if (commission.status !== 'void') {
      throw new BadRequestException(
        `Only commissions in "void" status can be unvoided. Current status: "${commission.status}".`,
      );
    }

    const targetStatus =
      commission.organization?.med_alliance_referral_status === 'eligible'
        ? 'pending_admin_confirmation'
        : 'detected';

    const updated = await this.prisma.affiliateCommission.update({
      where: { id },
      data: {
        status: targetStatus,
        admin_decision_by: adminUser.id,
        admin_decision_reason: dto.reason,
        admin_decision_at: new Date(),
      },
      select: COMMISSION_SELECT,
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'admin_unvoided',
      oldStatus: 'void',
      newStatus: targetStatus,
      reason: dto.reason,
      source: 'admin_action',
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Admin: reinstate a rejected commission back to eligible.
  // ---------------------------------------------------------------------------
  async reinstate(id: string, dto: ReinstateCommissionDto, adminUser: USER) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    if (commission.status !== 'rejected') {
      throw new BadRequestException(
        `Only commissions in "rejected" status can be reinstated. Current status: "${commission.status}".`,
      );
    }

    const updated = await this.prisma.affiliateCommission.update({
      where: { id },
      data: {
        status: 'eligible',
        admin_decision_by: adminUser.id,
        admin_decision_reason: dto.reason,
        admin_decision_at: new Date(),
      },
      select: COMMISSION_SELECT,
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'admin_reinstated',
      oldStatus: 'rejected',
      newStatus: 'eligible',
      reason: dto.reason,
      source: 'admin_action',
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Admin: update base_amount_snapshot on a detected commission.
  // ---------------------------------------------------------------------------
  async updateBaseAmount(
    id: string,
    dto: UpdateBaseAmountDto,
    adminUser: USER,
  ) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        base_amount_snapshot: true,
        commission_percent_snapshot: true,
      },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    if (
      !['detected', 'pending_admin_confirmation'].includes(commission.status)
    ) {
      throw new BadRequestException(
        `Base amount can only be updated on "detected" or "pending" commissions. Current: "${commission.status}".`,
      );
    }

    const baseAmount = parseFloat(dto.base_amount);
    if (isNaN(baseAmount) || baseAmount <= 0) {
      throw new BadRequestException('base_amount must be a positive number');
    }
    const pct = Number(commission.commission_percent_snapshot);
    const newCommissionAmount = ((baseAmount * pct) / 100).toFixed(2);

    const updated = await this.prisma.affiliateCommission.update({
      where: { id },
      data: {
        base_amount_snapshot: baseAmount.toString(),
        commission_amount: newCommissionAmount,
      },
      select: COMMISSION_SELECT,
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'admin_updated_base_amount',
      oldStatus: commission.status,
      newStatus: commission.status,
      source: 'admin_action',
      metadata: {
        old_base_amount: commission.base_amount_snapshot,
        new_base_amount: baseAmount.toString(),
        new_commission_amount: newCommissionAmount,
      },
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Admin: manually create commissions from selected paid HubSpot invoices.
  // Applies the same business guards as CommissionDetectionService.run() but
  // always sets status to 'pending_admin_confirmation' since the admin is
  // explicitly initiating the creation.
  // ---------------------------------------------------------------------------
  /**
   * Rewritten to per-collaborator commission (per-collaborator commission plan §4.5 #4):
   * `lineItemIds` are HubspotLineItemSnapshot ids (must already be matched to a Staff row),
   * not invoice ids — an admin now force-creates one commission per collaborator payment,
   * not per whole invoice. Uses the same shared eligibility helper CommissionDetectionService
   * and the invoice-paid webhook use, so the 365-day-per-Staff window is enforced here too
   * (this was previously never checked in this manual-create path at all).
   */
  async createFromInvoices(
    affiliateProfileId: string,
    lineItemIds: string[],
    adminUser: USER,
  ): Promise<{ created: number; skipped: number }> {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { id: affiliateProfileId },
      select: {
        id: true,
        user_id: true,
        status: true,
        commission_percent_default: true,
      },
    });
    if (!profile) throw new NotFoundException('Affiliate profile not found');
    if (profile.status !== 'active')
      throw new ForbiddenException('Affiliate profile is not active');
    if (!profile.user_id)
      throw new ForbiddenException('Affiliate has no connected user');

    let created = 0;
    let skipped = 0;

    for (const lineItemId of lineItemIds) {
      const lineItem = await this.prisma.hubspotLineItemSnapshot.findUnique({
        where: { id: lineItemId },
        select: {
          id: true,
          amount: true,
          match_status: true,
          staff_id: true,
          staff: { select: { id: true, start_date: true } },
          invoice: {
            select: {
              id: true,
              hubspot_id: true,
              organization_id: true,
              invoice_status: true,
              invoice_amount: true,
              payment_status: true,
              paid_at: true,
            },
          },
        },
      });

      if (!lineItem) {
        this.logger.warn(`Line item ${lineItemId} not found — skipping`);
        skipped++;
        continue;
      }

      // Must already be matched to a Staff — this endpoint force-creates from an existing
      // match, it does not perform matching itself (that's StaffMatchingService's job).
      if (lineItem.match_status !== 'matched' || !lineItem.staff_id) {
        this.logger.warn(
          `Line item ${lineItemId} is not matched to a Staff — skipping`,
        );
        skipped++;
        continue;
      }

      const snapshot = lineItem.invoice;

      // Re-validate invoice eligibility.
      const isEligibleInvoice =
        snapshot.invoice_status === 'paid' &&
        new Decimal(snapshot.invoice_amount).gt(0) &&
        (snapshot.payment_status === null ||
          snapshot.payment_status === 'succeeded');

      if (!isEligibleInvoice) {
        this.logger.warn(
          `Line item ${lineItemId}: parent invoice failed eligibility check — skipping`,
        );
        skipped++;
        continue;
      }

      // Load the related organization and apply business guards.
      const org = await this.prisma.organization.findUnique({
        where: { id: snapshot.organization_id },
        select: {
          id: true,
          referred_by_affiliate_id: true,
          med_alliance_block_reason: true,
          med_alliance_referral_status: true,
          eligibility_start_at: true,
          first_paid_invoice_at: true,
          referral_stage: true,
          createdAt: true,
        },
      });

      if (!org || org.referred_by_affiliate_id !== profile.user_id) {
        this.logger.warn(
          `Line item ${lineItemId}: org not found or not referred by this affiliate — skipping`,
        );
        skipped++;
        continue;
      }

      if (org.med_alliance_block_reason?.startsWith('active_client_block')) {
        skipped++;
        continue;
      }

      // Company-level expiry status is owned centrally by the admin's Confirm/Block
      // decision (§4.6) — this remains a read-only check, never a writer.
      if (org.med_alliance_referral_status === 'expired') {
        skipped++;
        continue;
      }

      if (org.referral_stage === 'canceled') {
        skipped++;
        continue;
      }

      // Transition to deployed on first paid invoice (idempotent). Stage-only — never touches
      // med_alliance_referral_status (§4.6, manual-only).
      if (!org.first_paid_invoice_at && org.referral_stage !== 'deployed') {
        const firstInvoiceDate = snapshot.paid_at ?? new Date();
        await this.prisma.organization.update({
          where: { id: org.id },
          data: {
            referral_stage: 'deployed',
            eligibility_start_at: firstInvoiceDate,
            first_paid_invoice_at: firstInvoiceDate,
            med_alliance_block_reason: null,
          },
        });
        await this.prisma.medAllianceAuditLog.create({
          data: {
            entity_type: 'referred_company',
            entity_id: org.id,
            event: 'stage_changed',
            old_status: null,
            new_status: null,
            reason:
              'First paid invoice — transitioned to deployed stage via manual commission creation',
            source: 'admin_action',
            actor_user_id: adminUser.id,
            metadata: {
              referral_stage: 'deployed',
              eligibility_start_at: firstInvoiceDate.toISOString(),
            } as any,
          },
        });
      }

      // Per-collaborator 365-day window (§4) — the same eligibility computation
      // CommissionDetectionService and the invoice-paid webhook use, now enforced here too.
      const eligibility = computeLineItemCommissionEligibility({
        lineItemAmount: lineItem.amount ?? 0,
        staffStartDate: lineItem.staff?.start_date ?? null,
        commissionPercent: profile.commission_percent_default,
      });

      if (!eligibility.eligible) {
        this.logger.warn(
          `Line item ${lineItemId}: staff outside the 365-day commission window (${eligibility.skipReason}) — skipping`,
        );
        skipped++;
        continue;
      }

      const idempotencyKey = buildCommissionIdempotencyKey({
        affiliateId: profile.user_id,
        hubspotInvoiceId: snapshot.hubspot_id,
        hubspotLineItemId: lineItem.id,
      });

      try {
        const commission = await this.prisma.affiliateCommission.create({
          data: {
            affiliate_id: profile.user_id,
            affiliate_profile_id: profile.id,
            organization_id: snapshot.organization_id,
            hubspot_invoice_snapshot_id: snapshot.id,
            hubspot_line_item_snapshot_id: lineItem.id,
            staff_id: lineItem.staff_id,
            commission_percent_snapshot: profile.commission_percent_default,
            base_amount_snapshot: lineItem.amount ?? 0,
            commission_amount: eligibility.commissionAmount!,
            status: CommissionStatus.pending_admin_confirmation,
            idempotency_key: idempotencyKey,
          },
          select: { id: true },
        });

        await this.writeAuditLog({
          actorUserId: adminUser.id,
          entityId: commission.id,
          event: 'manual_commission_created',
          oldStatus: null,
          newStatus: 'pending_admin_confirmation',
          source: 'admin_action',
          metadata: {
            organization_id: snapshot.organization_id,
            hubspot_invoice_id: snapshot.hubspot_id,
            hubspot_line_item_snapshot_id: lineItem.id,
            staff_id: lineItem.staff_id,
            created_by_admin: adminUser.id,
          },
        });

        created++;
      } catch (err: any) {
        if (err?.code === 'P2002') {
          skipped++;
          continue;
        }
        this.logger.error(
          `Failed to create commission for line item ${lineItemId}: ${err?.message ?? err}`,
        );
        skipped++;
      }
    }

    this.logger.log(
      `Manual commission creation for affiliate ${affiliateProfileId}: created=${created} skipped=${skipped}`,
    );

    return { created, skipped };
  }

  // ---------------------------------------------------------------------------
  // Shared: get audit log timeline for a commission.
  // ---------------------------------------------------------------------------
  async getAuditLog(id: string) {
    const commission = await this.prisma.affiliateCommission.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!commission) throw new NotFoundException('Commission not found');

    return this.prisma.medAllianceAuditLog.findMany({
      where: { entity_type: 'commission', entity_id: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        event: true,
        old_status: true,
        new_status: true,
        reason: true,
        source: true,
        metadata: true,
        createdAt: true,
        actorUser: { select: { id: true, first_name: true, last_name: true } },
      },
    });
  }

  async findAllAuditLogs(dto: ListMedAllianceAuditLogsDto) {
    const {
      page = 1,
      limit = 20,
      entity_type,
      event,
      source,
      date_from,
      date_to,
      search,
      sortOrder = 'desc',
    } = dto;

    const where: Prisma.MedAllianceAuditLogWhereInput = {
      ...(entity_type && { entity_type }),
      ...(source && { source }),
      ...(event && { event: { contains: event, mode: 'insensitive' } }),
      ...(date_from || date_to
        ? {
            createdAt: {
              ...(date_from && { gte: new Date(date_from) }),
              ...(date_to && {
                lte: new Date(new Date(date_to).setHours(23, 59, 59, 999)),
              }),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { entity_id: { contains: search, mode: 'insensitive' } },
              { event: { contains: search, mode: 'insensitive' } },
              { reason: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, data] = await Promise.all([
      this.prisma.medAllianceAuditLog.count({ where }),
      this.prisma.medAllianceAuditLog.findMany({
        where,
        orderBy: { createdAt: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          entity_type: true,
          entity_id: true,
          event: true,
          old_status: true,
          new_status: true,
          reason: true,
          source: true,
          metadata: true,
          createdAt: true,
          actorUser: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              email: true,
            },
          },
        },
      }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
