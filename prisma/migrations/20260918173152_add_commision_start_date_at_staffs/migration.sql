-- DropIndex
DROP INDEX "MedAllianceAdminReviewCase_organization_id_reason_code_stat_key";

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "hubspot_commission_start_date" TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "uq_open_review_case" RENAME TO "MedAllianceAdminReviewCase_organization_id_reason_code_stat_key";
