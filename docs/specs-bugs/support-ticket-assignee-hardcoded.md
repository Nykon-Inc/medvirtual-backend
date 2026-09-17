# Backlog — Support ticket assignee is hardcoded in the frontend

**Status**: hotfix applied (2026-09-17), proper fix pending
**Area**: ticket creation (frontend `Support` flow + `TicketService.create`)

## Symptom

A support ticket opened by a client was assigned to the wrong system user. The assignee
was not chosen by the client, nor derived from the client's organization — it came from a
UUID hardcoded in the frontend bundle.

## Root cause

The frontend sends a fixed `assigned_user_id` on every `Support` ticket. The constant is
duplicated across four components:

- `src/components/ask-for-help-modal.tsx`
- `src/app/modules/profile/_components/ask-for-help-dialog.tsx`
- `src/components/create-ticket-modal.tsx`
- `src/app/modules/talent/admin/tickets/_components/ticket-create-sheet.tsx`

Each declares its own copy:

```ts
const PRODUCTION_SUPPORT_ASSIGNEE_ID = "<uuid>";
const STAGING_SUPPORT_ASSIGNEE_ID = "<uuid>";
```

The backend accepts it as-is. In `src/ticket/ticket.service.ts:316-323`, `Support` (and
`hire_request_cancellation`) skip the concierge resolution that every other ticket type
goes through, so the DTO value is written straight to `ticket.user_id`. The only check is
that the user exists (`ticket.service.ts:362-371`) — there is no verification that the
user is a system admin or belongs to the support team.

When the person behind that UUID changes role, leaves the support rotation, or the row is
replaced, every new support ticket keeps landing on them until someone edits and redeploys
the frontend.

## Hotfix applied on 2026-09-17

`PRODUCTION_SUPPORT_ASSIGNEE_ID` was updated to `767f3a67-1bc9-4444-9500-fd7fe393db3d` in
all four files. This restores correct routing but does not remove the underlying coupling.

## Proper fix (backlog)

Move assignee resolution to the backend and stop sending it from the client:

1. Remove `assigned_user_id` from the `Support` payload in the four frontend components,
   along with the production → staging → no-assignee retry cascade that exists only to
   work around the ID differing per environment. That cascade currently leaks a staging
   UUID into the production bundle and turns a misconfiguration into a silently
   unassigned ticket.
2. In `TicketService.create`, resolve the support assignee server-side. Two options:
   - a `SUPPORT_ASSIGNEE_ID` env var read through `ConfigService` (per-environment, no
     redeploy of the frontend to change it); or
   - the organization's `admin_id` (concierge), matching how the non-Support branch at
     `ticket.service.ts:331-342` already behaves.
3. Reject or ignore a client-supplied `assigned_user_id` on `Support` tickets for
   non-system-admin callers, so the assignee cannot be set from the browser.
4. Add a service test covering: Support ticket from an organization user gets the
   configured assignee, and a client-supplied `assigned_user_id` is not honored.

## Related code

- `src/ticket/ticket.service.ts:312-349` — assignee resolution branch
- `src/ticket/ticket.service.ts:362-371` — assignee existence check
- `src/notifications/notifications.service.ts:2084-2093` — separate issue: `paulo@regenta.ai`
  is added as a fixed recipient for every Support ticket, with no environment check, so
  production support notifications also go to that address. Worth folding into the same
  cleanup.
