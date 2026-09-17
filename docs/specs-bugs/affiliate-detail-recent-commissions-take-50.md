# Backlog — Payout request sees only part of an affiliate's eligible commissions

**Status**: fixed (2026-09-17)
**Area**: Med Alliance admin (`AffiliatesService.findOne` → `findOneEnriched` →
`GET /med-alliance/admin/affiliates/:id`, consumed by the new-payout-request dialog)

## Symptom

For affiliate profile `00dd0e3f-1c64-4d69-b2d3-fd596277f3dd` the commissions page shows
**12** eligible commissions, but starting a payout request reports only **7** eligible.

Reproduced against the production database:

| Measure | Count |
| --- | --- |
| All commissions for the profile | 138 |
| Eligible (true count, by `affiliate_profile_id`) | 12 |
| Eligible (true count, by `affiliate_id` / user) | 12 |
| Returned by `GET /admin/affiliates/:id` (`take: 50`) | 50 |
| ↳ of which `eligible` | **7** |
| ↳ of which `pending_admin_confirmation` | 43 |

## Root cause

`AffiliatesService.findOne` loads the profile's commissions capped at the 50 most recent,
across **all statuses** (`affiliates.service.ts:861-875`):

```ts
commissions: {
  select: { id: true, status: true, commission_amount: true, createdAt: true, ... },
  orderBy: { createdAt: 'desc' },
  take: 50,
},
```

`findOneEnriched` reuses it (`affiliates.service.ts:1126`), and the controller maps that
array straight into the response as `recent_commissions`
(`affiliates.controller.ts:422-430`).

The payout dialog then derives the eligible set by filtering that array client-side
(`_components/new-payout-request-dialog.tsx:68`):

```ts
const eligible = (detail?.recent_commissions ?? []).filter((c) => c.status === "eligible");
```

So the count is not "this affiliate's eligible commissions" — it is "the eligible ones
that happen to fall within their 50 newest commissions of any status". This affiliate has
43 `pending_admin_confirmation` rows crowding that window, which pushes 5 of the 12
eligible commissions out of it.

Consequences beyond the wrong number:

- `eligibleIds` / `eligibleTotal` in the dialog are built from the same truncated array
  (`new-payout-request-dialog.tsx:69-70`), so a payout created this way **silently omits
  the commissions that were cut off** and understates the amount owed.
- The affiliate detail sheet shows the same undercount in its "Eligible commissions (N)"
  section (`mv-admin-affiliate-detail-sheet.tsx:247,794`).
- The field name `recent_commissions` accurately describes a *recency* window, but both
  consumers treat it as a complete set.

The skew grows with pending volume: the more commissions awaiting admin confirmation, the
fewer eligible ones remain visible for payout.

## Fix applied on 2026-09-17

Verified against the production database for the reported affiliate: the payout flow now
sees **12 eligible commissions totalling $1,078.13**, where it previously saw 7 totalling
$454.98 — a $623.15 undercount across 5 commissions.

1. **New endpoint** `GET /med-alliance/admin/affiliates/:id/eligible-commissions`
   (`AffiliatesService.findEligibleCommissions`) returns every eligible commission with an
   authoritative `eligible_count` and `eligible_amount` from `aggregate`. The query filters
   `status` server-side, keys on the profile's `user_id`, and has no `take`. A profile with
   no connected user returns empty results rather than querying.
2. **Authoritative counts on the side panel.** `findOneEnriched` now also returns
   `eligibleAgg` (a `count`/`_sum` over the whole table) and the controller exposes it as
   `eligible_count` / `eligible_amount`, so a truncated array is never counted.
3. **Payout dialog** (`new-payout-request-dialog.tsx`) loads from the new endpoint and uses
   the server's `eligible_amount` as the displayed total instead of summing a partial list.
4. **Affiliate detail sheet** loads the full eligible set into its own state, so the payout
   picker selects from all eligible commissions. Its per-commission selection is
   intentionally a subset, so it does not send an expected count.
5. **Server-side completeness guard.** Optional `expected_eligible_count` on
   `AdminCreatePayoutRequestDto`: when the client states how many eligible commissions it
   saw, `createForAdmin` compares it to the real count and rejects a mismatch before
   creating anything. This turns a stale or truncated selection into a loud error instead
   of a silent underpayment. The request amount was already recomputed server-side from
   the commission ids (`payout-requests.service.ts:312`), so the total itself was never
   client-controlled.

Tests: 4 new cases in `affiliates.service.spec.ts` (missing profile, no connected user,
full unbounded list with no `take`, empty set), 2 in `payout-requests.service.spec.ts`
(count mismatch rejected before the transaction, no count query when the field is omitted),
and 4 in `new-payout-request-dialog.test.tsx` (loads from the dedicated endpoint, sends all
12 ids plus the expected count, uses the server total, disables create when empty).

### Still open

`recent_commissions` keeps its `take: 50` and remains a genuine preview. Any *new* consumer
that needs a complete set must use the dedicated endpoint or the aggregate fields — the
field name invites the same mistake, so renaming it is worth considering.

## Original fix plan (for reference)

The payout flow needs a complete, authoritative eligible list — not a recency window.

1. Do not derive payout candidates from `recent_commissions`. Either:
   - have the dialog call `GET /med-alliance/admin/commissions?affiliate_id=<userId>&status=eligible`
     (already supported by `ListCommissionsDto`), paginating to completion; or
   - add a dedicated endpoint, e.g. `GET /admin/affiliates/:id/eligible-commissions`,
     returning every eligible commission plus a summed total.
   Note the key mismatch: the commissions list filters `affiliate_id` (USER id), while the
   affiliate route keys on the **profile** id — see the existing comment at
   `mv-admin-payout-detail-sheet.tsx:212-214`. Resolve the user id from the profile before
   querying.
2. Return an authoritative `eligible_count` and `eligible_amount` from the affiliate
   endpoint via `count` / `aggregate` on the full table, independent of any `take`, so the
   detail sheet stops counting a truncated array.
3. Keep `recent_commissions` as a genuine preview (rename it or leave the `take: 50`) but
   stop letting money flows depend on it.
4. Verify the payout total server-side at creation from the commission ids, so a truncated
   client list can never define the payable amount. `validateCommissions`
   (`payout-requests.service.ts:98-113`) already re-checks status per id — extend the same
   reasoning to completeness/total.
5. Tests: an affiliate with more than 50 commissions where eligible rows fall outside the
   50 newest must still report the full eligible count and total.

## Related code

- `src/med-alliance/affiliates/affiliates.service.ts:861-875` — `take: 50`, all statuses
- `src/med-alliance/affiliates/affiliates.service.ts:1125-1126` — `findOneEnriched` reuse
- `src/med-alliance/affiliates/affiliates.controller.ts:422-430` — `recent_commissions`
- `src/med-alliance/payout-requests/payout-requests.service.ts:98-113` — status validation
- frontend `admin/payout-requests/_components/new-payout-request-dialog.tsx:66-77`
- frontend `admin/_shared/components/mv-admin-affiliate-detail-sheet.tsx:247-274,794`

Same family as
[`admin-commissions-client-side-pagination.md`](./admin-commissions-client-side-pagination.md):
a capped list fetched once and then filtered in the browser as if it were complete.
