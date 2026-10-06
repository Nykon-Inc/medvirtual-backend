-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "first_available_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "idx_candidates_first_available_at" ON "Candidate"("first_available_at");

-- Backfill the first entry into the available pool (stages 261075105 Full-Time / 1087596819 Part-Time).
-- Pipeline history only exists since CandidateAuditLog started, so:
--   1. logged as created directly in an available stage           -> Candidate.createdAt
--   2. created before the audit log began, with any sign of having
--      been in the pool (no earlier history to consult)           -> Candidate.createdAt
--   3. otherwise, first logged move into an available stage       -> that log's createdAt
--   4. no log, but in the pool now / has an available origin       -> Candidate.createdAt
-- Candidates with no evidence of ever being available stay NULL.
WITH audit_start AS (
  SELECT MIN("createdAt") AS started_at FROM "CandidateAuditLog"
),
first_entry AS (
  SELECT "candidate_id", MIN("createdAt") AS entered_at
  FROM "CandidateAuditLog"
  WHERE "event" = 'pipeline_status_changed'
    AND "pipeline_status_new" IN ('261075105', '1087596819')
  GROUP BY "candidate_id"
),
created_available AS (
  SELECT DISTINCT "candidate_id"
  FROM "CandidateAuditLog"
  WHERE "event" = 'candidate_created'
    AND "after"->>'pipeline_status' IN ('261075105', '1087596819')
),
backfill AS (
  SELECT
    c."id",
    CASE
      WHEN ca."candidate_id" IS NOT NULL THEN c."createdAt"
      WHEN (s.started_at IS NULL OR c."createdAt" < s.started_at)
        AND (
          c."pipeline_status" IN ('261075105', '1087596819')
          OR c."pipeline_status_origin" IN ('261075105', '1087596819')
          OR fe."candidate_id" IS NOT NULL
        ) THEN c."createdAt"
      WHEN fe."candidate_id" IS NOT NULL THEN fe.entered_at
      WHEN c."pipeline_status" IN ('261075105', '1087596819')
        OR c."pipeline_status_origin" IN ('261075105', '1087596819') THEN c."createdAt"
    END AS first_available_at
  FROM "Candidate" c
  CROSS JOIN audit_start s
  LEFT JOIN first_entry fe ON fe."candidate_id" = c."id"
  LEFT JOIN created_available ca ON ca."candidate_id" = c."id"
)
UPDATE "Candidate" c
SET "first_available_at" = b.first_available_at
FROM backfill b
WHERE b."id" = c."id"
  AND b.first_available_at IS NOT NULL;
