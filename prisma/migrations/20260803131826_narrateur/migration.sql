-- AlterTable
ALTER TABLE "stories" ADD COLUMN     "narrator_id" TEXT;

-- AddForeignKey
ALTER TABLE "stories" ADD CONSTRAINT "stories_narrator_id_fkey" FOREIGN KEY ("narrator_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;
