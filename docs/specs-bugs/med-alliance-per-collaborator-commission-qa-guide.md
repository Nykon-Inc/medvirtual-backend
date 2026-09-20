# QA Guide — Med Alliance per-collaborator commission

Manual test checklist for exercising the per-collaborator commission fix end-to-end, as a
real admin user. This complements the automated specs (which prove the code is correct in
isolation) — it proves the *behavior* is correct when a person clicks through it.

Each scenario has **Setup**, **Steps**, **Expected result**, and a **How to reset** note so
it can be re-run. Roles needed: `system_super_admin` or `finance_admin` for the admin
screens referenced below.

---

## 1. Two collaborators, two clocks

**Setup**: Pick (or create) a referred organization with an active affiliate. Ensure it
has two `Staff` (VA) placements in the same organization with different `start_date`s —
one recent (e.g. 30 days ago) and one old (e.g. 400+ days ago). Pay an invoice in HubSpot
for that company with one line item named after each collaborator (e.g. "Jane Doe" and
"John Smith"), then run the sync (`POST /med-alliance/admin/organizations/{id}/sync` or
wait for the scheduled sync).

**Steps**:
1. Open the admin Commissions page (`/med-alliance/admin/commissions` or the alliance
   module's commissions view) and filter to this organization.
2. Open the commission created for this invoice.

**Expected result**: Only **one** commission was created — for the recently-started
collaborator's line item — not two, and not one for the whole invoice. The commission
detail sheet shows the matched collaborator's name (in the "Commission" section header and
inside the expanded "Invoice Items" list) and the amount equals that specific line item's
amount × the affiliate's commission percent, not the invoice total.

**How to reset**: Delete the created `AffiliateCommission` row(s) for this invoice, or void
them via the admin UI, and re-run the sync.

---

## 2. Unmatched line item → review case → resolve → retroactive commission

**Setup**: Pay an invoice for a referred organization with a line item whose name does
**not** match any `Staff` in that organization (e.g. a garbled name, or a name for a
collaborator not yet in the system). Run the sync.

**Steps**:
1. Confirm no commission was generated for that line item (check the commissions list —
   nothing new for this invoice, or fewer commissions than line items).
2. Open the review dashboard (`/med-alliance/admin/review`).
3. Find the case grouped under **"Unmatched Collaborator Payment"**.
4. Click **Resolve**. In the dialog, leave "Link to a collaborator" selected, use the
   Staff picker to search and select the correct collaborator, fill in a reason, and
   confirm.
5. Re-run the sync (or wait for the next scheduled run).

**Expected result**: Before resolving, no commission exists for that line item. After
resolving with a manual link, the next sync generates the commission retroactively, at the
correct amount — nothing is silently lost, only delayed. The Staff picker's search results
are restricted to that organization's own collaborators (verify by checking it doesn't
show staff from other organizations).

**How to reset**: On the `HubspotLineItemSnapshot` row, clear `staff_id` and
`match_status` back to null, and delete/resolve-away the review case so it can reopen.

---

## 3. Ambiguous line item, "not a collaborator" resolution

**Setup**: Either (a) create a line item whose name matches 2+ `Staff` in the same
organization (e.g. two collaborators with very similar names), or (b) use a line item that
is actually a fee/discount/administrative charge, not a VA payment. Run the sync.

**Steps**:
1. Open the review dashboard, find the case under **"Ambiguous Collaborator Match"** (case
   a) or **"Unmatched Collaborator Payment"** (case b, since a fee won't match anyone).
2. Click **Resolve**, select **"Not a collaborator (fee, discount, or other line item)"**,
   fill in a reason, and confirm.
3. Re-run the sync.

**Expected result**: The line item is permanently excluded from the commission flow
(`match_status = 'not_applicable'`) — it must **not** reopen a review case on the next
sync, and must never generate a commission.

**How to reset**: Reset `match_status` to null on the line item.

---

## 4. Company eligibility is manual-only, gated on Deployed

**Setup**: Find (or create) a brand-new referred company that has not yet reached the
"Deployed" stage in the pipeline.

**Steps**:
1. Open the company's pipeline card or detail sheet
   (`/med-alliance/admin/pipeline` or the referred-company detail view). Confirm the
   "Confirm as eligible" / "Block (not eligible)" buttons are disabled or hidden.
2. Progress the company to "Deployed" (via a paid invoice / HubSpot `deploy_date_of_first_va`
   sync, or by waiting for the automatic detection to fire).
3. Confirm the Confirm/Block buttons are now enabled.
4. Click **"Confirm as eligible"**.
5. Wait (or simulate) more than 365 days past the company's `deployment_date` — re-run the
   sync, and separately try hitting `GET /cron/expire-stale-eligibility`.

**Expected result**: Step 1 — buttons unreachable pre-Deployed. Step 3 — reachable once
Deployed. Step 4 — status becomes `eligible`, purely from the click. Step 5 — the status
must **not** silently flip to `expired` from the sync pass or from hitting the cron route
(that route should return HTTP 410, doing nothing). The only way the status changes at all
is another explicit Confirm/Block click.

**How to reset**: Manually reset `Organization.med_alliance_referral_status` back to
`pending_confirmation` for repeat testing.

---

## 5. 365-day staff-level skip is logged

**Setup**: A `Staff` row with `start_date` more than 365 days in the past, with a matched,
paid invoice line item for that collaborator.

**Steps**:
1. Run the sync for that organization.
2. Confirm no commission was created for that line item.
3. Query the `MedAllianceAuditLog` table (or, if the audit trail is surfaced anywhere in
   the admin UI, check there) for an entry with
   `event = 'commission_skipped_staff_expired'`.

**Expected result**: An audit log entry exists linking the organization
(`entity_id`), the `HubspotInvoiceSnapshot` id, the `HubspotLineItemSnapshot` id, and the
`Staff` id, in its `metadata`. This is the durable record of "this payment was excluded,
and why" — it should not require reading application logs to find.

**How to reset**: N/A — this is an append-only log; re-running the sync produces one entry
per pass (not deduplicated) as long as the condition still holds.

---

## 6. Sync report reflects line-item outcomes

**Setup**: An organization with at least one unmatched or ambiguous line item pending from
the scenarios above.

**Steps**:
1. Trigger a full sync run (`GET /cron/sync-organizations-with-hubspot`, or wait for the
   scheduled run).
2. Open the resulting "Med Alliance — HubSpot Sync Report" email.

**Expected result**: The organization appears under the **"Needs Attention"** section, and
its row shows non-zero unmatched/ambiguous line-item counts in the "Line Items (matched /
unmatched / ambiguous)" column. The report's summary tiles at the top also reflect the
aggregated unmatched/ambiguous totals across all organizations.

**How to reset**: Resolve the underlying review case(s); the next report run should drop
the organization from "Needs Attention" once its unmatched/ambiguous counts are zero.

---

## 7. Single-VA company regression check

**Setup**: A referred organization with exactly one collaborator — the common case, and
the one most likely to silently regress from a per-collaborator rewrite.

**Steps**:
1. Pay an invoice for this company with a single line item for its one VA.
2. Run the sync.
3. Open the resulting commission in the admin commissions view.

**Expected result**: Behaves identically to before this fix — one commission, correct
amount, correct "Eligible from" date shown on the company's pipeline card — just now
provably anchored on the collaborator's own `Staff.start_date` rather than the company's
`deployment_date` (which, for a single-VA company, are normally the same date anyway).
Nothing about the majority of existing referrals should look different.

**How to reset**: N/A — this is a pure regression check, no state to reset beyond the
commission created in step 1–2.
