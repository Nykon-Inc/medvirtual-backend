import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlerInvoiceCreation } from './invoiceCreation';
import { invoiceToDbDictionary } from '../../common/dictionaries/invoice-dictionary';
import { HandlerComissionCreation } from './comissionCreation';
import { resolvePaidAt } from '../../common/utils/hubspot.util';
import { StaffMatchingService } from '../../med-alliance/sync/staff-matching.service';

@Injectable()
export class HandlerInvoicePropertyChange {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceCreation: HandlerInvoiceCreation,
    private readonly comissionCreation: HandlerComissionCreation,
    private readonly staffMatching: StaffMatchingService,
  ) {}

  async execute(event) {
    let invoice = await this.prisma.hubspotInvoiceSnapshot.findUnique({
      where: {
        hubspot_id: String(event.objectId),
      },
    });

    if (!invoice) {
      await this.invoiceCreation.execute(event);
      invoice = await this.prisma.hubspotInvoiceSnapshot.findUnique({
        where: {
          hubspot_id: String(event.objectId),
        },
      });
    }
    if (!invoice) return;

    const fieldExists = Object.keys(invoiceToDbDictionary).includes(
      event.propertyName,
    );
    if (!fieldExists) return;

    let objectToUpdate: any = {};

    const fieldUpdated = invoiceToDbDictionary[event.propertyName];
    let value = event.propertyValue;

    // HubSpot sends date fields as Unix millisecond timestamp strings; Prisma requires ISO-8601.
    if (fieldUpdated === 'paid_at' && value) {
      value = new Date(Number(value));
    }
    if (fieldUpdated === 'due_date' && value) {
      value = new Date(Number(value));
    }

    objectToUpdate = {
      [fieldUpdated]: value,
    };

    await this.prisma.hubspotInvoiceSnapshot.update({
      where: {
        hubspot_id: String(event.objectId),
      },
      data: {
        ...objectToUpdate,
      },
    });

    //if we receive a invoice status change to 'paid', then create a comission for the affiliate linked
    // option from hubspot(hs_invoice_status): draft | open | paid | vaided
    if (
      event.propertyName === 'hs_invoice_status' &&
      event.propertyValue === 'paid'
    ) {
      const invoiceWithOrg =
        await this.prisma.hubspotInvoiceSnapshot.findUnique({
          where: { hubspot_id: String(event.objectId) },
          select: {
            paid_at: true,
            organization: {
              select: {
                id: true,
              },
            },
          },
        });

      if (invoiceWithOrg && !invoiceWithOrg.paid_at) {
        const invoiceWithPayments = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/invoices/${event.objectId}?properties=hs_payment_date&associations=payments`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );
        const paymentResults: Array<{ id: string }> =
          invoiceWithPayments.data?.associations?.payments?.results ?? [];
        const resolvedPaidAt = await resolvePaidAt(
          invoiceWithPayments.data?.properties?.hs_payment_date,
          paymentResults,
        );
        if (resolvedPaidAt) {
          await this.prisma.hubspotInvoiceSnapshot.update({
            where: { hubspot_id: String(event.objectId) },
            data: { paid_at: resolvedPaidAt },
          });
          invoiceWithOrg.paid_at = resolvedPaidAt; // narrowed to non-null by outer guard
        }
      }

      if (invoiceWithOrg?.organization?.id) {
        // Mark the organization as deployed before creating the commission.
        // This keeps the first commission in "detected" while the org waits
        // for the 30-day cron promotion to "eligible".
        console.log(
          `Checking deployed transition for organization ${invoiceWithOrg.organization.id} (invoice ${event.objectId}).`,
        );
        await this.markOrganizationDeployedFromFirstPaidInvoice({
          organizationId: invoiceWithOrg.organization.id,
          firstInvoiceDate: invoiceWithOrg.paid_at ?? new Date(),
          hubspotInvoiceId: String(event.objectId),
        });

        // Line items created by this same webhook (or left pending from an earlier
        // pass) still have match_status=null — comissionCreation only picks up line
        // items already matched to a Staff, so this must run first or commission
        // creation silently no-ops until the next periodic sync.
        await this.staffMatching.run(invoiceWithOrg.organization.id);
      }

      await this.comissionCreation.execute(event);

      console.log(
        `Invoice with Hubspot ID ${event.objectId} has been paid. We can create a comission for the affiliate linked to this invoice, if there is one.`,
      );

      axios
        .get(
          `https://api.hubapi.com/crm/v3/objects/invoices/${event.objectId}?properties=hs_pdf_download_link`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        )
        .then((res) => {
          const pdfLink = res.data?.properties?.hs_pdf_download_link;
          console.log(
            `Fetched PDF link for invoice ${event.objectId}:`,
            pdfLink,
          );
          if (!pdfLink) return;
          return this.prisma.hubspotInvoiceSnapshot.update({
            where: { hubspot_id: String(event.objectId) },
            data: { hubspot_pdf_link: pdfLink },
          });
        })
        .catch((err) => {
          console.error(
            `❌ Error fetching PDF link for invoice ${event.objectId}:`,
            err.message,
          );
        });
    }

    return true;
  }

  /**
   * Marks a referred organization as "deployed" when its first paid invoice is detected.
   *
   * This helper intentionally does NOT touch med_alliance_referral_status — Confirm/Block
   * eligibility decisions become available to admins immediately once deployed, there is no
   * waiting period. execute() calls this before commission creation so the first commission
   * follows the expected "detected" status until an admin confirms eligibility.
   */
  private async markOrganizationDeployedFromFirstPaidInvoice(params: {
    organizationId: string;
    firstInvoiceDate: Date;
    hubspotInvoiceId?: string;
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
