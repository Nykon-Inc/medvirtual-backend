# Bug: hire requests were classified "UPS HR" without an active VA

## Summary

Business rule: a hire request should only be classified as an **Upsell** ("UPS " title
prefix) when the client has **at least one active VA** currently associated with their
account. If the client has no active VA — because they're a brand-new client, or a former
client whose only VA was terminated — the hire request must be treated as a regular hire
request, with no "UPS" prefix.

A hire request was reported with a "UPS HR" title for a client whose only previously
associated VA was inactive. The classification was stale: it had been set correctly (or
came in from an external source) at some point in the past, and nothing ever re-validated
it against the client's *current* staff before the title was built or rebuilt.

## Root cause

The "UPS" (and "REP", for Agent Replacement) prefix is decided by one pure, synchronous
function:

```ts
// backend/src/common/utils/hireRequestTitle.util.ts
export function buildHireRequestTitle(hr: HireRequestTitleLike): string {
  const requestType = hr.hubspot_pairing_request_type || '';
  const firstPrefix =
    requestType === 'Upsell Agent' ? 'UPS '
    : requestType === 'Agent Replacement' ? 'REP '
    : '';
  // ...assembles "<prefix><HR|TEST HR> - <org> - <numberVA> - <role> - <availability>"
}
```

`buildHireRequestTitle` never queries the database — it just formats whatever
`hubspot_pairing_request_type` it's handed. All the correctness lives in **who calls it**
and **what they pass**. Before this fix, `hubspot_pairing_request_type` was set or read
in four different places, and only one of them validated it against the client's actual
active staff:

| # | Call site | Validated active staff before this fix? |
|---|---|---|
| 1 | `offer-panels.service.ts::acceptByClientUser` (offer panel accepted by a client) | ✅ Yes — already computed `staff.count(...)` inline |
| 2 | `hubspot/handlers/ticketPropertyChange.ts::syncTitle` (HubSpot webhook — fires when `pairing_request_type`, `availability`, or `number_of_vas` change on the ticket) | ❌ No — re-read whatever was already persisted |
| 3 | `cron/cron.service.ts::syncHireRequestTitles` (batch title-repair job, with its own **duplicated copy** of the title-building logic) | ❌ No — same pattern |
| 4 | `hire-request/hire-request.service.ts::create` (hire request created via the app) | ❌ No — used `hubspot_pairing_request_type` exactly as sent by the frontend, which itself only computes it from the staff list loaded when the form opened |

Because `hubspot_pairing_request_type` is stored on `HireRequest` and never
automatically recomputed, it goes stale the moment the client's staffing situation
changes:

- A client is upsold ("Upsell Agent" is set, `HireRequest` created, title shows "UPS").
- Their VA is later terminated.
- Anything that later **rebuilds the title** — the HubSpot webhook (someone edits any
  title-affecting ticket property) or the nightly title-repair cron — reads the still-
  `'Upsell Agent'` value from the database and regenerates "UPS HR ..." again, even
  though the client no longer qualifies.
- The same class of bug can also originate purely in HubSpot: a human can edit the
  ticket's "Pairing Request Type" property directly, with no validation at all on that
  side either.

## Fix

Added a single shared utility (`backend/src/common/utils/organizationActiveStaff.util.ts`)
that is the one place in the codebase which defines "does this org have an active VA":

```ts
export const ACTIVE_STAFF_STATUS_FILTER = {
  status: { notIn: ['terminated', 'inactive'] },
  terminated_date: null,
};

export async function hasActiveStaff(
  prisma: PrismaService,
  organizationId: string | null | undefined,
): Promise<boolean> { /* Staff.count({ organization_id, ...ACTIVE_STAFF_STATUS_FILTER }) > 0 */ }

export function resolvePairingRequestType(
  requestedType: string | null | undefined,
  orgHasActiveStaff: boolean,
): string | null {
  // 'Upsell Agent' without active staff → downgraded to null (regular hire request).
  // Any other value (e.g. 'Agent Replacement', 'New Client') passes through unchanged.
}

export function isPairingTypeDowngraded(requestedType, resolvedType): boolean;
```

All four call sites now run the incoming/persisted `hubspot_pairing_request_type`
through `resolvePairingRequestType` — recomputing `hasActiveStaff` fresh each time —
before building or persisting a title:

1. **`offer-panels.service.ts`** — refactored to call the shared util instead of its own
   inline query (no behavior change; it was already correct, this just removes the
   duplicated logic).
2. **`ticketPropertyChange.ts::syncTitle`** — now re-validates on every webhook-triggered
   title rebuild. If the org has no active staff, `hubspot_pairing_request_type` is
   downgraded to `null` **in the database**, not just in the rebuilt title string, so the
   stale value can't resurface on the next resync.
3. **`cron.service.ts::syncHireRequestTitles`** — same downgrade logic, applied in batch.
   Active-staff status for all organizations in the batch is pre-aggregated with one
   `staff.groupBy(...)` call instead of querying per hire request (no N+1). The method's
   own duplicated copy of the title-building code was deleted in favor of importing the
   shared `buildHireRequestTitle`.
4. **`hire-request.service.ts::create`** — the app-originated creation flow now validates
   server-side too, instead of trusting whatever `hubspot_pairing_request_type` the
   frontend sent. If the frontend's own title (also sent by the client, per legacy
   behavior) would have carried a "UPS" prefix, the backend recomputes the title from
   scratch using `buildHireRequestTitle` so the displayed title matches the corrected
   classification.

### Traceability

Every time a downgrade actually happens (`'Upsell Agent'` → `null` for lack of active
staff), the acting service writes a `HubspotAuditLog` row via the existing
`HubspotAuditService`:

```ts
await hubspotAuditService.log({
  entityType: 'hire_request',
  entityId: <hire request id>,
  hubspotObjectType: 'ticket',
  hubspotObjectId: <hubspot ticket id, or null if none exists yet>,
  action: 'CREATE' | 'UPDATE',
  source: 'user_action' | 'webhook' | 'cron',
  success: true,
  payload: {
    reason: 'upsell_downgrade_no_active_staff',
    requested_pairing_request_type: 'Upsell Agent',
    resolved_pairing_request_type: null,
    organization_id: <org id>,
  },
});
```

These rows are visible in the existing HubSpot audit log admin screen, filterable by
`entity_type = hire_request` and searchable for `upsell_downgrade_no_active_staff`.

When the downgrade happens on the app-originated creation flow (`hire-request.service.ts
::create`), the API response for `POST /hire-request` also carries a `pairing_type_notice`
string:

```json
{
  "status": 201,
  "message": "Hire request created successfully",
  "data": {
    "id": "...",
    "hubspot_pairing_request_type": "New Client",
    "title": "TEST HR - Acme Health - 1 - RN - Full-Time",
    "pairing_type_notice": "This request was created as a regular hire request because the client has no active VA — the 'Upsell Agent' classification was not applied."
  }
}
```

`pairing_type_notice` is only present on that one response when a downgrade actually
happened; it's `undefined`/absent otherwise. The same field is added to the response of
`POST /offer-panels/:id/accept` for the equivalent client-facing flow. The frontend reads
this field and surfaces it as an info toast — see **Frontend** below.

## How `buildHireRequestTitle` works (full reference)

`backend/src/common/utils/hireRequestTitle.util.ts` — pure function, no I/O:

```
buildHireRequestTitle(hr) =
  [ <prefix><base>, <org name>, <numberVA>, <role type>, <availability> ]
    .filter(part is non-empty)
    .join(" - ")
```

**Base** (`<base>`): `"HR"` if `process.env.ENVIRONMENT === 'PROD'`, else `"TEST HR"`.

**Prefix** (`<prefix>`), from `hubspot_pairing_request_type`:

| `hubspot_pairing_request_type` | Prefix | Resulting title starts with |
|---|---|---|
| `'Upsell Agent'` | `"UPS "` | `UPS HR - ...` / `UPS TEST HR - ...` |
| `'Agent Replacement'` | `"REP "` | `REP HR - ...` / `REP TEST HR - ...` |
| anything else (`'New Client'`, `null`, `undefined`, any other string) | *(none)* | `HR - ...` / `TEST HR - ...` |

**Optional segments** — each is omitted (not left blank) when falsy/empty:
- Organization name (`organization.name`, trimmed).
- Number of VAs (`hubspot_numberVA`) — only included when truthy (a `0` is *dropped*, same
  as `null`/`undefined`).
- Role type (`hubspot_role_type`, trimmed).
- Availability (`availability`) — hyphen-split, each word capitalized (`"full-time"` →
  `"Full-Time"`), then trimmed; omitted if empty after formatting.

**Where it's called** (all under `backend/src/`):

| Call site | When it fires | Fed a validated `hubspot_pairing_request_type`? |
|---|---|---|
| `offer-panels/offer-panels.service.ts::acceptByClientUser` | A client accepts an offer panel → creates the `HireRequest` | ✅ via `resolvePairingRequestType` |
| `hubspot/handlers/ticketPropertyChange.ts::syncTitle` | HubSpot webhook fires for `pairing_request_type`, `availability`, or `number_of_vas` changing on the ticket | ✅ via `resolvePairingRequestType` |
| `cron/cron.service.ts::syncHireRequestTitles` | Manually-triggered batch job that repairs hire request titles that don't look fully formed (`title.split(' - ').length < 5`) | ✅ via `resolvePairingRequestType` (batched) |
| `hire-request/hire-request.service.ts::create` (title only, conditionally) | A hire request is created via the app | ✅ recomputed only when a downgrade occurred; otherwise the frontend-supplied title is kept as-is |

**Not covered by this function** (title supplied directly by the caller instead):
`hire-request.service.ts::create` normally uses the `title` sent in the request body
verbatim — the frontend computes the equivalent formula client-side
(`create-hr.ts::adminHrTitle`, admin creation flow) before submitting. This fix only makes
the backend override that title when it had to downgrade the classification server-side;
it does not change how the frontend builds titles for the happy path.

## Frontend

Two flows surface `pairing_type_notice` as a toast when the backend reports a downgrade:

- **Admin "Create Hire Request" sheet**
  (`src/app/modules/talent/admin/hire-requests/_components/admin-hire-request-create-sheet.tsx`)
  — after a successful `POST /hire-request`, shows `toast.info(created.pairing_type_notice)`
  in addition to the usual success toast, when present.
- **Client "Accept offer panel" card**
  (`src/app/modules/talent/client/_components/mv-offer-panel-dashboard-card.tsx`) — after
  a successful accept (`POST /offer-panels/:id/accept`), shows the same info toast when
  `pairing_type_notice` is present in the response.

`AdminHireRequest.pairing_type_notice` (optional field,
`src/app/modules/talent/admin/hire-requests/_lib/types.ts`) and
`acceptPanelAsClient()`'s return type
(`src/lib/offer-panels/offer-panels-service.ts`) both carry this field through from the
API response.

## Files changed

- `backend/src/common/utils/organizationActiveStaff.util.ts` (new) — `hasActiveStaff`,
  `resolvePairingRequestType`, `isPairingTypeDowngraded`, `ACTIVE_STAFF_STATUS_FILTER`.
- `backend/src/offer-panels/offer-panels.service.ts` — uses the shared util; returns
  `pairing_type_notice`; logs the downgrade.
- `backend/src/hubspot/handlers/ticketPropertyChange.ts` — `syncTitle` re-validates and
  persists the corrected `hubspot_pairing_request_type`; logs the downgrade.
- `backend/src/cron/cron.service.ts` — `syncHireRequestTitles` re-validates in batch (one
  `staff.groupBy`, no N+1); removed its duplicated title-building method; logs the
  downgrade per affected hire request.
- `backend/src/hire-request/hire-request.service.ts` — `create` re-validates
  server-side, recomputes the title when downgrading, returns `pairing_type_notice`, logs
  the downgrade.
- `frontend/src/app/modules/talent/admin/hire-requests/_lib/types.ts` — `pairing_type_notice`
  field on `AdminHireRequest`.
- `frontend/src/app/modules/talent/admin/hire-requests/_components/admin-hire-request-create-sheet.tsx`
  — shows the info toast.
- `frontend/src/lib/offer-panels/offer-panels-service.ts` — `acceptPanelAsClient()` return
  type carries `pairing_type_notice`.
- `frontend/src/app/modules/talent/client/_components/mv-offer-panel-dashboard-card.tsx`
  — shows the info toast.

See also: [ups-hr-active-staff-validation-qa-guide.md](./ups-hr-active-staff-validation-qa-guide.md).
