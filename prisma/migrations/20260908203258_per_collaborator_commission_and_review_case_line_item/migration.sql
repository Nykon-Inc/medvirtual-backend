-- Per-collaborator commission + line-item-scoped review cases
-- See spec doc: backend/docs/specs-bugs/med-alliance-per-collaborator-commission.md

-- =============================================================================
-- HubspotLineItemSnapshot: add per-collaborator matching columns
-- =============================================================================
ALTER TABLE "HubspotLineItemSnapshot"
  ADD COLUMN "staff_id" TEXT,
  ADD COLUMN "match_status" TEXT,
  ADD COLUMN "matched_by" TEXT;

CREATE INDEX "idx_hubspot_line_item_snapshots_staff_id"
  ON "HubspotLineItemSnapshot"("staff_id");

CREATE INDEX "idx_hubspot_line_item_snapshots_match_status"
  ON "HubspotLineItemSnapshot"("match_status");

ALTER TABLE "HubspotLineItemSnapshot"
  ADD CONSTRAINT "HubspotLineItemSnapshot_staff_id_fkey"
  FOREIGN KEY ("staff_id") REFERENCES "Staff"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- AffiliateCommission: add line-item/staff linkage, move uniqueness to line-item level
-- =============================================================================
ALTER TABLE "AffiliateCommission"
  ADD COLUMN "hubspot_line_item_snapshot_id" TEXT,
  ADD COLUMN "staff_id" TEXT;

-- Drop the old invoice-level uniqueness — commission is now computed per line item,
-- not per whole invoice (one invoice can now yield several commissions).
ALTER TABLE "AffiliateCommission"
  DROP CONSTRAINT IF EXISTS "uq_affiliate_commissions_invoice_snapshot";

-- New uniqueness at line-item level. Existing rows have NULL here (legacy, pre-migration
-- commissions) — Postgres treats multiple NULLs as distinct for unique indexes, so this
-- is safe against existing data without a backfill.
CREATE UNIQUE INDEX "uq_affiliate_commissions_line_item_snapshot"
  ON "AffiliateCommission"("hubspot_line_item_snapshot_id");

CREATE INDEX "idx_affiliate_commissions_staff_id"
  ON "AffiliateCommission"("staff_id");

CREATE INDEX "idx_affiliate_commissions_invoice_snapshot_id"
  ON "AffiliateCommission"("hubspot_invoice_snapshot_id");

ALTER TABLE "AffiliateCommission"
  ADD CONSTRAINT "AffiliateCommission_hubspot_line_item_snapshot_id_fkey"
  FOREIGN KEY ("hubspot_line_item_snapshot_id") REFERENCES "HubspotLineItemSnapshot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AffiliateCommission"
  ADD CONSTRAINT "AffiliateCommission_staff_id_fkey"
  FOREIGN KEY ("staff_id") REFERENCES "Staff"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- MedAllianceAdminReviewCase: scope open-case uniqueness to a specific line item
-- =============================================================================
ALTER TABLE "MedAllianceAdminReviewCase"
  ADD COLUMN "hubspot_line_item_snapshot_id" TEXT;

-- Replace the old (organization_id, reason_code, status) unique constraint with one that
-- also includes hubspot_line_item_snapshot_id — org-scoped reason codes (line item = NULL)
-- keep today's single-open-case-per-reason behavior (NULLs are distinct per row in Postgres,
-- so this only relaxes the constraint for line-item-scoped reason codes, it never tightens
-- it for the existing ones).
ALTER TABLE "MedAllianceAdminReviewCase"
  DROP CONSTRAINT IF EXISTS "uq_open_review_case";

CREATE UNIQUE INDEX "uq_open_review_case" ON "MedAllianceAdminReviewCase"(
  "organization_id", "reason_code", "status", "hubspot_line_item_snapshot_id"
);

CREATE INDEX "idx_review_cases_line_item"
  ON "MedAllianceAdminReviewCase"("hubspot_line_item_snapshot_id");

ALTER TABLE "MedAllianceAdminReviewCase"
  ADD CONSTRAINT "MedAllianceAdminReviewCase_hubspot_line_item_snapshot_id_fkey"
  FOREIGN KEY ("hubspot_line_item_snapshot_id") REFERENCES "HubspotLineItemSnapshot"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- =============================================================================
-- Enum additions
-- =============================================================================
ALTER TYPE "MedAllianceEntityType" ADD VALUE IF NOT EXISTS 'review_case';
ALTER TYPE "AdminReviewReasonCode" ADD VALUE IF NOT EXISTS 'unmatched_line_item';
ALTER TYPE "AdminReviewReasonCode" ADD VALUE IF NOT EXISTS 'ambiguous_line_item';
