# Bug: Med Alliance commission eligibility was per-company, not per-collaborator

## Summary

Business rule: a partner refers company X to MedVirtual. MedVirtual places a Virtual
Assistant (e.g. João) at company X. During **João's first year at company X**, the
partner earns **7% of every payment company X makes to João**. Each collaborator placed
by the same referral has their **own independent 12-month commission clock**, starting on
that collaborator's own start date — not a single clock for the whole company.

The implementation did not do this. It was built entirely around a **single per-company
clock**: one `deployment_date`, one 365-day window, one commission per paid invoice —
computed on the invoice's full amount, regardless of how many collaborators (VAs) that
invoice actually paid for.

## Root cause

- `Organization.deployment_date` is synced from the HubSpot company property
  `deploy_date_of_first_va` — literally "date of the **first** VA ever deployed at this
  company." One value, ever, per company.
- `CommissionDetectionService.run()` anchored the entire 365-day eligibility window on
  that single `deployment_date`, and generated one `AffiliateCommission` per **HubSpot
  company-level invoice**, applying the affiliate's flat commission percent to the **full
  invoice amount**.
- Neither `HubspotInvoiceSnapshot` nor `AffiliateCommission` had any column referencing a
  specific collaborator. A company with multiple VAs (common — one live client company had
  10 separate VA placement deals) generated commission on every invoice inside the same
  single window, regardless of which VA it was actually paying for, and a VA hired 8
  months after the company's first VA inherited the *first* VA's clock instead of getting
  their own.
- Four **other** independent code paths reimplemented the same company-wide, invoice-total
  logic, each with its own eligibility/anchoring computation: a HubSpot invoice-created
  webhook, a HubSpot invoice-paid webhook → commission-creation handler, an admin
  manual-commission endpoint, and an admin associate-company-to-affiliate backfill. Fixing
  only `CommissionDetectionService` would have left all four still wrong.

## What HubSpot actually has

- **HubSpot Deal = one collaborator placement.** Each deal carries its own `start_date`
  and syncs 1:1 into `Staff` (`Staff.start_date`, `Staff.organization_id`,
  `Staff.candidate_id`). `Staff.start_date` is already the correct per-collaborator anchor
  and was already populated — no new HubSpot sync was needed for the anchor date itself.
- **Invoice → Deal association is unreliable** (sampled live: 93 paid invoices, 0 had a
  `deals` association) — cannot be used as the join key.
- **Invoice line items carry the collaborator's name as free text** in the `name`
  property, each with its own `amount` — the actual payment made to that specific
  collaborator. `HubspotLineItemSnapshot` already existed in the schema but was dead code
  (never populated or read anywhere in the med-alliance module).

## Fix

Match each `HubspotLineItemSnapshot.name` (free text) to a `Staff` row within the same
organization, and compute commission **per line item** (not per invoice), anchored on
**that Staff row's own `start_date`** (not the company's `deployment_date`). Unmatched
line items fall into the existing admin-review-case pattern rather than silently
generating wrong or missing commissions.

### Schema (`backend/prisma/schema.prisma`)

- `HubspotLineItemSnapshot` gains `staff_id`, `match_status`
  (`matched | unmatched | ambiguous | not_applicable`), `matched_by` (`auto | admin_manual`).
- `AffiliateCommission` gains `hubspot_line_item_snapshot_id`, `staff_id` (denormalized).
  The uniqueness constraint moves from `hubspot_invoice_snapshot_id` to
  `hubspot_line_item_snapshot_id` — one commission per collaborator payment, not per
  invoice. Legacy rows (pre-fix) keep a null `hubspot_line_item_snapshot_id`.
- `MedAllianceAdminReviewCase` gains `hubspot_line_item_snapshot_id` (nullable), and the
  `openOrSkip` dedup unique constraint becomes
  `[organization_id, reason_code, status, hubspot_line_item_snapshot_id]` — a single
  organization can now have several distinct open cases at once (one per unmatched line
  item), where previously only one open case per (org, reason) could ever exist.
- `AdminReviewReasonCode` gains `unmatched_line_item`, `ambiguous_line_item`.
- `MedAllianceEntityType` gains `review_case` (closes a separate audit-log gap, see below).

### New service: `StaffMatchingService` (`backend/src/med-alliance/sync/staff-matching.service.ts`)

For each unmatched `HubspotLineItemSnapshot` in an organization, matches `name` against
that organization's own `Staff` pool — **always organization-scoped**, never global (two
collaborators at different companies can share similar/identical names).

Real HubSpot deal names are never bare — they follow
`{Company}{separator}{Name}{optional suffix}` with noise (repeated surname, middle
initial, `(n)` VA counter). The matching algorithm
(`staff-name-matching.util.ts`) normalizes both sides (strip company prefix, strip
counter suffix, strip middle initials, collapse duplicate tokens, lowercase, strip
accents) and scores candidates by token-overlap + string-similarity, not exact string
equality — exact comparison never matches this data.

Outcomes: 0 matches → `unmatched` (opens a review case); 1 confident match → `matched`;
2+ close matches → `ambiguous` (opens a review case, admin picks the right `Staff`).

### Rewritten `CommissionDetectionService.run()`

Unit of work changed from "one commission per paid invoice" to "one commission per paid
invoice's **matched** line item." For each matched line item, loads its `Staff.start_date`
and skips (no commission) if the staff hasn't started yet, or if `now - start_date > 365
days`. The latter skip is now logged to `MedAllianceAuditLog`
(`event: 'commission_skipped_staff_expired'`, linking the organization, the
`HubspotInvoiceSnapshot`, the `HubspotLineItemSnapshot`, and the `Staff` id) — a durable,
queryable record of every payment excluded from commission and why.

### Shared eligibility helper

`computeLineItemCommissionEligibility()`
(`backend/src/med-alliance/shared/commission-eligibility.util.ts`) is the single source of
truth for "given a matched line item, is it eligible right now, and what's the commission
amount." All five commission-creating code paths use it:
`CommissionDetectionService`, the invoice-paid webhook
(`HandlerComissionCreation`), the admin manual-commission endpoint
(`CommissionsService.createFromInvoices()`, now line-item-scoped, not invoice-scoped),
and the associate-company backfill (`AffiliatesService._backfillOnAssociation()`).

### Company-level eligibility becomes exclusively manual

A related but separate finding: `Organization.med_alliance_referral_status`
(`eligible | not_eligible | expired`) was being auto-decided by several background code
paths with zero admin involvement (a HubSpot webhook branch, a cron sweep, ambiguous-match
handling, an inline sync backstop). This is now exclusively a manual admin decision via
the existing Confirm/Block endpoints (`approve-eligibility` / `block-eligibility`), which
are themselves gated on `referral_stage === 'deployed'`.

The automatic **detection** of the `deployed` stage itself (`referral_stage`,
`eligibility_start_at`, `deployment_date`) is unchanged and stays automatic — it's the
prerequisite signal that surfaces a company for the admin's decision, not the decision
itself. Only the code that went one step further and pre-decided
`med_alliance_referral_status` was disabled (commented out, not deleted, with a pointer
back to this doc):

- `CommissionDetectionService.expireEligibility()` — disabled entirely.
- `HandlerOrganizationPropertyChange` (HubSpot `deploy_date_of_first_va` webhook) — the
  `referral_stage`/`eligibility_start_at` writes stay; only the
  `med_alliance_referral_status` assignment in each of its three branches is commented
  out.
- `cron.controller.ts`'s `GET /cron/expire-stale-eligibility` — returns 410 instead of
  running the automatic expiry sweep.
- `HubspotMatchingService.handleMultipleMatches()` — no longer auto-sets `not_eligible`.
- `AffiliatesService._backfillOnAssociation()` — the manual association itself is kept;
  only its auto-computed `isExpired`/`daysSinceDeployment` status side effect is disabled.
- `EligibilityCheckService.runAndPersist()` (MA-004 active-client check) — its
  sync-triggered call site in `HubspotMatchingService` is disabled; the user-triggered
  (referral submission) and admin-triggered (`POST .../eligibility-check`) call sites are
  kept, since those are actor-driven, not background.

**Note**: `docs/specs/med-alliance-eligibility.md` predates this fix and describes the old
event-driven, binary-status, cron-free eligibility model. It is now stale — company
eligibility is manual-only and the status enum has four values, not two — and should be
rewritten or retired in a follow-up; it was left untouched here since updating it wasn't
part of this bug's scope.

### Review-case UI and audit log

Two coverage gaps were closed as part of shipping the new review-case types:

1. **Audit log** — `MedAllianceAuditLog` previously only recorded one narrow
   review-case resolution path (`void_and_recreate`, logged under `entity_type:
   'commission'`). `review_case` is now a first-class `MedAllianceEntityType`, and
   `ReviewCasesService.resolve()` writes an audit entry for **every** resolution path,
   not just that one — directly relevant here since the new `manual_link`/`not_applicable`
   actions retroactively affect commission generation.
2. **Frontend** — `frontend/src/app/med-alliance/admin/review/page.tsx` already existed and
   was extended (not rebuilt) with the two new reason codes, a new organization-scoped
   `StaffPicker` combobox component (`frontend/src/components/staff-picker.tsx`, reusing
   the existing `GET /staff/search?organization_id=` endpoint), and a "not a collaborator"
   option in the resolve dialog.

## Verification

- `commission-detection.service.spec.ts` — the core regression test: two `Staff` rows on
  the same paid invoice with different `start_date`s (one 400 days old, one 30 days old)
  — asserts only the recent staff's line item produces a commission, at that line item's
  amount × commission %, not the full invoice total.
- `staff-matching.service.spec.ts` — covers all four real-world name-noise cases sampled
  from live data (duplicated surname, dash separator + middle initial, numeric VA-counter
  suffix, dirty whitespace/newline), plus unmatched/ambiguous outcomes and
  organization-scoping.
- `review-cases.service.spec.ts` — covers `manual_link`/`not_applicable` resolution and
  the "audit log written for every resolution" guarantee.
- Full backend suite (`npm run test`) and `npx tsc --noEmit` clean.
- Full frontend suite (`npm run test`) and `npx tsc --noEmit` clean (pre-existing,
  unrelated TS errors in payout-request test fixtures are untouched by this change).
- See `med-alliance-per-collaborator-commission-qa-guide.md` for the manual QA checklist.
