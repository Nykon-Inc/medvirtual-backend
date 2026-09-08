import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';
import {
  mapInvoiceToDb,
  resolvePaidAt,
  fetchLineItemsForInvoice,
} from '../../common/utils/hubspot.util';
import { PrismaService } from '../../prisma/prisma.service';
import { invoiceToDbDictionary } from '../../common/dictionaries/invoice-dictionary';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry(fn, retries = 3, delay = 500) {
  try {
    return await fn();
  } catch (err) {
    if (
      retries > 0 &&
      axios.isAxiosError(err) &&
      err.response?.status === 429
    ) {
      await sleep(delay);
      return retry(fn, retries - 1, delay * 2); // exponential backoff
    }
    throw err;
  }
}

@Injectable()
export class HandlerInvoiceCreation {
  constructor(private readonly prisma: PrismaService) {}

  async execute(event) {
    try {
      const invoiceExists = await this.prisma.hubspotInvoiceSnapshot.findUnique(
        {
          where: {
            hubspot_id: String(event.objectId),
          },
        },
      );
      if (invoiceExists) {
        console.log(
          `Invoice with Hubspot ID ${event.objectId} already exists. Skipping creation.`,
        );
        return;
      }

      const properties = Object.keys(invoiceToDbDictionary).join(',');
      const getObject = await retry(() =>
        axios.get(
          `https://api.hubapi.com/crm/v3/objects/invoices/${event.objectId}?properties=${properties}&associations=line_items,companies,payments`,
          {
            headers: {
              Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );

      if (!getObject) {
        throw new BadRequestException('No object data found');
      }

      //console.log("Associations companies:", getObject.data.associations?.companies);
      //console.log(`Associations line_items:`, getObject.data.associations?.['line items']);

      const invoiceData = mapInvoiceToDb(getObject.data.properties);

      const paymentResults: Array<{ id: string }> =
        getObject.data.associations?.payments?.results ?? [];
      const resolvedPaidAt = await resolvePaidAt(
        getObject.data.properties.hs_payment_date,
        paymentResults,
      );
      if (resolvedPaidAt) {
        invoiceData.paid_at = resolvedPaidAt;
      }
      if (invoiceData.due_date) {
        invoiceData.due_date = new Date(invoiceData.due_date as string);
      }

      const rawAmount = parseFloat(invoiceData.invoice_amount ?? '0');
      if (isNaN(rawAmount) || rawAmount <= 0) {
        console.log(
          `Invoice ${event.objectId} has a zero or missing amount. Skipping snapshot creation.`,
        );
        return;
      }

      let organizationDbId: string | undefined;
      const companyAssociated = getObject.data.associations?.companies;
      if (companyAssociated?.results?.length > 0) {
        const hubspotCompanyId = String(companyAssociated.results[0].id);
        const organizationExists = await this.prisma.organization.findUnique({
          where: { hubspot_id: hubspotCompanyId },
          select: { id: true, status: true },
        });
        if (organizationExists) {
          organizationDbId = organizationExists.id;
          if (organizationExists.status === 'inactive') {
            await this.prisma.organization.update({
              where: { id: organizationExists.id },
              data: { status: 'active' },
            });
            await this.prisma.hubspotAuditLog.create({
              data: {
                entity_type: 'organization',
                entity_id: organizationExists.id,
                hubspot_object_type: 'invoice',
                hubspot_object_id: String(event.objectId),
                action: 'UPDATE',
                source: 'webhook',
                success: true,
                payload: {
                  previous_status: 'inactive',
                  new_status: 'active',
                  reason: 'invoice_received_while_inactive',
                },
              },
            });
          }
        }
      }

      if (!organizationDbId) {
        console.log(
          `Invoice ${event.objectId}: no matching organization found. Skipping.`,
        );
        return;
      }

      const invoiceCreated = await this.prisma.hubspotInvoiceSnapshot.create({
        data: {
          ...invoiceData,
          organization: { connect: { id: organizationDbId } },
        },
      });
      if (!invoiceCreated) {
        throw new BadRequestException('Error creating Invoice in the database');
      }

      // Line items — fetched via the shared fetchLineItemsForInvoice helper (same one
      // InvoiceIngestionService uses for the periodic sync path) so both ingestion paths
      // produce identical shapes for StaffMatchingService to consume. staff_id/match_status
      // are left null here (default) — matching happens in a later sync pass, not on webhook.
      const lineItemsAssociated = getObject.data.associations?.['line items'];
      if (lineItemsAssociated?.results?.length > 0) {
        const lineItemIds = lineItemsAssociated.results.map((r: any) => r.id);
        const lineItemRecords = await fetchLineItemsForInvoice(lineItemIds);

        for (const record of lineItemRecords) {
          try {
            await this.prisma.hubspotLineItemSnapshot.create({
              data: {
                hubspot_id: record.hubspot_id,
                name: record.name,
                description: record.description,
                quantity: record.quantity,
                amount: record.amount,
                discount: record.discount,
                invoice_id: invoiceCreated.id,
              },
            });
          } catch (error) {
            console.error(
              `❌ Error creating line item ${record.hubspot_id} in the database`,
            );
            console.error('Message:', error.message);
          }
        }
      }

      return true;
    } catch (error) {
      console.error(`❌ Error fetching invoice ${event.objectId} from HubSpot`);
      console.error('Status:', error.response?.status);
      console.error('Data:', error.response?.data);
      console.error('Message:', error.message);
      throw new BadRequestException(
        `Error fetching object creation Invoice: ${error.message}`,
      );
    }
  }
}
