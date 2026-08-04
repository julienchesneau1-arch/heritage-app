-- LE FIL — remplace `conversations` par `threads` + `messages`.
--
-- L'ancien modèle imposait deux verrous : une conversation ne pouvait naître
-- que d'un récit DÉJÀ ÉCRIT, et elle n'admettait qu'une seule réponse. La
-- page blanche gardait l'entrée du produit, et le troisième intervenant
-- n'avait nulle part où parler.
--
-- Cette migration TRANSPORTE les conversations existantes avant de détruire
-- quoi que ce soit : chaque conversation devient un fil accroché à son
-- récit, sa question devient le premier message, sa réponse le second.
-- Aucune parole de famille n'est perdue en route.

-- CreateTable
CREATE TABLE "threads" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "entity_id" TEXT,
    "story_id" TEXT,
    "title" TEXT,
    "opened_by_id" TEXT NOT NULL,
    "crystallized_story_id" TEXT,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "narrator_id" TEXT,
    "body" TEXT NOT NULL,
    "archive_id" TEXT,
    "is_question" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_marks" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_marks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "threads_crystallized_story_id_key" ON "threads"("crystallized_story_id");

-- CreateIndex
CREATE INDEX "threads_family_id_last_message_at_idx" ON "threads"("family_id", "last_message_at");

-- CreateIndex
CREATE INDEX "threads_entity_id_idx" ON "threads"("entity_id");

-- CreateIndex
CREATE INDEX "messages_thread_id_created_at_idx" ON "messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_family_id_idx" ON "messages"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_marks_message_id_member_id_kind_key" ON "message_marks"("message_id", "member_id", "kind");

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_crystallized_story_id_fkey" FOREIGN KEY ("crystallized_story_id") REFERENCES "stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_opened_by_id_fkey" FOREIGN KEY ("opened_by_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_narrator_id_fkey" FOREIGN KEY ("narrator_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_archive_id_fkey" FOREIGN KEY ("archive_id") REFERENCES "archives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_marks" ADD CONSTRAINT "message_marks_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_marks" ADD CONSTRAINT "message_marks_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Transport des conversations existantes ───

-- 1. Un fil par conversation, accroché au récit qui la portait.
INSERT INTO "threads" (
  "id", "family_id", "story_id", "opened_by_id", "crystallized_story_id",
  "message_count", "last_message_at", "created_at"
)
SELECT
  'thr_' || c."id",
  c."family_id",
  c."story_id",
  c."questioner_id",
  c."converted_to_story_id",
  CASE WHEN c."response_text" IS NULL THEN 1 ELSE 2 END,
  COALESCE(c."answered_at", c."created_at"),
  c."created_at"
FROM "conversations" c;

-- 2. La question devient le premier message.
INSERT INTO "messages" ("id", "thread_id", "family_id", "author_id", "body", "is_question", "created_at")
SELECT 'msg_q_' || c."id", 'thr_' || c."id", c."family_id", c."questioner_id", c."question_text", true, c."created_at"
FROM "conversations" c;

-- 3. La réponse devient le second, quand il y en a une.
INSERT INTO "messages" ("id", "thread_id", "family_id", "author_id", "body", "is_question", "created_at")
SELECT
  'msg_r_' || c."id", 'thr_' || c."id", c."family_id",
  COALESCE(c."responder_id", c."questioner_id"),
  c."response_text", false,
  COALESCE(c."answered_at", c."created_at")
FROM "conversations" c
WHERE c."response_text" IS NOT NULL;

-- 4. Filet : si une conversation n'a pas été transportée, on s'arrête ici
--    plutôt que de détruire la table. Une migration qui perd la parole
--    d'une famille est pire qu'une migration qui échoue.
DO $$
DECLARE restant INTEGER;
BEGIN
  SELECT count(*) INTO restant
  FROM "conversations" c
  WHERE NOT EXISTS (SELECT 1 FROM "threads" t WHERE t."id" = 'thr_' || c."id");
  IF restant > 0 THEN
    RAISE EXCEPTION 'Transport incomplet : % conversation(s) sans fil.', restant;
  END IF;
END $$;

-- ─── Destruction, une fois le transport vérifié ───

-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_family_id_fkey";

-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_questioner_id_fkey";

-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_responder_id_fkey";

-- DropForeignKey
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_story_id_fkey";

-- DropTable
DROP TABLE "conversations";

-- Au plus un point d'ancrage par fil : une entité, un récit, ou rien.
-- Promise dans le schéma, tenue par la base.
ALTER TABLE "threads" ADD CONSTRAINT "threads_un_seul_ancrage"
  CHECK (NUM_NONNULLS("entity_id", "story_id") <= 1);

-- Une marque n'appartient qu'à un vocabulaire fermé : ce ne sont pas des
-- avis, ce sont des faits.
ALTER TABLE "message_marks" ADD CONSTRAINT "message_marks_vocabulaire"
  CHECK ("kind" IN ('WITNESS', 'REMEMBER', 'LEARNED'));
