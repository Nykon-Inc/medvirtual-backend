import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';
import { HandlerInvoiceCreation } from './invoiceCreation';
import { invoiceToDbDictionary } from '../../common/dictionaries/invoice-dictionary';
import { HandlerComissionCreation } from './comissionCreation';
import { resolvePaidAt } from '../../common/utils/hubspot.util';
import { StaffMatchingService } from '../../med-alliance/sync/staff-matching.service';
import { InvoicePaidCommissionService } from '../../med-alliance/sync/invoice-paid-commission.service';

@Injectable()
export class HandlerInvoicePropertyChange {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoiceCreation: HandlerInvoiceCreation,
    private readonly comissionCreation: HandlerComissionCreation,
    private readonly staffMatching: StaffMatchingService,
    private readonly invoicePaid: InvoicePaidCommissionService,
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
        await this.invoicePaid.markOrganizationDeployedFromFirstPaidInvoice({
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

      // HubSpot may not have finalized the real invoice number (hs_number) at invoice-
      // creation time, leaving invoice_number stuck at their "INV-DRAFT" placeholder since
      // the property-patch above only writes the single field the webhook event named. Re-fetch
      // it here, before commission creation, so the commission is created against the real
      // number when it's already available.
      try {
        const invoiceWithNumber = await axios.get(
          `https://api.hubapi.com/crm/v3/objects/invoices/${event.objectId}?properties=hs_number`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        );
        const freshInvoiceNumber =
          invoiceWithNumber.data?.properties?.hs_number;
        if (freshInvoiceNumber) {
          await this.prisma.hubspotInvoiceSnapshot.update({
            where: { hubspot_id: String(event.objectId) },
            data: { invoice_number: freshInvoiceNumber },
          });
        }
      } catch (err) {
        // Non-fatal: commission creation must proceed even if HubSpot's number fetch fails;
        // invoice_number self-heals on the next manual/periodic sync either way.
        console.error(
          `❌ Error fetching invoice number for invoice ${event.objectId}:`,
          err.message,
        );
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
}
