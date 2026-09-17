import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { USER } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { AffiliatesService } from '../affiliates/affiliates.service';
import {
  AdminCreatePayoutRequestDto,
  CreatePayoutRequestDto,
} from './dto/create-payout-request.dto';
import {
  AddPayoutNoteDto,
  CancelPayoutRequestDto,
  DecidePayoutRequestDto,
  MarkPayoutPaidDto,
  UpdatePayoutNoteDto,
} from './dto/decide-payout-request.dto';
import { ListPayoutRequestsDto } from './dto/list-payout-requests.dto';
import {
  ADMIN_SELECT,
  PAYOUT_REQUEST_SELECT,
  shapeAdminRequest,
} from './payout-request.selects';
import { AllianceNotificationsService } from '../notifications/notifications.service';
import { BillComPayoutService } from '../bill-com/bill-com-payout.service';
import { BillComService } from '../bill-com/bill-com.service';
import { BillComSessionRequiredException } from '../bill-com/bill-com-session-required.exception';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class PayoutRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly affiliatesService: AffiliatesService,
    private readonly allianceNotifications: AllianceNotificationsService,
    private readonly billComPayoutService: BillComPayoutService,
    private readonly billComService: BillComService,
  ) {}

  // ---------------------------------------------------------------------------
  // Shared audit log helper.
  // ---------------------------------------------------------------------------
  private async writeAuditLog(params: {
    actorUserId: string | null;
    entityId: string;
    event: string;
    oldStatus: string | null;
    newStatus: string | null;
    reason?: string;
    source: 'user' | 'sync' | 'admin_action' | 'cron';
  }) {
    await this.prisma.medAllianceAuditLog.create({
      data: {
        actor_user_id: params.actorUserId,
        entity_type: 'payout_request',
        entity_id: params.entityId,
        event: params.event,
        old_status: params.oldStatus,
        new_status: params.newStatus,
        reason: params.reason ?? null,
        source: params.source,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Shared: reject creation if the affiliate has no Bill.com vendor ID.
  // Mirrors the fallback chain used by BillComPayoutService.validateAndPreparePayment
  // so a request can never be created if it would later fail at payment time.
  // ---------------------------------------------------------------------------
  private validateVendorIdForPayoutCreation(profile: {
    contact?: { hubspot_billcom_vendor_id: string | null } | null;
    user?: {
      contact?: { hubspot_billcom_vendor_id: string | null } | null;
    } | null;
  }): void {
    const vendorId =
      profile.contact?.hubspot_billcom_vendor_id ??
      profile.user?.contact?.hubspot_billcom_vendor_id ??
      null;

    if (!vendorId) {
      throw new BadRequestException(
        'Bill.com vendor ID is missing for this affiliate. Cannot create a payout request until a vendor ID is configured.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Shared: validate that all requested commissions exist and are eligible.
  // ---------------------------------------------------------------------------
  private validateCommissionsEligible(
    commissions: { id: string; status: string }[],
    requestedIds: string[],
  ): void {
    if (commissions.length !== requestedIds.length) {
      throw new BadRequestException(
        'One or more commission IDs were not found',
      );
    }

    const nonEligible = commissions.find((c) => c.status !== 'eligible');
    if (nonEligible) {
      throw new BadRequestException(
        `Commission ${nonEligible.id} is not eligible for payout (status: ${nonEligible.status})`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Affiliate: submit a new payout request.
  // ---------------------------------------------------------------------------
  async create(dto: CreatePayoutRequestDto, currentUser: USER) {
    const activeProfile = await this.affiliatesService.requireActiveProfile(
      currentUser.id,
    );

    const profile = await this.prisma.affiliateProfile.findUniqueOrThrow({
      where: { id: activeProfile.id },
      select: {
        id: true,
        payout_preference_method: true,
        contact: { select: { hubspot_billcom_vendor_id: true } },
        user: {
          select: { contact: { select: { hubspot_billcom_vendor_id: true } } },
        },
      },
    });

    this.validateVendorIdForPayoutCreation(profile);

    const commissions = await this.prisma.affiliateCommission.findMany({
      where: { id: { in: dto.commission_ids } },
      select: {
        id: true,
        affiliate_id: true,
        status: true,
        commission_amount: true,
        organization: { select: { status: true } },
      },
    });

    if (commissions.length !== dto.commission_ids.length) {
      throw new BadRequestException(
        'One or more commission IDs were not found',
      );
    }

    const foreignCommission = commissions.find(
      (c) => c.affiliate_id !== currentUser.id,
    );
    if (foreignCommission) {
      throw new BadRequestException(
        'One or more commissions do not belong to your account',
      );
    }

    // A deleted organization no longer generates payable work — its remaining
    // eligible commissions must go through admin review, never a self-service payout.
    const deletedOrgCommission = commissions.find(
      (c) => c.organization?.status === 'deleted',
    );
    if (deletedOrgCommission) {
      throw new BadRequestException(
        `Commission ${deletedOrgCommission.id} belongs to a deleted organization and cannot be paid out`,
      );
    }

    this.validateCommissionsEligible(commissions, dto.commission_ids);

    const requestedAmount = commissions.reduce(
      (acc, c) => acc.add(new Decimal(c.commission_amount)),
      new Decimal(0),
    );

    const paymentMethod =
      dto.payment_method ?? profile.payout_preference_method ?? null;

    const payoutRequest = await this.prisma.$transaction(async (tx) => {
      const request = await tx.affiliatePayoutRequest.create({
        data: {
          affiliate_id: currentUser.id,
          affiliate_profile_id: profile.id,
          status: 'requested',
          requested_amount: requestedAmount,
          payment_method: paymentMethod,
        },
      });

      await tx.affiliatePayoutRequestCommission.createMany({
        data: dto.commission_ids.map((commissionId) => ({
          payout_request_id: request.id,
          commission_id: commissionId,
        })),
      });

      await tx.affiliateCommission.updateMany({
        where: { id: { in: dto.commission_ids } },
        data: { status: 'requested' },
      });

      return request;
    });

    await this.writeAuditLog({
      actorUserId: currentUser.id,
      entityId: payoutRequest.id,
      event: 'status_changed',
      oldStatus: null,
      newStatus: 'requested',
      source: 'user',
    });

    for (const commissionId of dto.commission_ids) {
      await this.prisma.medAllianceAuditLog.create({
        data: {
          actor_user_id: currentUser.id,
          entity_type: 'commission',
          entity_id: commissionId,
          event: 'status_changed',
          old_status: 'eligible',
          new_status: 'requested',
          source: 'user',
          metadata: { payout_request_id: payoutRequest.id } as any,
        },
      });
    }

    const affiliateName =
      `${currentUser.first_name ?? ''} ${currentUser.last_name ?? ''}`.trim() ||
      currentUser.email;
    void this.allianceNotifications.notifyAdminPayoutRequested({
      affiliateName,
      totalAmount: parseFloat(String(requestedAmount)),
      commissionCount: dto.commission_ids.length,
      payoutRequestId: payoutRequest.id,
    });

    return this.prisma.affiliatePayoutRequest.findUnique({
      where: { id: payoutRequest.id },
      select: PAYOUT_REQUEST_SELECT,
    });
  }

  // ---------------------------------------------------------------------------
  // Admin: create a payout request on behalf of an affiliate.
  // ---------------------------------------------------------------------------
  async createForAdmin(dto: AdminCreatePayoutRequestDto, adminUser: USER) {
    // 1. Resolve affiliate profile
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { id: dto.affiliate_profile_id },
      select: {
        id: true,
        user_id: true,
        payout_preference_method: true,
        contact: { select: { hubspot_billcom_vendor_id: true } },
        user: {
          select: { contact: { select: { hubspot_billcom_vendor_id: true } } },
        },
      },
    });
    if (!profile) {
      throw new NotFoundException(
        `Affiliate profile not found: ${dto.affiliate_profile_id}`,
      );
    }

    this.validateVendorIdForPayoutCreation(profile);

    // 2. Validate commissions exist, belong to that affiliate, and are eligible.
    // Commissions can only exist for a profile with a connected user (their
    // affiliate_id is always the profile's user_id), so a foreign-commission
    // mismatch here also naturally catches a profile with no connected user.
    const commissions = await this.prisma.affiliateCommission.findMany({
      where: { id: { in: dto.commission_ids } },
      select: {
        id: true,
        affiliate_id: true,
        status: true,
        commission_amount: true,
      },
    });

    if (commissions.length !== dto.commission_ids.length) {
      throw new BadRequestException(
        'One or more commission IDs were not found',
      );
    }

    const foreignCommission = commissions.find(
      (c) => c.affiliate_id !== profile.user_id,
    );
    if (foreignCommission) {
      throw new BadRequestException(
        'One or more commissions do not belong to this affiliate',
      );
    }
    // Commission ownership matched profile.user_id, so it must be a non-null string.
    const affiliateUserId: string = profile.user_id as string;

    this.validateCommissionsEligible(commissions, dto.commission_ids);

    // Completeness check. The admin UI historically derived its selection from a
    // capped commission preview, which silently omitted eligible commissions and
    // underpaid the affiliate. When the client states how many eligible
    // commissions it saw, verify that against the real count before paying.
    if (dto.expected_eligible_count !== undefined) {
      const actualEligibleCount = await this.prisma.affiliateCommission.count({
        where: { affiliate_id: affiliateUserId, status: 'eligible' },
      });
      if (actualEligibleCount !== dto.expected_eligible_count) {
        throw new BadRequestException(
          `Eligible commission count mismatch: the request was built from ${dto.expected_eligible_count} commission(s) but this affiliate currently has ${actualEligibleCount}. Reload the affiliate's eligible commissions and try again.`,
        );
      }
    }

    // 3. Sum amounts
    const requestedAmount = commissions.reduce(
      (acc, c) => acc.add(new Decimal(c.commission_amount)),
      new Decimal(0),
    );

    const paymentMethod = profile.payout_preference_method ?? null;

    // 4. Transactional create
    const payoutRequest = await this.prisma.$transaction(async (tx) => {
      const request = await tx.affiliatePayoutRequest.create({
        data: {
          affiliate_id: affiliateUserId,
          affiliate_profile_id: profile.id,
          status: 'requested',
          requested_amount: requestedAmount,
          payment_method: paymentMethod,
        },
      });

      await tx.affiliatePayoutRequestCommission.createMany({
        data: dto.commission_ids.map((commissionId) => ({
          payout_request_id: request.id,
          commission_id: commissionId,
        })),
      });

      await tx.affiliateCommission.updateMany({
        where: { id: { in: dto.commission_ids } },
        data: { status: 'requested' },
      });

      return request;
    });

    // 5. Audit log — source is admin_action, actor is the admin
    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: payoutRequest.id,
      event: 'status_changed',
      oldStatus: null,
      newStatus: 'requested',
      reason: 'Admin-initiated payout request',
      source: 'admin_action',
    });

    for (const commissionId of dto.commission_ids) {
      await this.prisma.medAllianceAuditLog.create({
        data: {
          actor_user_id: adminUser.id,
          entity_type: 'commission',
          entity_id: commissionId,
          event: 'status_changed',
          old_status: 'eligible',
          new_status: 'requested',
          reason: 'Admin-initiated payout request',
          source: 'admin_action',
          metadata: { payout_request_id: payoutRequest.id } as any,
        },
      });
    }

    return this.findOneForAdmin(payoutRequest.id);
  }

  // ---------------------------------------------------------------------------
  // Internal: create a payout request on behalf of an affiliate from a cron job.
  // ---------------------------------------------------------------------------
  async createFromCron(
    affiliateProfileId: string,
    commissionIds: string[],
  ): Promise<{ id: string; requested_amount: Decimal }> {
    const profile = await this.prisma.affiliateProfile.findUnique({
      where: { id: affiliateProfileId },
      select: {
        id: true,
        user_id: true,
        payout_preference_method: true,
        contact: { select: { hubspot_billcom_vendor_id: true } },
        user: {
          select: { contact: { select: { hubspot_billcom_vendor_id: true } } },
        },
      },
    });
    if (!profile) {
      throw new NotFoundException(
        `Affiliate profile not found: ${affiliateProfileId}`,
      );
    }

    this.validateVendorIdForPayoutCreation(profile);

    // Commissions can only exist for a profile with a connected user (their
    // affiliate_id is always the profile's user_id), so a foreign-commission
    // mismatch here also naturally catches a profile with no connected user.
    const commissions = await this.prisma.affiliateCommission.findMany({
      where: { id: { in: commissionIds } },
      select: {
        id: true,
        affiliate_id: true,
        status: true,
        commission_amount: true,
      },
    });

    if (commissions.length !== commissionIds.length) {
      throw new BadRequestException(
        'One or more commission IDs were not found',
      );
    }

    const foreignCommission = commissions.find(
      (c) => c.affiliate_id !== profile.user_id,
    );
    if (foreignCommission) {
      throw new BadRequestException(
        'One or more commissions do not belong to this affiliate',
      );
    }
    // Commission ownership matched profile.user_id, so it must be a non-null string.
    const affiliateUserId: string = profile.user_id as string;

    this.validateCommissionsEligible(commissions, commissionIds);

    const requestedAmount = commissions.reduce(
      (acc, c) => acc.add(new Decimal(c.commission_amount)),
      new Decimal(0),
    );

    const payoutRequest = await this.prisma.$transaction(async (tx) => {
      const request = await tx.affiliatePayoutRequest.create({
        data: {
          affiliate_id: affiliateUserId,
          affiliate_profile_id: profile.id,
          status: 'requested',
          requested_amount: requestedAmount,
          payment_method: profile.payout_preference_method ?? null,
        },
      });

      await tx.affiliatePayoutRequestCommission.createMany({
        data: commissionIds.map((commissionId) => ({
          payout_request_id: request.id,
          commission_id: commissionId,
        })),
      });

      await tx.affiliateCommission.updateMany({
        where: { id: { in: commissionIds } },
        data: { status: 'requested' },
      });

      return request;
    });

    await this.writeAuditLog({
      actorUserId: null,
      entityId: payoutRequest.id,
      event: 'status_changed',
      oldStatus: null,
      newStatus: 'requested',
      reason: 'Automated quarterly payout request',
      source: 'cron',
    });

    for (const commissionId of commissionIds) {
      await this.prisma.medAllianceAuditLog.create({
        data: {
          actor_user_id: null,
          entity_type: 'commission',
          entity_id: commissionId,
          event: 'status_changed',
          old_status: 'eligible',
          new_status: 'requested',
          reason: 'Automated quarterly payout request',
          source: 'cron',
          metadata: { payout_request_id: payoutRequest.id } as any,
        },
      });
    }

    return { id: payoutRequest.id, requested_amount: requestedAmount };
  }

  // ---------------------------------------------------------------------------
  // Affiliate: list own payout requests.
  // ---------------------------------------------------------------------------
  async findAllForAffiliate(dto: ListPayoutRequestsDto, currentUser: USER) {
    const {
      page = 1,
      limit = 20,
      status,
      payment_method,
      amount_min,
      amount_max,
      created_from,
      created_to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = dto;
    const skip = (page - 1) * limit;

    const where: any = { affiliate_id: currentUser.id };
    if (status) where.status = status;
    if (payment_method) where.payment_method = payment_method;
    if (amount_min !== undefined || amount_max !== undefined) {
      where.requested_amount = {};
      // Guard against NaN reaching Prisma: `new Decimal(NaN)` builds silently
      // instead of throwing, and Prisma's query engine rejects a NaN Decimal
      // argument with an unhandled PrismaClientUnknownRequestError.
      if (amount_min !== undefined && Number.isFinite(amount_min))
        where.requested_amount.gte = amount_min;
      if (amount_max !== undefined && Number.isFinite(amount_max))
        where.requested_amount.lte = amount_max;
    }
    if (created_from || created_to) {
      where.createdAt = {};
      if (created_from) where.createdAt.gte = new Date(created_from);
      if (created_to) where.createdAt.lte = new Date(created_to);
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.affiliatePayoutRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: PAYOUT_REQUEST_SELECT,
      }),
      this.prisma.affiliatePayoutRequest.count({ where }),
    ]);

    return { data, pagination: { page, limit, total } };
  }

  // ---------------------------------------------------------------------------
  // Affiliate: get one payout request — scoped.
  // ---------------------------------------------------------------------------
  async findOneForAffiliate(id: string, currentUser: USER) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: { ...PAYOUT_REQUEST_SELECT, affiliate_id: true },
    });
    if (!request) throw new NotFoundException('Payout request not found');
    if (request.affiliate_id !== currentUser.id) {
      throw new NotFoundException('Payout request not found');
    }
    return request;
  }

  // ---------------------------------------------------------------------------
  // Admin: list all payout requests with filters (B6).
  // ---------------------------------------------------------------------------
  async findAllForAdmin(dto: ListPayoutRequestsDto) {
    const {
      page = 1,
      limit = 20,
      status,
      affiliate_id,
      search,
      risk_flag,
      amount_min,
      amount_max,
      created_from,
      created_to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (affiliate_id) where.affiliate_id = affiliate_id;
    if (created_from || created_to) {
      where.createdAt = {};
      if (created_from) where.createdAt.gte = new Date(created_from);
      if (created_to) where.createdAt.lte = new Date(created_to);
    }
    // B6: amount range filter
    if (amount_min !== undefined || amount_max !== undefined) {
      where.requested_amount = {};
      // Guard against NaN reaching Prisma: `new Decimal(NaN)` builds silently
      // instead of throwing, and Prisma's query engine rejects a NaN Decimal
      // argument with an unhandled PrismaClientUnknownRequestError.
      if (amount_min !== undefined && Number.isFinite(amount_min))
        where.requested_amount.gte = new Decimal(amount_min);
      if (amount_max !== undefined && Number.isFinite(amount_max))
        where.requested_amount.lte = new Decimal(amount_max);
    }
    // B6: full-text search on affiliate name/email, or by an included commission's id / invoice number
    if (search) {
      where.OR = [
        {
          affiliate: {
            OR: [
              { first_name: { contains: search, mode: 'insensitive' } },
              { last_name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
        {
          commissions: {
            some: {
              commission: {
                OR: [
                  { id: { contains: search, mode: 'insensitive' } },
                  {
                    hubspotInvoiceSnapshot: {
                      OR: [
                        {
                          invoice_number: {
                            contains: search,
                            mode: 'insensitive',
                          },
                        },
                        {
                          hubspot_id: { contains: search, mode: 'insensitive' },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.affiliatePayoutRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: ADMIN_SELECT,
      }),
      this.prisma.affiliatePayoutRequest.count({ where }),
    ]);

    // B4: build set of affiliate_ids with multiple active requested requests (duplicate risk)
    const affiliateIds = rows.map((r: any) => r.affiliate_id);
    const duplicateSet = new Set(
      affiliateIds.filter(
        (id: string, i: number) => affiliateIds.indexOf(id) !== i,
      ),
    );

    let data = rows.map((r: any) => shapeAdminRequest(r, duplicateSet));

    // B6: post-filter risk_flag (computed field — can't filter in SQL)
    if (risk_flag === 'duplicate')
      data = data.filter((r: any) => r.has_duplicate_risk);
    if (risk_flag === 'missing_banking')
      data = data.filter((r: any) => r.has_missing_banking);
    if (risk_flag === 'aging') data = data.filter((r: any) => r.is_aging);

    return {
      data,
      pagination: { page, limit, total: risk_flag ? data.length : total },
    };
  }

  // ---------------------------------------------------------------------------
  // Admin: get one payout request with full details.
  // ---------------------------------------------------------------------------
  async findOneForAdmin(id: string) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: ADMIN_SELECT,
    });
    if (!request) throw new NotFoundException('Payout request not found');
    return shapeAdminRequest(request);
  }

  // ---------------------------------------------------------------------------
  // B1: Admin: move a payout request from "requested" to "under_review".
  // ---------------------------------------------------------------------------
  async startReview(id: string, adminUser: USER) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    if (request.status !== 'requested') {
      throw new BadRequestException(
        `Payout request is in status "${request.status}". Only "requested" requests can be moved to under review.`,
      );
    }

    await this.prisma.affiliatePayoutRequest.update({
      where: { id },
      data: {
        status: 'under_review',
        reviewed_by: adminUser.id,
        reviewed_at: new Date(),
      },
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'status_changed',
      oldStatus: 'requested',
      newStatus: 'under_review',
      source: 'admin_action',
    });

    return this.findOneForAdmin(id);
  }

  // ---------------------------------------------------------------------------
  // Admin: approve or reject a payout request.
  // Allowed from: "requested" or "under_review".
  // ---------------------------------------------------------------------------
  async decide(id: string, dto: DecidePayoutRequestDto, adminUser: USER) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        requested_amount: true,
        commissions: { select: { commission_id: true } },
      },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const decidableStatuses = ['requested', 'under_review'];
    if (!decidableStatuses.includes(request.status)) {
      throw new BadRequestException(
        `Payout request is in status "${request.status}". Only "requested" or "under_review" requests can be decided.`,
      );
    }

    const newStatus = dto.decision === 'approved' ? 'approved' : 'rejected';
    const commissionIds = request.commissions.map((c) => c.commission_id);

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliatePayoutRequest.update({
        where: { id },
        data: {
          status: newStatus,
          approved_amount:
            dto.decision === 'approved'
              ? (dto.approved_amount ?? request.requested_amount)
              : null,
          approved_by: adminUser.id,
          approved_at: new Date(),
          rejection_reason:
            dto.decision === 'rejected' ? dto.rejection_reason : null,
        },
      });

      if (dto.decision === 'rejected') {
        await tx.affiliateCommission.updateMany({
          where: { id: { in: commissionIds } },
          data: { status: 'rejected' },
        });
      }
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'admin_decision',
      oldStatus: request.status,
      newStatus,
      reason: dto.rejection_reason,
      source: 'admin_action',
    });

    if (dto.decision === 'rejected') {
      for (const commissionId of commissionIds) {
        await this.prisma.medAllianceAuditLog.create({
          data: {
            actor_user_id: adminUser.id,
            entity_type: 'commission',
            entity_id: commissionId,
            event: 'status_changed',
            old_status: 'requested',
            new_status: 'rejected',
            reason: 'Payout request rejected',
            source: 'admin_action',
            metadata: { payout_request_id: id } as any,
          },
        });
      }
    }

    return this.findOneForAdmin(id);
  }

  // ---------------------------------------------------------------------------
  // B2: Admin: mark a payout request as paid.
  // Allowed from: "under_review" or "approved" (legacy).
  // ---------------------------------------------------------------------------
  async markPaid(id: string, dto: MarkPayoutPaidDto, adminUser: USER) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        approved_amount: true,
        requested_amount: true,
        commissions: { select: { commission_id: true } },
        affiliate: { select: { email: true, first_name: true } },
      },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const payableStatuses = ['under_review', 'approved'];
    if (!payableStatuses.includes(request.status)) {
      throw new BadRequestException(
        `Payout request must be "under_review" or "approved" before marking as paid (current: "${request.status}").`,
      );
    }

    const paidAmount =
      dto.paid_amount ??
      parseFloat(
        String(request.approved_amount ?? request.requested_amount ?? 0),
      );

    const commissionIds = request.commissions.map((c) => c.commission_id);
    const adminName =
      `${adminUser.first_name ?? ''} ${adminUser.last_name ?? ''}`.trim();
    const affiliateName = request.affiliate?.first_name ?? undefined;

    // Phase 0: fail fast if this admin has no valid Bill.com session yet —
    // before any Bill.com validation or DB work runs.
    const hasSession = await this.billComService.hasValidSession(adminUser.id);
    if (!hasSession) {
      throw new BillComSessionRequiredException();
    }

    // Phase 1: validate Bill.com prerequisites (vendor ID, commissions) — no DB writes yet
    let billPayload: Awaited<
      ReturnType<typeof this.billComPayoutService.validateAndPreparePayment>
    >;
    try {
      billPayload =
        await this.billComPayoutService.validateAndPreparePayment(id);
    } catch (error) {
      void this.allianceNotifications.notifyAdminMarkPaidError({
        payoutRequestId: id,
        adminName,
        errorPhase: 'Bill.com validation',
        errorMessage: error instanceof Error ? error.message : String(error),
        affiliateName,
        amount: paidAmount,
      });
      throw error;
    }

    // Phase 2: call external API — if this fails, nothing has been written to the DB
    let billAndPaymentResult: Awaited<
      ReturnType<
        typeof this.billComPayoutService.createBillAndPaymentForMarkPaid
      >
    >;
    try {
      billAndPaymentResult =
        await this.billComPayoutService.createBillAndPaymentForMarkPaid(
          billPayload,
          adminUser,
          id,
        );
    } catch (error) {
      void this.allianceNotifications.notifyAdminMarkPaidError({
        payoutRequestId: id,
        adminName,
        errorPhase: 'Bill.com API',
        errorMessage: error instanceof Error ? error.message : String(error),
        affiliateName,
        amount: paidAmount,
      });
      throw new InternalServerErrorException(
        'Failed to create Bill.com payment. Our team has been notified. Please try again or contact support.',
      );
    }

    // Phase 3: single atomic transaction — only reached after Bill.com confirms success
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.affiliatePayoutRequest.update({
          where: { id },
          data: {
            status: 'processing',
            paid_amount: new Decimal(paidAmount),
            payment_proof_notes: dto.payment_proof_notes ?? null,
            approved_by:
              request.status === 'under_review' ? adminUser.id : undefined,
            approved_at:
              request.status === 'under_review' ? new Date() : undefined,
            bill_com_billId: billAndPaymentResult.billId,
            bill_com_paymentStatus: billAndPaymentResult.status,
            bill_com_payment_id: billAndPaymentResult.confirmationNumber,
            bill_com_status: billAndPaymentResult.status,
            bill_com_error: null,
            payment_method: 'bill_com',
            transaction_reference: billAndPaymentResult.transactionNumber,
          },
        });

        await tx.affiliateCommission.updateMany({
          where: { id: { in: commissionIds } },
          data: { status: 'paid' },
        });

        await tx.medAllianceAuditLog.create({
          data: {
            actor_user_id: adminUser.id,
            entity_type: 'payout_request',
            entity_id: id,
            event: 'bill_com_payment_initiated',
            old_status: request.status,
            new_status: 'processing',
            source: 'admin_action',
          },
        });

        if (commissionIds.length > 0) {
          await tx.medAllianceAuditLog.createMany({
            data: commissionIds.map((commissionId) => ({
              actor_user_id: adminUser.id,
              entity_type: 'commission',
              entity_id: commissionId,
              event: 'status_changed',
              old_status: 'requested',
              new_status: 'paid',
              source: 'admin_action',
              metadata: { payout_request_id: id } as any,
            })),
          });
        }
      });
    } catch (error) {
      void this.allianceNotifications.notifyAdminMarkPaidError({
        payoutRequestId: id,
        adminName,
        errorPhase: 'Database transaction',
        errorMessage: error instanceof Error ? error.message : String(error),
        affiliateName,
        amount: paidAmount,
        billComBillId: billAndPaymentResult.billId,
      });
      throw new InternalServerErrorException(
        `Payment was submitted to Bill.com but could not be saved (Bill ID: ${billAndPaymentResult.billId}). Our team has been notified.`,
      );
    }

    if (request.affiliate?.email) {
      void this.allianceNotifications.notifyPayoutProcessing(
        {
          email: request.affiliate.email,
          first_name: request.affiliate.first_name ?? '',
        },
        {
          totalAmount: paidAmount,
          processedAt: new Date(),
        },
      );
    }

    return this.findOneForAdmin(id);
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Admin: cancel a payout request.
  // Allowed from: "requested" or "under_review".
  // Reverts linked commissions from "requested" → "eligible".
  // Idempotent: if already cancelled, returns the request without error.
  // ---------------------------------------------------------------------------
  async cancelPayoutRequest(
    id: string,
    dto: CancelPayoutRequestDto,
    adminUser: USER,
  ) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        requested_amount: true,
        commissions: { select: { commission_id: true } },
        affiliate: { select: { email: true, first_name: true } },
      },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    if (request.status === 'cancelled') {
      return this.findOneForAdmin(id);
    }

    const cancellableStatuses = ['requested', 'under_review'];
    if (!cancellableStatuses.includes(request.status)) {
      throw new BadRequestException(
        `Payout request is in status "${request.status}". Only "requested" or "under_review" requests can be cancelled.`,
      );
    }

    const commissionIds = request.commissions.map((c) => c.commission_id);
    const oldStatus = request.status;

    await this.prisma.$transaction(async (tx) => {
      await tx.affiliatePayoutRequest.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancellation_reason: dto.reason ?? null,
          cancelled_by: adminUser.id,
          cancelled_at: new Date(),
        },
      });

      if (commissionIds.length > 0) {
        await tx.affiliateCommission.updateMany({
          where: { id: { in: commissionIds } },
          data: { status: 'eligible' },
        });
      }
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'status_changed',
      oldStatus,
      newStatus: 'cancelled',
      reason: dto.reason,
      source: 'admin_action',
    });

    for (const commissionId of commissionIds) {
      await this.prisma.medAllianceAuditLog.create({
        data: {
          actor_user_id: adminUser.id,
          entity_type: 'commission',
          entity_id: commissionId,
          event: 'status_changed',
          old_status: 'requested',
          new_status: 'eligible',
          reason: 'Payout request cancelled',
          source: 'admin_action',
          metadata: { payout_request_id: id } as any,
        },
      });
    }

    if (request.affiliate) {
      void this.allianceNotifications.notifyPayoutCancelled(
        {
          email: request.affiliate.email,
          first_name: request.affiliate.first_name ?? '',
        },
        {
          totalAmount: Number(request.requested_amount),
          cancellationReason: dto.reason ?? undefined,
        },
      );
    }

    return this.findOneForAdmin(id);
  }

  // ---------------------------------------------------------------------------
  // Admin: reopen a payout request to a previous status.
  // Transitions supported:
  //   under_review → requested
  //   rejected     → requested
  //   rejected     → under_review
  // When reopening from "rejected", linked commissions are reverted to "requested".
  // ---------------------------------------------------------------------------
  async reopen(
    id: string,
    targetStatus: 'requested' | 'under_review',
    adminUser: USER,
  ) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        commissions: { select: { commission_id: true } },
      },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const validSources: Record<'requested' | 'under_review', string[]> = {
      requested: ['under_review', 'rejected'],
      under_review: ['rejected'],
    };

    if (!validSources[targetStatus].includes(request.status)) {
      throw new BadRequestException(
        `Cannot reopen from "${request.status}" to "${targetStatus}".`,
      );
    }

    const oldStatus = request.status;
    const commissionIds = request.commissions.map((c) => c.commission_id);

    await this.prisma.$transaction(async (tx) => {
      const updateData: Record<string, unknown> = { status: targetStatus };

      if (oldStatus === 'under_review') {
        updateData.reviewed_by = null;
        updateData.reviewed_at = null;
      }

      if (oldStatus === 'rejected') {
        updateData.rejection_reason = null;
        if (commissionIds.length > 0) {
          await tx.affiliateCommission.updateMany({
            where: { id: { in: commissionIds } },
            data: { status: 'requested' },
          });
        }
      }

      await tx.affiliatePayoutRequest.update({
        where: { id },
        data: updateData,
      });
    });

    await this.writeAuditLog({
      actorUserId: adminUser.id,
      entityId: id,
      event: 'status_changed',
      oldStatus,
      newStatus: targetStatus,
      source: 'admin_action',
    });

    return this.findOneForAdmin(id);
  }

  // B3: Admin: add a note to a payout request.
  // ---------------------------------------------------------------------------
  async addNote(id: string, dto: AddPayoutNoteDto, adminUser: USER) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const note = await this.prisma.payoutRequestNote.create({
      data: {
        payout_request_id: id,
        author_user_id: adminUser.id,
        type: dto.type,
        content: dto.content,
      },
      select: {
        id: true,
        type: true,
        content: true,
        createdAt: true,
        author: {
          select: { id: true, first_name: true, last_name: true },
        },
      },
    });

    return {
      ...note,
      author: note.author
        ? `${note.author.first_name} ${note.author.last_name}`.trim()
        : 'Admin',
      created_at: note.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // B3: Admin: list notes for a payout request.
  // ---------------------------------------------------------------------------
  async getNotes(id: string) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const notes = await this.prisma.payoutRequestNote.findMany({
      where: { payout_request_id: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        content: true,
        createdAt: true,
        author: {
          select: { id: true, first_name: true, last_name: true },
        },
      },
    });

    return notes.map((n) => ({
      id: n.id,
      type: n.type,
      content: n.content,
      created_at: n.createdAt,
      author: n.author
        ? `${n.author.first_name} ${n.author.last_name}`.trim()
        : 'Admin',
    }));
  }

  // ---------------------------------------------------------------------------
  // B3: Affiliate: list notes for a payout request.
  // ---------------------------------------------------------------------------
  async getNotesForAffiliates(id: string) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const notes = await this.prisma.payoutRequestNote.findMany({
      where: { payout_request_id: id, type: 'user' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        content: true,
        createdAt: true,
        author: {
          select: { id: true, first_name: true, last_name: true },
        },
      },
    });

    return notes.map((n) => ({
      id: n.id,
      type: n.type,
      content: n.content,
      created_at: n.createdAt,
      author: n.author
        ? `${n.author.first_name} ${n.author.last_name}`.trim()
        : 'Admin',
    }));
  }

  // ---------------------------------------------------------------------------
  // Admin: update the content of a payout request note.
  // ---------------------------------------------------------------------------
  async updateNote(
    payoutRequestId: string,
    noteId: string,
    dto: UpdatePayoutNoteDto,
  ) {
    const note = await this.prisma.payoutRequestNote.findFirst({
      where: { id: noteId, payout_request_id: payoutRequestId },
    });
    if (!note) throw new NotFoundException('Note not found');

    const updated = await this.prisma.payoutRequestNote.update({
      where: { id: noteId },
      data: { content: dto.content },
      select: {
        id: true,
        type: true,
        content: true,
        createdAt: true,
        author: {
          select: { id: true, first_name: true, last_name: true },
        },
      },
    });

    return {
      ...updated,
      author: updated.author
        ? `${updated.author.first_name} ${updated.author.last_name}`.trim()
        : 'Admin',
      created_at: updated.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Admin: delete a payout request note.
  // ---------------------------------------------------------------------------
  async deleteNote(payoutRequestId: string, noteId: string) {
    const note = await this.prisma.payoutRequestNote.findFirst({
      where: { id: noteId, payout_request_id: payoutRequestId },
    });
    if (!note) throw new NotFoundException('Note not found');

    await this.prisma.payoutRequestNote.delete({ where: { id: noteId } });
  }

  // ---------------------------------------------------------------------------
  // Admin: audit log timeline for a payout request.
  // ---------------------------------------------------------------------------
  async getAuditLog(id: string) {
    const request = await this.prisma.affiliatePayoutRequest.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!request) throw new NotFoundException('Payout request not found');

    const entries = await this.prisma.medAllianceAuditLog.findMany({
      where: { entity_type: 'payout_request', entity_id: id },
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

    return entries.map((e) => ({
      id: e.id,
      action: this.resolveAuditAction(e.event, e.old_status, e.new_status),
      actor: e.actorUser
        ? `${e.actorUser.first_name} ${e.actorUser.last_name}`.trim()
        : 'System',
      timestamp: e.createdAt,
      notes: e.reason ?? undefined,
      // Frontend Activity timeline renders a from → to status pill pair.
      from_status: e.old_status,
      to_status: e.new_status,
      // Legacy aliases kept for backward compatibility with existing consumers.
      old_status: e.old_status,
      new_status: e.new_status,
    }));
  }

  // ---------------------------------------------------------------------------
  // Derive a descriptive, title-caseable action for the timeline.
  // Historically most transitions were stored with the generic event
  // "status_changed"; here we upgrade those to a status-specific action so the
  // frontend can render a meaningful title. Already-descriptive events
  // (e.g. bill_com_payment_initiated) are passed through untouched.
  // ---------------------------------------------------------------------------
  private resolveAuditAction(
    event: string,
    oldStatus: string | null,
    newStatus: string | null,
  ): string {
    const genericEvents = new Set(['status_changed', 'admin_decision']);
    if (!genericEvents.has(event)) return event;

    switch (newStatus) {
      case 'requested':
        return oldStatus === null ? 'request_submitted' : 'request_reopened';
      case 'under_review':
        return 'review_started';
      case 'approved':
        return 'request_approved';
      case 'rejected':
        return 'request_rejected';
      case 'processing':
        return 'payment_processing';
      case 'paid':
        return 'payment_completed';
      case 'cancelled':
        return 'request_cancelled';
      case 'failed':
        return 'payment_failed';
      default:
        return event;
    }
  }

  // ---------------------------------------------------------------------------
  // B7: Admin: status counters for the kanban board header.
  // ---------------------------------------------------------------------------
  async getStatusCounts() {
    const counts = await this.prisma.affiliatePayoutRequest.groupBy({
      by: ['status'],
      _count: { id: true },
    });

    const result: Record<string, number> = {
      requested: 0,
      under_review: 0,
      approved: 0,
      paid: 0,
      rejected: 0,
      cancelled: 0,
      processing: 0,
      failed: 0,
    };

    for (const row of counts) {
      result[row.status] = row._count.id;
    }

    return result;
  }
}
