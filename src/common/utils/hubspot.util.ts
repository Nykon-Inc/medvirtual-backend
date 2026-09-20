import { OrganizationRole, Prisma } from '@prisma/client';
import axios from 'axios';
import {
  candidadeToDbDictionary,
  dbToCandidateDictionary,
} from '../dictionaries/candidate-dictionary';
import {
  dbToOrganizationDictionary,
  organizationToDbDictionary,
} from '../dictionaries/organization-dictionary';
import { CreateOrganizationDto } from '../../organization/dto/createOrganization.dto';
import { ownerToDbDictionary } from '../dictionaries/owner-dictionary';
import { dealToDbDictionary } from '../dictionaries/deal-dictionary';
import { hrTicketToDbDictionary } from '../dictionaries/HRTicket-dicionary';
import { invoiceToDbDictionary } from '../dictionaries/invoice-dictionary';
import { contactToDbDictionary } from '../dictionaries/contact-dictionary';

interface candidateData {
  [key: string]: any;
}

interface organizationData {
  [key: string]: any;
}

interface ownerData {
  [key: string]: any;
}

interface contactData {
  [key: string]: any;
}

interface dealData {
  [key: string]: any;
}

interface HRTicketData {
  [key: string]: any;
}
interface invoiceData {
  [key: string]: any;
}

export function extractDriveFileId(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
  return match ? match[1] : null;
}

export function mapHubspotToDb(
  hubspotData: candidateData,
): Prisma.CandidateCreateInput {
  const result: Partial<Prisma.CandidateCreateInput> = {};

  for (const [hubspotKey, dbKey] of Object.entries(candidadeToDbDictionary)) {
    const value = hubspotData[hubspotKey];

    if (value !== undefined) {
      if (Array.isArray(dbKey)) {
        for (const key of dbKey) {
          result[key] = value;
        }
      } else {
        result[dbKey] = value;
      }
    }
  }
  return result as Prisma.CandidateCreateInput;
}

export function mapDbToHubspot(data: Record<string, any>): Record<string, any> {
  const mappedData: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const hubspotKey = dbToCandidateDictionary[key];
    if (hubspotKey) {
      mappedData[hubspotKey] = value;
    }
  }
  return mappedData;
}

export function mapOrganizationToDb(
  hubspotData: organizationData,
): CreateOrganizationDto {
  const result: Partial<CreateOrganizationDto> = {};

  for (const [hubspotKey, dbKey] of Object.entries(
    organizationToDbDictionary,
  )) {
    const value = hubspotData[hubspotKey];
    if (value === undefined) continue;

    if (hubspotKey === 'type') {
      result[dbKey] =
        value === 'PROSPECT'
          ? OrganizationRole.prospect
          : OrganizationRole.client;
    } else {
      result[dbKey] = value;
    }
  }
  return result as CreateOrganizationDto;
}

export function mapDbToOrganization(
  dbData: CreateOrganizationDto,
): organizationData {
  const result: Partial<organizationData> = {};

  for (const [dbKey, hubspotKey] of Object.entries(
    dbToOrganizationDictionary,
  )) {
    const value = dbData[dbKey];
    if (value === undefined) continue;

    if (dbKey === 'organization_role') {
      result[hubspotKey] =
        value === OrganizationRole.prospect ? 'PROSPECT' : 'Current Client';
    } else {
      result[hubspotKey] = value;
    }
  }
  return result as CreateOrganizationDto;
}

export function mapOrganizationToDbHubspot(hubspotData: organizationData): any {
  const result: Partial<CreateOrganizationDto> = {};

  for (const [hubspotKey, dbKey] of Object.entries(
    organizationToDbDictionary,
  )) {
    const value = hubspotData[hubspotKey];
    if (value === undefined) continue;

    result[dbKey] = value;
  }
  return result as any;
}

export function mapOwnerToDb(hubspotData: ownerData): any {
  const result: Partial<any> = {};

  for (const [hubspotKey, dbKey] of Object.entries(ownerToDbDictionary)) {
    if (hubspotData[hubspotKey] !== undefined) {
      result[dbKey] = hubspotData[hubspotKey];
    }
  }
  return result as any;
}

export function mapContactToDb(hubspotData: contactData): any {
  const result: Partial<any> = {};

  for (const [hubspotKey, dbKey] of Object.entries(contactToDbDictionary)) {
    if (hubspotData[hubspotKey] !== undefined) {
      result[dbKey] = hubspotData[hubspotKey];
    }
  }
  return result as any;
}

export function mapDealToDb(hubspotData: dealData): any {
  const result: Partial<any> = {};

  for (const [hubspotKey, dbKey] of Object.entries(dealToDbDictionary)) {
    if (hubspotData[hubspotKey] !== undefined) {
      result[dbKey] = hubspotData[hubspotKey];
    }
  }
  return result as any;
}

export function mapHRTicketToDb(hubspotData: HRTicketData): any {
  const result: Partial<any> = {};

  for (const [hubspotKey, dbKey] of Object.entries(hrTicketToDbDictionary)) {
    if (hubspotData[hubspotKey] !== undefined) {
      result[dbKey] = hubspotData[hubspotKey];
    }
  }
  return result as any;
}

export function mapInvoiceToDb(hubspotData: invoiceData): any {
  const result: Partial<any> = {};

  for (const [hubspotKey, dbKey] of Object.entries(invoiceToDbDictionary)) {
    if (hubspotData[hubspotKey] !== undefined) {
      result[dbKey] = hubspotData[hubspotKey];
    }
  }
  return result as any;
}

export function changeLabelAvailability(label: string): string {
  return label === 'Available Candidates - Part Time'
    ? 'Part Time'
    : label === 'Available Candidates'
      ? 'Full Time'
      : 'Full Time';
}

/**
 * Resolves paid_at for a HubSpot invoice.
 * Prefers hs_payment_date directly from the invoice; falls back to
 * hs_initiated_date from the first associated payment object when absent.
 */
export async function resolvePaidAt(
  hsPaymentDate: string | null | undefined,
  paymentResults: Array<{ id: string }>,
): Promise<Date | null> {
  if (hsPaymentDate) {
    return new Date(hsPaymentDate);
  }
  if (paymentResults.length === 0) {
    return null;
  }
  try {
    const paymentId = paymentResults[0].id;
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/payments/${paymentId}?properties=hs_initiated_date`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
        },
      },
    );
    const initiatedDate = response.data?.properties?.hs_initiated_date;
    return initiatedDate ? new Date(initiatedDate) : null;
  } catch {
    return null;
  }
}

export interface HubspotLineItemRecord {
  hubspot_id: string;
  name: string | null;
  description: string | null;
  quantity: string | null;
  amount: string | null;
  discount: string | null;
}

/**
 * Fetches full line-item details for a HubSpot invoice's associated line_items.
 * Shared by InvoiceIngestionService (periodic sync, §2) and HandlerInvoiceCreation
 * (invoice-created webhook, §4.5 #1) so both ingestion paths produce line items in
 * the same shape for StaffMatchingService to consume — they must never diverge.
 */
export async function fetchLineItemsForInvoice(
  lineItemIds: string[],
): Promise<HubspotLineItemRecord[]> {
  const records: HubspotLineItemRecord[] = [];

  for (const id of lineItemIds) {
    try {
      const response = await axios.get(
        `https://api.hubapi.com/crm/v3/objects/line_items/${id}?properties=name,amount,description,quantity,discount`,
        {
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          },
        },
      );
      const props = response.data?.properties ?? {};
      records.push({
        hubspot_id: id,
        name: props.name ?? null,
        description: props.description ?? null,
        quantity: props.quantity ?? null,
        amount: props.amount ?? null,
        discount: props.discount ?? null,
      });
    } catch (err) {
      console.error(
        `Failed to fetch line item ${id} from HubSpot: ${err instanceof Error ? err.message : err}`,
      );
      // Non-blocking: skip this line item
    }
  }

  return records;
}
