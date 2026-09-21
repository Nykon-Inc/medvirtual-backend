import { Decimal } from '@prisma/client/runtime/library';
import axios from 'axios';
import { PrismaService } from '../../prisma/prisma.service';

// One year in milliseconds — each collaborator's own 12-month commission window,
// anchored on that specific Staff row's hubspot_commission_start_date (not the company's
// deployment_date, and not Staff.start_date — see resolveStaffCommissionStartDate below).
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type LineItemCommissionSkipReason =
  | 'staff_not_deployed' // hubspot_commission_start_date is null — collaborator's first commission hasn't started yet
  | 'staff_window_expired'; // now - hubspot_commission_start_date > 365 days

export interface LineItemCommissionEligibility {
  eligible: boolean;
  skipReason?: LineItemCommissionSkipReason;
  commissionAmount?: Decimal;
  daysSinceStart?: number;
}

/**
 * The single source of truth for "given a matched line item, is it eligible for
 * commission right now, and what's the amount" — every commission-creating code path
 * (CommissionDetectionService, the invoice-paid webhook, admin manual-create, the
 * associate-company backfill) must call this instead of reimplementing its own
 * eligibility/anchoring logic.
 *
 * Eligibility is per-collaborator: anchored on Staff.hubspot_commission_start_date (resolved via
 * resolveStaffCommissionStartDate below), not Staff.start_date or Organization.deployment_date —
 * start_date is when the collaborator began working, which can precede the first commission
 * payment by months; hubspot_commission_start_date is the actual anchor HubSpot tracks for that.
 * Company-level gates (active-client block, canceled stage, deleted org) are NOT this
 * function's concern — callers apply those before reaching a line item.
 *
 * `now` MUST be the invoice's due_date (via resolveCommissionAnchorDate below), never the
 * wall-clock time the code happens to run at — two invoices with the same due_date must
 * produce the same eligibility result regardless of when they're processed. Omitting `now`
 * falls back to real wall-clock time and is a bug in the caller, not a valid usage.
 */
export function computeLineItemCommissionEligibility(params: {
  lineItemAmount: Decimal | string | number;
  staffStartDate: Date | null;
  commissionPercent: Decimal | string | number;
  now?: Date;
}): LineItemCommissionEligibility {
  const now = params.now ?? new Date();

  if (!params.staffStartDate) {
    return { eligible: false, skipReason: 'staff_not_deployed' };
  }

  const daysSinceStart = Math.floor(
    (now.getTime() - params.staffStartDate.getTime()) / (24 * 60 * 60 * 1000),
  );

  if (now.getTime() - params.staffStartDate.getTime() > ONE_YEAR_MS) {
    return {
      eligible: false,
      skipReason: 'staff_window_expired',
      daysSinceStart,
    };
  }

  const commissionAmount = new Decimal(params.lineItemAmount)
    .mul(params.commissionPercent)
    .div(100)
    .toDecimalPlaces(2);

  return { eligible: true, commissionAmount, daysSinceStart };
}

/**
 * The commission-eligibility anchor date for an invoice: its due_date, since that's the
 * business date the 365-day collaborator window is measured against — falling back to
 * paid_at, then to wall-clock time, only when due_date hasn't been synced from HubSpot yet.
 */
export function resolveCommissionAnchorDate(invoice: {
  due_date: Date | null;
  paid_at: Date | null;
}): Date {
  return invoice.due_date ?? invoice.paid_at ?? new Date();
}

/**
 * Resolves the commission-eligibility anchor date for a Staff row: hubspot_commission_start_date
 * if already synced, or a live fetch from the HubSpot Deal (staff.hubspot_id) as a fallback when
 * it hasn't been backfilled/synced yet. Persists whatever HubSpot returns so subsequent calls
 * don't need to re-fetch. Returns null if HubSpot also has no value — callers must treat that as
 * "not yet deployed", never fall back to start_date.
 */
export async function resolveStaffCommissionStartDate(
  prisma: PrismaService,
  staff:
    | {
        id: string;
        hubspot_id: string | null;
        hubspot_commission_start_date: Date | null;
      }
    | null
    | undefined,
): Promise<Date | null> {
  if (!staff) return null;
  if (staff.hubspot_commission_start_date) {
    return staff.hubspot_commission_start_date;
  }
  if (!staff.hubspot_id) return null;

  try {
    const response = await axios.get(
      `https://api.hubapi.com/crm/v3/objects/deals/${staff.hubspot_id}?properties=alliance_commission_start_date`,
      {
        headers: {
          Authorization: `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const raw = response.data?.properties?.alliance_commission_start_date;
    if (!raw) return null;

    // HubSpot's read API returns "date"-type properties as "YYYY-MM-DD" (no time), not the
    // epoch-millis strings webhook payloads use for "datetime" properties — only try Number()
    // first when the raw value actually looks numeric.
    const parsed = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
    if (isNaN(parsed.getTime())) return null;

    await prisma.staff.update({
      where: { id: staff.id },
      data: { hubspot_commission_start_date: parsed },
    });

    return parsed;
  } catch (err) {
    console.error(
      `❌ Error fetching alliance_commission_start_date for staff ${staff.id} (deal ${staff.hubspot_id}):`,
      err.message,
    );
    return null;
  }
}
