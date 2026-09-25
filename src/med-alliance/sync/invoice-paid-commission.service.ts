import { Injectable } from '@nestjs/common';
import { CommissionStatus, InvoiceSource, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildCommissionIdempotencyKey,
  resolveInvoiceIdempotencyRef,
} from '../../common/utils/commission-idempotency';
import {
  computeLineItemCommissionEligibility,
  resolveCommissionAnchorDate,
  resolveStaffCommissionStartDate,
} from '../shared/commission-eligibility.util';

/**
 * The real-time "invoice became paid" half of the Med Alliance flow, shared by both billing
 * sources: the HubSpot invoice webhook (HandlerInvoicePropertyChange / HandlerComissionCreation)
 * and our own Stripe/Hubstaff invoices (InternalInvoiceSnapshotService). Both sources must go
 * through this exact code so their commissions follow the same approved rules.
 */
@Injectable()
export class InvoicePaidCommissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates one commission per matched line item of a paid invoice snapshot, using the same
   * shared eligibility helper CommissionDetectionService uses, so both paths stay in sync.
   *
   * `invoiceLabel` is only used in log lines (HubSpot id or internal invoice id).
   */
  async createCommissionsForPaidSnapshot(
    where: Prisma.HubspotInvoiceSnapshotWhereUniqueInput,
    invoiceLabel: string,
  ): Promise<true | undefined> {
    const invoiceExists = await this.prisma.hubspotInvoiceSnapshot.findUnique({
      where,
      select: {
        id: true,
        source: true,
        hubspot_id: true,
        internal_invoice_id: true,
        invoice_amount: true,
        paid_at: true,
        due_date: true,
        lineItems: {
          where: {
            match_status: 'matched',
            staff_id: { not: null },
            removed_at: null,
          },
          select: {
            id: true,
            amount: true,
            staff_id: true,
            staff: {
              select: {
                id: true,
                hubspot_id: true,
                hubspot_commission_start_date: true,
              },
            },
          },
        },
        organization: {
          select: {
            id: true,
            med_alliance_referral_status: true,
            eligibility_start_at: true,
            referredByAffiliate: {
              //user
              select: {
                id: true,
                first_name: true,
                last_name: true,
                affiliateProfile: {
                  select: {
                    id: true,
                    full_name: true,
                    commission_percent_default: true,
                    status: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (
      invoiceExists?.organization?.referredByAffiliate?.affiliateProfile
        ?.status !== 'active'
    ) {
      console.log(
        `The affiliate linked to the organization of the invoice with Hubspot ID ${invoiceLabel} is not active. No comission will be created.`,
      );
      return;
    }
    if (
      invoiceExists?.invoice_amount === null ||
      invoiceExists.invoice_amount === undefined
    ) {
      console.log(
        `The invoice with Hubspot ID ${invoiceLabel} has no amount billed. No commission will be created.`,
      );
      return;
    }

    // Credit lines (manual_credit, reconciliation_credit) exist only on internal invoices and
    // must never produce a negative commission. HubSpot keeps its original behavior untouched.
    const source = invoiceExists.source ?? InvoiceSource.hubspot;
    const lineItems =
      source === InvoiceSource.internal
        ? invoiceExists.lineItems.filter((li) => Number(li.amount ?? 0) > 0)
        : invoiceExists.lineItems;

    // Unmatched line items already have an open review case from StaffMatchingService —
    // simply skipped here, not silently dropped. Matched-but-not-yet-linked line items
    // will be picked up on a future call once resolved (admin manual link or next sync).
    if (lineItems.length === 0) {
      console.log(
        `Invoice ${invoiceLabel} has no matched line items yet. No commission will be created on this pass.`,
      );
      return;
    }

    const affiliateId = invoiceExists.organization.referredByAffiliate.id;
    const affiliateProfileId =
      invoiceExists.organization.referredByAffiliate.affiliateProfile.id;
    const commissionPercent =
      invoiceExists.organization.referredByAffiliate.affiliateProfile
        .commission_percent_default;

    // isEligibleNow gates commission STATUS at creation time (detected vs
    // pending_admin_confirmation) — this is the company-level eligibility decision
    // (Confirm/Block), unrelated to the per-collaborator 365-day window computed below.
    const isEligibleNow =
      invoiceExists.organization.med_alliance_referral_status === 'eligible';
    const commissionStatus = isEligibleNow
      ? CommissionStatus.pending_admin_confirmation
      : CommissionStatus.detected;

    const anchorDate = resolveCommissionAnchorDate(invoiceExists);

    for (const lineItem of lineItems) {
      const staffCommissionStartDate = await resolveStaffCommissionStartDate(
        this.prisma,
        lineItem.staff,
      );
      const eligibility = computeLineItemCommissionEligibility({
        lineItemAmount: lineItem.amount ?? 0,
        staffStartDate: staffCommissionStartDate,
        commissionPercent,
        now: anchorDate,
      });

      if (!eligibility.eligible) {
        // 365-day skips are logged by CommissionDetectionService's periodic pass — this
        // real-time path fires far more often and would flood the audit log if it logged
        // every skip too, so it stays silent and lets the sync pass be the audit source.
        continue;
      }

      const idempotencyKey = buildCommissionIdempotencyKey({
        affiliateId,
        hubspotInvoiceId: resolveInvoiceIdempotencyRef(invoiceExists),
        hubspotLineItemId: lineItem.id,
      });

      try {
        await this.prisma.affiliateCommission.upsert({
          where: { idempotency_key: idempotencyKey },
          update: {}, // dont update anything if the record already exists
          create: {
            idempotency_key: idempotencyKey,
            affiliate_id: affiliateId,
            affiliate_profile_id: affiliateProfileId,
            organization_id: invoiceExists.organization.id,
            hubspot_invoice_snapshot_id: invoiceExists.id,
            hubspot_line_item_snapshot_id: lineItem.id,
            staff_id: lineItem.staff_id,
            commission_percent_snapshot: commissionPercent,
            base_amount_snapshot: lineItem.amount ?? 0,
            commission_amount: eligibility.commissionAmount!,
            status: commissionStatus,
            source,
          },
        });
      } catch (err: any) {
        // One line item's failure must not block the other collaborators'
        // commissions on the same invoice from being created.
        console.error(
          `❌ Error creating commission for line item ${lineItem.id} (invoice ${invoiceLabel}): ${err?.message ?? err}`,
        );
      }
    }

    return true;
  }

  /**
   * Marks a referred organization as "deployed" when its first paid invoice is detected.
   *
   * This helper intentionally does NOT touch med_alliance_referral_status — Confirm/Block
   * eligibility decisions become available to admins immediately once deployed, there is no
   * waiting period. Callers run this before commission creation so the first commission
   * follows the expected "detected" status until an admin confirms eligibility.
   */
  async markOrganizationDeployedFromFirstPaidInvoice(params: {
    organizationId: string;
    firstInvoiceDate: Date;
    hubspotInvoiceId?: string;
    internalInvoiceId?: string;
  }): Promise<boolean> {
    const org = await this.prisma.organization.findUnique({
      where: { id: params.organizationId },
      select: {
        id: true,
        referred_by_affiliate_id: true,
        med_alliance_referral_status: true,
        med_alliance_block_reason: true,
        first_paid_invoice_at: true,
        referral_stage: true,
      },
    });

    if (!org) {
      console.log(
        `Organization ${params.organizationId} not found. Cannot mark as deployed.`,
      );
      return false;
    }

    // Only referred organizations participate in the Med Alliance lifecycle.
    if (!org.referred_by_affiliate_id) {
      console.log(
        `Organization ${org.id} has no referred affiliate. Skipping deployed transition.`,
      );
      return false;
    }

    // Active-client blocks are permanent for commission detection and must not be cleared here.
    if (org.med_alliance_block_reason?.startsWith('active_client_block')) {
      console.log(
        `Organization ${org.id} has an active-client block. Skipping deployed transition.`,
      );
      return false;
    }

    // Idempotency guard: once the first paid invoice was recorded, retries must not restart the clock.
    if (org.first_paid_invoice_at) {
      console.log(
        `Organization ${org.id} already has first_paid_invoice_at. Skipping deployed transition.`,
      );
      return false;
    }

    // Canceled organizations should never be moved back into deployed by an invoice webhook.
    if (org.referral_stage === 'canceled') {
      console.log(
        `Organization ${org.id} is canceled. Skipping deployed transition.`,
      );
      return false;
    }

    if (org.referral_stage === 'deployed') {
      console.log(
        `Organization ${org.id} is already deployed. Skipping deployed transition.`,
      );
      return false;
    }

    const eligibilityStartAt = params.firstInvoiceDate;

    return this.prisma.$transaction(async (tx) => {
      const updateResult = await tx.organization.updateMany({
        where: {
          id: org.id,
          referred_by_affiliate_id: { not: null },
          first_paid_invoice_at: null,
          referral_stage: { notIn: ['deployed', 'canceled'] },
          OR: [
            { med_alliance_block_reason: null },
            {
              NOT: {
                med_alliance_block_reason: {
                  startsWith: 'active_client_block',
                },
              },
            },
          ],
        },
        data: {
          referral_stage: 'deployed',
          eligibility_start_at: eligibilityStartAt,
          first_paid_invoice_at: params.firstInvoiceDate,
          med_alliance_block_reason: null,
          // med_alliance_referral_status intentionally stays as-is — Confirm/Block are
          // available to admins immediately once deployed, no waiting period.
        },
      });

      if (updateResult.count === 0) {
        console.log(
          `Organization ${org.id} was not updated to deployed. It may have been changed by another process.`,
        );
        return false;
      }

      await tx.medAllianceAuditLog.create({
        data: {
          entity_type: 'referred_company',
          entity_id: org.id,
          event: 'stage_changed',
          old_status: org.med_alliance_referral_status,
          new_status: org.med_alliance_referral_status,
          reason:
            'First paid invoice - auto-transitioned to deployed stage; eligibility decisions now available',
          source: 'sync',
          actor_user_id: null,
          metadata: {
            referral_stage: 'deployed',
            previous_referral_stage: org.referral_stage,
            eligibility_start_at: eligibilityStartAt.toISOString(),
            first_paid_invoice_at: params.firstInvoiceDate.toISOString(),
            hubspot_invoice_id: params.hubspotInvoiceId ?? null,
            ...(params.internalInvoiceId
              ? { internal_invoice_id: params.internalInvoiceId }
              : {}),
          } as any,
        },
      });

      console.log(
        `Organization ${org.id} transitioned to deployed after first paid invoice.`,
      );
      return true;
    });
  }
}
