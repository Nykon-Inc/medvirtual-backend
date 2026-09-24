# QA Guide — UPS HR active-staff validation

Manual test checklist for exercising the fix end-to-end, as a real user would. This
complements the automated specs (which prove the code is correct in isolation) — it
proves the *behavior* is correct when a person clicks through it.

Each scenario has **Setup**, **Steps**, **Expected result**, and a **How to reset** note
so it can be re-run. Roles needed: `system_admin` / `system_super_admin` for the admin
create flow (scenarios 1–3), an `organization_admin` client user for the offer-panel
accept flow (scenario 4), and direct HubSpot ticket access for scenario 5. See also:
[ups-hr-active-staff-validation.md](./ups-hr-active-staff-validation.md) for the full
technical explanation of the rule.

---

## 1. Former client, no active VA → regular hire request (the reported bug)

**Setup**: Find or create a client organization that has at least one `Staff` row, but
**all** of them are `inactive` or `terminated` (no `active` staff). This is the exact
scenario from the bug report — a client who *used to* have a VA.

**Steps**:
1. As a system admin, open **Hire Requests → Create Hire Request** and select this
   client.
2. In the pairing-type step, try to select **"Upsell Agent"** (or note that the sheet
   auto-selects it based on the client's staff — see the sheet's own conditional logic).
3. Fill in the rest of the required fields and click **Create**.

**Expected result**: The hire request is created successfully. Its title does **not**
start with `UPS` — it reads `HR - ...` (or `TEST HR - ...` outside production), not
`UPS HR - ...`. An info toast appears in addition to the success toast, explaining that
the request was created as a regular hire request because the client has no active VA.
Open the created hire request afterwards and confirm `hubspot_pairing_request_type` is
not `"Upsell Agent"`.

**How to reset**: Delete/cancel the created hire request; no other state changes.

---

## 2. Client with an active VA → Upsell still works normally

**Setup**: A client organization with at least one `Staff` row whose `status` is
`active`.

**Steps**:
1. As a system admin, create a hire request for this client with pairing type
   **"Upsell Agent"**.

**Expected result**: The title starts with `UPS HR - ...` (or `UPS TEST HR - ...`
outside prod). No info toast about a downgrade appears — only the normal success toast.
`hubspot_pairing_request_type` on the created record is `"Upsell Agent"`.

**How to reset**: Delete/cancel the created hire request.

---

## 3. Agent Replacement is unaffected by staff status

**Setup**: A client organization, active staff or not — doesn't matter for this
scenario.

**Steps**:
1. Create a hire request with pairing type **"Agent Replacement"** for this client.

**Expected result**: The title starts with `REP HR - ...` (or `REP TEST HR - ...`)
regardless of the client's active-staff status. No downgrade toast appears — this rule
only targets the "Upsell Agent" misclassification.

**How to reset**: Delete/cancel the created hire request.

---

## 4. Offer panel accepted after the client's VA was terminated

**Setup**: Send an offer panel to a client organization login. Before the client accepts
it, terminate (or deactivate) the client's only active `Staff` row, so the org now has
zero active staff.

**Steps**:
1. Log in as that client user.
2. Open the pending offer panel and click **Accept & request interview**, then confirm in
   the dialog.

**Expected result**: The accept succeeds and a hire request is created. An info toast
appears alongside the normal "Accepted — interview requested." success toast, explaining
the classification wasn't applied due to no active VA. The resulting hire request's title
has no `UPS` prefix.

**How to reset**: Decline/delete the resulting hire request and offer panel state as
needed; reactivate the `Staff` row if reusing the same org for scenario 2.

---

## 5. Stale "Upsell Agent" is corrected when the title resyncs (webhook path)

This is the scenario closest to the original bug report's root cause: the classification
was set correctly in the past, then went stale.

**Setup**: Find a hire request whose `hubspot_pairing_request_type` is `"Upsell Agent"`
in the database (title currently shows `UPS HR - ...`). Ensure the client organization
now has **zero** active staff (terminate/deactivate them if needed). Note the
HubSpot ticket id linked to this hire request.

**Steps**:
1. In HubSpot, open that ticket and change any title-affecting property — the simplest
   is to toggle **"Number of VAs"** to a different value and save (this is enough to
   trigger the webhook without needing to touch the pairing-type property itself).
2. Wait for the webhook to process (usually near-instant; check the app for the updated
   title).

**Expected result**: The hire request's title no longer has the `UPS` prefix — it
updates to a regular `HR - ...` / `TEST HR - ...` title reflecting the new field value.
`hubspot_pairing_request_type` in the database is no longer `"Upsell Agent"`. The
ticket's `subject` in HubSpot itself is also updated to the corrected title (the webhook
handler PATCHes it back).

**How to reset**: N/A — this proves the fix is self-correcting; there's nothing to
reverse other than restoring the original field value in HubSpot if you want to re-run.

---

## 6. Batch title-repair cron corrects stale titles in bulk

**Setup**: One or more hire requests with `hubspot_pairing_request_type: "Upsell Agent"`
and titles that look "unfinished" (fewer than 5 ` - `-separated segments — e.g. missing
availability), belonging to organizations with zero active staff. (The cron only touches
hire requests whose title doesn't already look fully formed — see **Note** below if your
test hire request's title already has 5 segments.)

**Steps**:
1. Trigger the cron (`syncHireRequestTitles`) — via its scheduled run, or by hitting
   whatever admin/cron endpoint exposes it in this environment.
2. Re-check the affected hire request(s).

**Expected result**: Titles for the affected organizations no longer carry the `UPS`
prefix, and `hubspot_pairing_request_type` is corrected in the database. A
`HubspotAuditLog` entry exists for each corrected hire request with
`payload.reason = "upsell_downgrade_no_active_staff"` and `source = "cron"` — check via
the HubSpot audit log listing endpoint/admin screen, filtered to `entity_type =
hire_request`.

**Note**: The cron intentionally skips hire requests whose title already has 5+
` - `-separated segments (it assumes those are already fully formed). If your test hire
request's title already looks complete, force a re-check either by clearing/shortening
its `title` directly in the database first, or by using scenario 5's webhook path
instead, which always re-validates regardless of the current title's shape.

**How to reset**: N/A — same self-correcting behavior as scenario 5, just applied in
batch.

---

## 7. Audit trail is queryable end-to-end

**Setup**: At least one downgrade already produced from any of scenarios 1, 4, 5, or 6
above.

**Steps**:
1. Open the HubSpot audit log admin screen (or call the audit log listing endpoint
   directly), and filter/search for `entity_type = hire_request` and the text
   `upsell_downgrade_no_active_staff`.

**Expected result**: One row per downgrade event, each showing: the hire request id
(`entity_id`), the source (`user_action` for the create/accept flows, `webhook` for the
HubSpot resync, `cron` for the batch job), and a payload containing
`requested_pairing_request_type: "Upsell Agent"`, `resolved_pairing_request_type: null`,
and the organization id. This is the durable record of "this classification was
rejected, and why" — it should not require reading application logs to find.

**How to reset**: N/A — this is an append-only log; re-running any of the scenarios above
produces additional entries, not deduplicated.
