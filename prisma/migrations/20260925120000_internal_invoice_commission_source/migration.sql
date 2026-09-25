-- CreateEnum
CREATE TYPE "InvoiceSource" AS ENUM ('hubspot', 'internal');

-- AlterTable
ALTER TABLE "HubspotInvoiceSnapshot" ADD COLUMN     "internal_invoice_id" TEXT,
ADD COLUMN     "source" "InvoiceSource" NOT NULL DEFAULT 'hubspot',
ALTER COLUMN "hubspot_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "HubspotLineItemSnapshot" ADD COLUMN     "internal_line_item_id" TEXT,
ADD COLUMN     "internal_line_key" TEXT,
ADD COLUMN     "line_category" TEXT,
ADD COLUMN     "removed_at" TIMESTAMP(3),
ADD COLUMN     "source" "InvoiceSource" NOT NULL DEFAULT 'hubspot',
ALTER COLUMN "hubspot_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "AffiliateCommission" ADD COLUMN     "source" "InvoiceSource" NOT NULL DEFAULT 'hubspot';

-- CreateIndex
CREATE UNIQUE INDEX "HubspotInvoiceSnapshot_internal_invoice_id_key" ON "HubspotInvoiceSnapshot"("internal_invoice_id");

-- CreateIndex
CREATE INDEX "idx_hubspot_invoice_snapshots_source" ON "HubspotInvoiceSnapshot"("source");

-- CreateIndex
CREATE UNIQUE INDEX "uq_hubspot_line_item_snapshots_internal_key" ON "HubspotLineItemSnapshot"("invoice_id", "internal_line_key");

-- CreateIndex
CREATE INDEX "idx_affiliate_commissions_source" ON "AffiliateCommission"("source");

-- AddForeignKey
ALTER TABLE "HubspotInvoiceSnapshot" ADD CONSTRAINT "HubspotInvoiceSnapshot_internal_invoice_id_fkey" FOREIGN KEY ("internal_invoice_id") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubspotLineItemSnapshot" ADD CONSTRAINT "HubspotLineItemSnapshot_internal_line_item_id_fkey" FOREIGN KEY ("internal_line_item_id") REFERENCES "InvoiceLineItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- HubSpot-sourced rows must keep their HubSpot id: every HubSpot webhook/sync path looks
-- snapshots up by hubspot_id. (internal_invoice_id is not enforced for internal rows because
-- its FK is ON DELETE SET NULL.)
ALTER TABLE "HubspotInvoiceSnapshot" ADD CONSTRAINT "chk_hubspot_invoice_snapshots_source_ref" CHECK ("source" <> 'hubspot' OR "hubspot_id" IS NOT NULL);
ALTER TABLE "HubspotLineItemSnapshot" ADD CONSTRAINT "chk_hubspot_line_item_snapshots_source_ref" CHECK ("source" <> 'hubspot' OR "hubspot_id" IS NOT NULL);
