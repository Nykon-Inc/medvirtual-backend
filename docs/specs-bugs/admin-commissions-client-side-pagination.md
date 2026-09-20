# Backlog — Admin commissions page truncates the list at 100 records

**Status**: fix applied (2026-09-17), server-side search pending
**Area**: Med Alliance admin commissions (frontend `modules/alliance/admin/commissions` +
`CommissionsService.findAllForAdmin`)

## Symptom

An invoice with 5 `eligible` commissions showed only 2 of them on
`/modules/alliance/admin/commissions`. The 3 missing rows existed in the database with
correct `status`, `affiliate_id` and `organization_id`, and were returned correctly by
`GET /med-alliance/admin/commissions/:id` individually.

Reported case — invoice `c1d67973-68bc-43f7-9bb0-2c372a4b93de`, 211 commissions in
production at the time:

| Commission | `createdAt` | Global position (desc) | Visible |
| --- | --- | --- | --- |
| `68385323…` (77.00) | 2026-09-17 20:22:50.747 | 59 | yes |
| `5374049e…` (63.15) | 2026-09-17 20:22:50.740 | 60 | yes |
| `158206c9…` (84.00) | 2026-09-17 20:08:36.275 | 103 | no |
| `df6074d2…` (77.00) | 2026-09-17 20:08:36.148 | 112 | no |
| `260413c7…` (301.15) | 2026-07-07 19:54:34.650 | 158 | no |

## Root cause

Not a query bug. `CommissionsService.findAllForAdmin` has no `distinct`, no hidden status
filter, and its admin `select` returns all 5 rows intact (verified directly against the
production database).

The frontend fetched a single page and treated it as the complete list:

```ts
const res = await ApiHandler(`${BASE}?limit=100`, "GET", router);
```

The backend orders by `createdAt desc` (`commissions.service.ts:258`) and honours
`limit=100`, so only the 100 newest commissions reached the browser. Everything older than
the 100th row (`createdAt 2026-09-17 20:21:50.385`) was absent from the client entirely.

Two things turned that truncation into an invisible failure:

1. The response includes `pagination.total` (211), and the client discarded it — so
   nothing surfaced the gap in the UI.
2. Status grouping, search and all filters run client-side over the fetched array
   (`commissions-view.tsx:145-165`). A row missing from the fetch is not paginated away,
   it simply does not exist for the board, the table, the counts or the affiliate
   dropdown.

Raising `limit` was not available as a fix: `ListCommissionsDto` caps it with `@Max(100)`
(`dto/list-commissions.dto.ts:41`). That cap is deliberate — `COMMISSION_SELECT` joins
organization, staff → candidate, invoice snapshot and every line item, so large pages are
expensive.

## Fix applied on 2026-09-17

`fetchAdminCommissions` (`_lib/commission-api.ts`) now walks every page and concatenates
the results, stopping on a short page or once `pagination.total` is reached, with a
`MAX_PAGES` guard. At 211 commissions this is 3 requests instead of 1.

Covered by `_tests/commission-api.test.ts`: the 211-record case, single short page, a full
page that exactly matches `total`, a response with no `pagination` block, and a failing
page.

This restores correctness but keeps the underlying "download everything, filter in the
browser" design.

## Proper fix (backlog) — server-side search and pagination

The current approach scales linearly with total commissions, on every page load. At 211
records it is 3 requests; at 2,000 it is 20 requests and a multi-megabyte payload built
from joins that the user mostly never looks at.

1. Move filtering to the backend. `ListCommissionsDto` already supports `status`,
   `organization_id`, `affiliate_id`, `created_from`, `created_to`, `sortBy` and
   `sortOrder`. Add the predicates the UI filters on client-side today but the API does
   not accept — check `_lib/filters.ts` for the full set, including free-text search
   (organization name, affiliate name, collaborator/candidate name, invoice number) and
   any amount-range filter.
2. Add a real text search parameter (e.g. `q`) resolved server-side with Prisma
   `contains` / `mode: 'insensitive'` across the joined organization, affiliate and
   candidate names, plus `invoice_number`. Never `$queryRawUnsafe` with this input.
3. Paginate the table for real: send `page`/`limit` from the UI, render
   `pagination.total`, and drop the fetch-all loop once this lands.
4. Decide what the Kanban board shows. It is inherently "all rows grouped by status", which
   conflicts with pagination. Options: per-column counts from a `groupBy` aggregate plus a
   capped page of cards per column (with "show more"), or restrict the board to actionable
   statuses (`detected`, `pending_admin_confirmation`, `eligible`) and leave history to the
   paginated table.
5. Trim the list payload. The board and table do not need every invoice line item; keep the
   heavy `COMMISSION_SELECT` joins for `findOneForAdmin` and give the list a lighter
   projection.
6. Add an index supporting the default ordering and common filters
   (e.g. `(status, createdAt desc)`, `(affiliate_id, createdAt desc)`) once the filter set
   is settled.
7. Add service tests for each new filter and for pagination boundaries, per the ≥80%
   coverage threshold.

## Related code

- `src/med-alliance/commissions/commissions.service.ts:218-265` — `findAllForAdmin`
- `src/med-alliance/commissions/dto/list-commissions.dto.ts:23-103` — filters, `@Max(100)`
- `src/med-alliance/commissions/commissions.service.ts:41-120` — `COMMISSION_SELECT`,
  `PAYOUT_LINKAGE_SELECT`
- frontend `_lib/commission-api.ts` — paginating fetch (fix applied here)
- frontend `_components/commissions-view.tsx:88-165` — client-side grouping and filtering
- frontend `_lib/filters.ts` — the client-side predicates to migrate server-side

## Same bug elsewhere (not yet fixed)

The affiliate-facing commission views call `GET /med-alliance/commissions` with **no
`limit`**, so they take the DTO default of 20 (`list-commissions.dto.ts:42`) and silently
drop everything after the 20 most recent rows:

- `src/app/med-alliance/my-commissions/page.tsx:173`
- `src/app/med-alliance/my-commissions/page_kanban.tsx:306`
- `src/app/modules/alliance/partner/earnings/page.tsx:101`

This is more severe than the admin case — the reported affiliate has 138 commissions, so
an affiliate reviewing their own earnings sees roughly 15% of them. Worth confirming
against the UI and fixing in the same pass; `findAllForAffiliate`
(`commissions.service.ts:162-198`) has the same shape as the admin method.

Also single-page `limit=100` fetches, same pattern, lower risk today:

- `src/app/modules/alliance/admin/pipeline/_lib/pipeline-api.ts:45` (audit logs)

`associate-company-dialog.tsx:253` already loops through pages correctly and can serve as
the in-repo reference.
