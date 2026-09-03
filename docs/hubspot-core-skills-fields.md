# Core Skills Fields — HubSpot Types & Filter Mapping

**Date:** 2026-09-01
**HubSpot object:** `p20630393_Virtual_Assistant` (custom object)
**HubSpot property group:** `med/berry_ta_score_card`

## Objective

Document, field by field, the **real HubSpot type** of every Core Skills property synced into the platform, and how each one maps onto the `core_skills_fields` filter (`GET /candidates?core_skills_fields=field:value,...`, system_admin/system_super_admin only).

This exists because the first Core Skills implementation assumed every skill was a `0-10` rating. It isn't — HubSpot has 6 non-rating fields typed as `booleancheckbox`, `enumeration/select`, or free `number`, confirmed by querying `GET https://api.hubapi.com/crm/v3/properties/p20630393_Virtual_Assistant` directly and cross-checking against 6 screenshots of the real HubSpot sidebar (Bookkeeping, Medical/Dental Admin, Medical/Dental Biller, Sales Executive, SDR, Sales & Account Manager).

All fields — rating, boolean, select, or free-text — are stored in Postgres as `String?` on the `Candidate` model, exactly like the pre-existing VA Score Card fields (`speaks_clearly_and_professionally`, `tier_level`, etc.). HubSpot always sends property values as strings over the API, so this is the correct storage type regardless of the field's semantic type; only the **UI control** and the **filter value domain** differ per field.

---

## The 6 sections

Each section corresponds to one specialty "gate" boolean in HubSpot (`bookkeeping`, `medical__dental_admin`, `medical__dental_biller`, `sales_executive`, `sales_development_representative_sdr`, `sales__account_manager`), which is not itself filterable — the section's skills are gated implicitly by having been scored at all. Every section also has a `total_score_*`/`notes_*` pair; **`notes_*` fields are free-text evaluator notes and are excluded from `core_skills_fields` in every section** (documented per-section below, and enforced by `CORE_SKILLS_FIELDS`/`CORE_SKILLS_GROUPS` simply never listing them).

### 1. Bookkeeping Core Skills

All 19 fields are `type: number` in HubSpot (rated 0-10) — no non-rating fields in this section.

`quickbooks`, `other_accounting_software`, `chart_of_accounts_setup___maintenance`, `transaction_categorization`, `bank__credit_card_reconciliations`, `accounts_payable_ap`, `accounts_receivable_ar`, `payroll_posting__reconciliation_not_processing_unless_required`, `payroll_posting`, `monthend_close`, `journal_entries__adjustments`, `balance_sheet`, `pl`, `accrual_vs_cash_understanding`, `prepare_books_for_cpatax_handoff`, `client_communication`, `account_reconciliation`, `financial_analysis`, `financial_reporting`

Excluded: `notes_bookkeeping` (`type: string`, `fieldType: textarea`).

### 2. Medical/Dental Core Skills (Admin)

All 8 fields are `type: number` — no non-rating fields in this section.

`patient_scheduling__calendar_management`, `insurance_verification_eligibility__benefits`, `prior_authorizations__referrals`, `inbound_call_handling__patient_support`, `outbound_calls_recalls_noshows_followups`, `emrehr_data_entry__chart_updating`, `patient_intake__demographics_documentation_accuracy`, `referrals_sending_receiving_tracking`

Excluded: `notes_medical__dental_admin` (`type: string`, `fieldType: textarea`).

### 3. Medical/Dental Core Skills (Biller)

This is the only section with non-rating fields. **9 rating fields** (`type: number`):

`cpt__icd10_coding`, `charge_entry`, `claim_generation`, `claim_submission`, `denial_management`, `insurance_followup`, `ar_management`, `payment_posting`, `identifying_underpayments`

**6 non-rating fields**, each mapped to a filter control that mirrors its real HubSpot type:

| Field | HubSpot `type` / `fieldType` | HubSpot options | Filter UI |
|---|---|---|---|
| `n2_years_healthcare_billing_experience` | `bool` / `booleancheckbox` | `true`, `false` | Yes/No select |
| `total_years_on_healthcare_billing_experience` | `number` / `number` | — (free number, not 0-10) | Numeric select, bounded 0-20 (no HubSpot-documented cap; 20 is a practical UI bound, not a HubSpot constraint) |
| `patient_phone_communication` | `enumeration` / `select` | `Hesitant / Poor Tone`, `Inconsistent / Needs Improvement`, `Clear but Neutral`, `Professional and Reassuring`, `Confident / Empathetic` | Select with the 5 literal option labels as values |
| `role_type` | `enumeration` / `select` | `Standard`, `Full-Cycle Biller` | Select with the 2 literal option labels as values |
| `insurance_verification_knowledge` | `enumeration` / `select` | `true`, `false` (stored as text, not `booleancheckbox`) | Yes/No select |
| `prior_authorizations_experience` | `enumeration` / `select` | `true`, `false` (stored as text, not `booleancheckbox`) | Yes/No select |

Excluded: `notes_medical__dental_biller` (`type: string`, `fieldType: textarea`).

### 4. Sales Core Skills (Sales Executive)

All 6 fields are `type: number` — no non-rating fields.

`consultative_selling`, `fullcycle_sales`, `objection_handling__negotiation`, `virtual_demos__presentations`, `pipeline_management`, `closing_sales`

Excluded: `notes_sales_executive` (`type: string`, `fieldType: textarea`).

### 5. Sales Core Skills (SDR)

All 6 fields are `type: number` — no non-rating fields.

`lead_research__qualification`, `crm_proficiency`, `outbound_prospecting_emaillvcalls`, `cold_calling`, `appointment_setting`, `kpi_awareness__tracking`

Excluded: `notes_sales_development_representative_sdr` (`type: string`, `fieldType: textarea`).

### 6. Sales Core Skills (Sales & Account Manager)

All 5 fields are `type: number` — no non-rating fields.

`client_relationship_management`, `retention_strategy`, `upsell__crosssell`, `account_onboarding`, `issue_resolution`

Excluded: `notes_sales__account_manager` (`type: string`, `fieldType: textarea`).

---

## Filter semantics

`core_skills_fields` is always an **exact match** (`equals`, not "≥"), regardless of field type:

- Rating field: `quickbooks:5` → candidates with `quickbooks === "5"`.
- Boolean-like field: `n2_years_healthcare_billing_experience:true` → candidates with that field `=== "true"`.
- Select field: `role_type:Full-Cycle Biller` → candidates with `role_type === "Full-Cycle Biller"`.

All values are compared as strings on the Postgres side (`{ [field]: { equals: String(value) } }`), matching how HubSpot always serializes property values as strings.

---

## Where this is implemented

| Layer | File | What it holds |
|---|---|---|
| DB schema | `prisma/schema.prisma` | All 71 fields as `String?` on `Candidate` |
| HubSpot → DB sync mapping | `src/common/dictionaries/candidate-dictionary.ts` | 1:1 `candidadeToDbDictionary` entries |
| Filter allowlist | `src/candidate/candidates.service.ts` (`CORE_SKILLS_FIELDS`) | All 59 filterable fields (53 ratings + 6 non-rating), across `findAll`/`findAllForAlliance` |
| Sync allowlist | `src/candidate/candidates.service.ts` (`CORE_SKILLS_SYNC_FIELDS`) | Superset of `CORE_SKILLS_FIELDS` — also includes gates, `total_score_*`, and `notes_*` (read/synced but never filterable) |
| Role gate | `src/candidate/candidates.service.ts` (`CORE_SKILLS_FILTER_ROLES`) | `system_admin`, `system_super_admin` — mirrors the frontend's `showAdminFilters` |
| Frontend filter groups + UI shape | `frontend/src/app/modules/_shared/lib/talent-pool-core-skills-groups.ts` | `{ key, label, max: 10 }` for ratings, `{ key, label, options: [...] }` for non-rating fields |
| Frontend filter UI | `frontend/src/app/modules/_shared/components/talent-pool-filter-fields.tsx` | Renders a `<Select>` per field — numeric 0-10 or `options`-driven, chosen by field shape |

`notes_*` fields are never added to `CORE_SKILLS_FIELDS` or `CORE_SKILLS_GROUPS` — they are intentionally sync/read-only across every section, in every layer above.
