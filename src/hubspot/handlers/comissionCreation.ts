import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CommissionStatus } from '@prisma/client';
import { buildCommissionIdempotencyKey } from '../../common/utils/commission-idempotency';
import { computeLineItemCommissionEligibility } from '../../med-alliance/shared/commission-eligibility.util';

@Injectable()
export class HandlerComissionCreation {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called by HandlerInvoicePropertyChange when hs_invoice_status transitions to 'paid'.
   * This is the live, real-time commission-creation path — invoices normally reach "paid"
   * via this webhook, so it may fire more often in practice than the periodic sync
   * (CommissionDetectionService). Rewritten to per-collaborator commission (one per
   * matched HubspotLineItemSnapshot, not one for the whole invoice) using the same
   * shared eligibility helper CommissionDetectionService uses, so both paths stay in sync.
   */
  async execute(event) {
    try {
      const invoiceExists = await this.prisma.hubspotInvoiceSnapshot.findUnique(
        {
          where: {
            hubspot_id: String(event.objectId),
          },
          select: {
            id: true,
            hubspot_id: true,
            invoice_amount: true,
            paid_at: true,
            lineItems: {
              where: { match_status: 'matched', staff_id: { not: null } },
              select: {
                id: true,
                amount: true,
                staff_id: true,
                staff: { select: { id: true, start_date: true } },
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
        },
      );

      if (
        invoiceExists?.organization?.referredByAffiliate?.affiliateProfile
          ?.status !== 'active'
      ) {
        console.log(
          `The affiliate linked to the organization of the invoice with Hubspot ID ${event.objectId} is not active. No comission will be created.`,
        );
        return;
      }
      if (
        invoiceExists?.invoice_amount === null ||
        invoiceExists.invoice_amount === undefined
      ) {
        console.log(
          `The invoice with Hubspot ID ${event.objectId} has no amount billed. No commission will be created.`,
        );
        return;
      }

      // Unmatched line items already have an open review case from StaffMatchingService —
      // simply skipped here, not silently dropped. Matched-but-not-yet-linked line items
      // will be picked up on a future call once resolved (admin manual link or next sync).
      if (invoiceExists.lineItems.length === 0) {
        console.log(
          `Invoice ${event.objectId} has no matched line items yet. No commission will be created on this pass.`,
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

      for (const lineItem of invoiceExists.lineItems) {
        const eligibility = computeLineItemCommissionEligibility({
          lineItemAmount: lineItem.amount ?? 0,
          staffStartDate: lineItem.staff?.start_date ?? null,
          commissionPercent,
        });

        if (!eligibility.eligible) {
          // 365-day skips are logged by CommissionDetectionService's periodic pass — this
          // webhook path fires far more often and would flood the audit log if it logged
          // every skip too, so it stays silent and lets the sync pass be the audit source.
          continue;
        }

        const idempotencyKey = buildCommissionIdempotencyKey({
          affiliateId,
          hubspotInvoiceId: invoiceExists.hubspot_id,
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
            },
          });
        } catch (err: any) {
          // One line item's failure must not block the other collaborators'
          // commissions on the same invoice from being created.
          console.error(
            `❌ Error creating commission for line item ${lineItem.id} (invoice ${event.objectId}): ${err?.message ?? err}`,
          );
        }
      }

      return true;
    } catch (error) {
      console.error(`❌ Error creating comission ${event.objectId}`);
      console.error('Status:', error.response?.status);
      console.error('Data:', error.response?.data);
      console.error('Message:', error.message);
      throw new BadRequestException(
        `Error creating comission: ${error.message}`,
      );
    }
  }
}
