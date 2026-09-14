/**
 * Minimum lead-time rule for scheduling/rescheduling interviews on
 * client-originated hire requests.
 *
 * Naive-wall-clock-as-UTC convention: `date_time` arrives from the frontend
 * as a naive, offset-less string (`YYYY-MM-DDTHH:MM`) built from the digits
 * the admin typed — it is neither the admin's local instant nor a true PST
 * instant. `scheduleInterview` / `editInterview` persist it by appending `Z`
 * (treating the typed wall-clock as if it were UTC). This module mirrors
 * that exact normalization so the 24h-gap check is evaluated against the
 * same instant the service will actually persist — it does NOT attempt to
 * correct the PST/UTC mismatch. See `requirements.md` (finding F3) for the
 * full rationale; that mismatch is a deliberate, pre-existing out-of-scope
 * item for this feature, not a bug introduced here.
 */

export const INTERVIEW_MIN_LEAD_HOURS = 24;

export const INTERVIEW_MIN_LEAD_ERROR =
  'Interviews for client-requested hire requests must be scheduled at least 24 hours in advance.';

/**
 * Returns `true` only when `role` is a non-empty string containing
 * `"organization"`. Null/undefined/empty returns `false` — the permissive
 * fallback mandated for hire requests whose origin cannot be resolved.
 * Mirrors the `user.role.includes('organization')` convention used
 * throughout `hire-request.service.ts`.
 */
export function isClientOriginatedRole(role?: string | null): boolean {
  return typeof role === 'string' && role.includes('organization');
}

/**
 * Normalizes `date_time` exactly the way `scheduleInterview` / `editInterview`
 * already do: stringify, and append `Z` unless it already ends in `Z` or a
 * `±HH:MM` offset. Returns `null` when the result is an `Invalid Date`.
 *
 * Kept in sync with the naive-wall-clock-as-UTC convention documented above —
 * do not change this normalization without updating both service methods.
 */
export function parseNaiveInterviewDate(dateTime: unknown): Date | null {
  const dateTimeStr = String(dateTime);
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(dateTimeStr)
    ? dateTimeStr
    : `${dateTimeStr}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Returns `true` when `dateTime` is unparsable OR strictly earlier than
 * `now + INTERVIEW_MIN_LEAD_HOURS`. The threshold is built from `now`'s
 * epoch milliseconds directly so both sides of the comparison live in the
 * same UTC-epoch frame as `parseNaiveInterviewDate`.
 */
export function violatesMinLeadTime(
  dateTime: unknown,
  now: Date = new Date(),
): boolean {
  const parsed = parseNaiveInterviewDate(dateTime);
  if (!parsed) return true;

  const threshold = now.getTime() + INTERVIEW_MIN_LEAD_HOURS * 60 * 60 * 1000;
  return parsed.getTime() < threshold;
}
