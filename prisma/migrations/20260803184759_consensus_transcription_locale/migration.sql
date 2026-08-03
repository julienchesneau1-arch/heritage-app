-- AlterTable
ALTER TABLE "transcription_drafts" ADD COLUMN     "second_model" TEXT,
ADD COLUMN     "second_source" TEXT,
ADD COLUMN     "second_text" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'api';
