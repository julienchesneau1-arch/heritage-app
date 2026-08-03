-- CreateTable
CREATE TABLE "transcription_drafts" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "archive_id" TEXT NOT NULL,
    "requested_by_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "raw_text" TEXT,
    "segments" JSONB,
    "model" TEXT,
    "duration_seconds" DOUBLE PRECISION,
    "suspect_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "validated_by_id" TEXT,
    "validated_at" TIMESTAMP(3),
    "story_id" TEXT,

    CONSTRAINT "transcription_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transcription_drafts_archive_id_key" ON "transcription_drafts"("archive_id");

-- CreateIndex
CREATE UNIQUE INDEX "transcription_drafts_story_id_key" ON "transcription_drafts"("story_id");

-- CreateIndex
CREATE INDEX "transcription_drafts_family_id_status_idx" ON "transcription_drafts"("family_id", "status");

-- AddForeignKey
ALTER TABLE "transcription_drafts" ADD CONSTRAINT "transcription_drafts_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "archives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcription_drafts" ADD CONSTRAINT "transcription_drafts_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcription_drafts" ADD CONSTRAINT "transcription_drafts_validated_by_id_fkey" FOREIGN KEY ("validated_by_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcription_drafts" ADD CONSTRAINT "transcription_drafts_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
