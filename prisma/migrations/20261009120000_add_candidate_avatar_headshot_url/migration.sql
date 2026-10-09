-- AlterTable
ALTER TABLE "Candidate" ADD COLUMN     "avatar_headshot_url" TEXT;

-- Existing avatars are assumed to match the current headshot, so they are not
-- regenerated (and billed again) the next time the candidate becomes available.
UPDATE "Candidate"
SET "avatar_headshot_url" = "headshot_url"
WHERE "avatar_url" IS NOT NULL;
