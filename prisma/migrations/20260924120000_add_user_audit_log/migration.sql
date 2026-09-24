-- CreateEnum
CREATE TYPE "UserAuditSource" AS ENUM ('user', 'admin', 'system', 'cron', 'webhook');

-- CreateTable
CREATE TABLE "UserAuditLog" (
    "id" TEXT NOT NULL,
    "subject_user_id" TEXT,
    "subject_email" TEXT NOT NULL,
    "subject_label" TEXT,
    "subject_role" TEXT,
    "organization_id" TEXT,
    "organization_name" TEXT,
    "event" TEXT NOT NULL,
    "old_status" TEXT,
    "new_status" TEXT,
    "reason" TEXT,
    "source" "UserAuditSource" NOT NULL DEFAULT 'user',
    "actor_user_id" TEXT,
    "actor_label" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_user_audit_timeline" ON "UserAuditLog"("subject_user_id", "createdAt");

-- CreateIndex
CREATE INDEX "idx_user_audit_email" ON "UserAuditLog"("subject_email");

-- CreateIndex
CREATE INDEX "idx_user_audit_org" ON "UserAuditLog"("organization_id");

-- CreateIndex
CREATE INDEX "idx_user_audit_actor" ON "UserAuditLog"("actor_user_id");

-- CreateIndex
CREATE INDEX "idx_user_audit_event" ON "UserAuditLog"("event");

-- CreateIndex
CREATE INDEX "idx_user_audit_created_at" ON "UserAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "UserAuditLog" ADD CONSTRAINT "UserAuditLog_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "USER"("id") ON DELETE SET NULL ON UPDATE CASCADE;
