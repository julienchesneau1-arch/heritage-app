-- AlterTable
ALTER TABLE "members" ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "stories" ADD COLUMN     "search_text" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "story_mutes" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "story_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_mutes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "story_mutes_family_id_member_id_idx" ON "story_mutes"("family_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "story_mutes_story_id_member_id_key" ON "story_mutes"("story_id", "member_id");

-- AddForeignKey
ALTER TABLE "story_mutes" ADD CONSTRAINT "story_mutes_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_mutes" ADD CONSTRAINT "story_mutes_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
