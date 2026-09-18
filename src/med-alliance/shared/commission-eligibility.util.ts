import { Decimal } from '@prisma/client/runtime/library';

// One year in milliseconds — each collaborator's own 12-month commission window,
// anchored on that specific Staff row's start_date (not the company's deployment_date).
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type LineItemCommissionSkipReason =
  | 'staff_not_deployed' // staff.start_date is null — collaborator hasn't started yet
  | 'staff_window_expired'; // now - staff.start_date > 365 days

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
 * Eligibility is per-collaborator: anchored on Staff.start_date, not Organization.deployment_date.
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
