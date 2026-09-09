/**
 * Minimum lead-time rule for adding candidates to an EXISTING interview
 * panel (`POST /candidates/endorse-candidate`).
 *
 * IMPORTANT semantic difference from `interview-schedule-window.ts`: that
 * 24h rule keys on the hire request's ORIGIN (`hireRequest.createdBy.role`).
 * This 48h rule keys on the ACTING user's role (`user.role`) — the person
 * adding candidates right now. A system admin/owner rescuing a panel that
 * starts in 2 hours is a legitimate operational action and must NOT be
 * blocked; only organization users are restricted. Reuse
 * `isClientOriginatedRole` from `interview-schedule-window.ts` at the call
 * site to decide who is gated — it is not redefined here.
 */

import { parseNaiveInterviewDate } from './interview-schedule-window';

export const PANEL_CANDIDATE_MIN_LEAD_HOURS = 48;

export const PANEL_CANDIDATE_MIN_LEAD_ERROR =
  'There is not enough time to prepare the candidate for this interview. Interviews starting in less than 48 hours are closed to new candidates. Contact your sales representative by submitting a ticket, or create a new hire request to interview your selected candidates.';

/**
 * Returns `true` when adding candidates to a panel should be blocked because
 * its active interview starts too soon.
 *
 * - `scheduledDate` `null`/`undefined` → `false` (permissive fallback: no
 *   interview scheduled yet, so there is nothing to protect).
 * - Unparsable value → `true` (fail-closed, mirrors `violatesMinLeadTime`).
 * - Otherwise → `true` when earlier than `now + PANEL_CANDIDATE_MIN_LEAD_HOURS`.
 *
 * Normalization is delegated to `parseNaiveInterviewDate` (imported, not
 * duplicated) so both lead-time rules treat naive/offset date values
 * identically. `Interview.scheduled_date` read back from Prisma is already a
 * real `Date`, so this parse is a defensive normalization here, not the
 * primary path.
 */
export function violatesPanelCandidateMinLead(
  scheduledDate: unknown,
  now: Date = new Date(),
): boolean {
  if (scheduledDate === null || scheduledDate === undefined) return false;

  const parsed = parseNaiveInterviewDate(scheduledDate);
  if (!parsed) return true;

  const threshold =
    now.getTime() + PANEL_CANDIDATE_MIN_LEAD_HOURS * 60 * 60 * 1000;
  return parsed.getTime() < threshold;
}
