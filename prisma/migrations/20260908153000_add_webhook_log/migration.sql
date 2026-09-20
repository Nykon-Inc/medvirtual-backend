-- CreateEnum
CREATE TYPE "WebhookProvider" AS ENUM ('stripe');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('received', 'processing', 'processed', 'failed', 'ignored');

-- CreateTable
CREATE TABLE "WebhookLog" (
    "id" TEXT NOT NULL,
    "provider" "WebhookProvider" NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "provider_object_id" TEXT,
    "provider_object_type" TEXT,
    "api_version" TEXT,
    "livemode" BOOLEAN,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'received',
    "delivery_count" INTEGER NOT NULL DEFAULT 1,
    "replay_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "provider_created_at" TIMESTAMP(3),
    "processing_started_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "last_received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_replayed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookLog_provider_provider_event_id_key" ON "WebhookLog"("provider", "provider_event_id");

-- CreateIndex
CREATE INDEX "idx_webhook_log_provider_event_created" ON "WebhookLog"("provider", "event_type", "createdAt");

-- CreateIndex
CREATE INDEX "idx_webhook_log_status_created" ON "WebhookLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "idx_webhook_log_provider_object" ON "WebhookLog"("provider_object_id");
