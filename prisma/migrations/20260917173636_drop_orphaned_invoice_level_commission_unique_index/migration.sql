-- The old invoice-level uniqueness was created via CREATE UNIQUE INDEX (not ADD
-- CONSTRAINT), so it was never registered in pg_constraint. The migration that
-- superseded it with per-line-item uniqueness used DROP CONSTRAINT IF EXISTS,
-- which only looks at pg_constraint — it silently no-op'd, leaving this index alive
-- and blocking any second AffiliateCommission for the same invoice.
DROP INDEX IF EXISTS "uq_affiliate_commissions_invoice_snapshot";
