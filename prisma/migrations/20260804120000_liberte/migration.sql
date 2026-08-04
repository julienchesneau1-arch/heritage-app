-- LIBERTÉ — trois corrections, toutes tirées de la Constitution.
--
-- 1. `threads.story_id` et `threads.entity_id` passent de CASCADE à SET NULL.
--    Vérifié sur les données réelles : supprimer « La montre arrêtée »
--    détruisait la question qu'Emma avait posée dessous. Elle n'avait rien
--    décidé, et n'était pas prévenue. L'Annexe A point 6 fait de la
--    suppression une décision de celui à qui les mots appartiennent ; une
--    cascade la donnait à un tiers. Le fil se détache, la parole reste.
--
-- 2. `members.calendar_opt_out` : ne pas figurer au flux .ics, que l'agenda
--    recopie chez Google ou Apple. Appartenir à sa famille sans que sa date
--    de naissance parte chez un tiers. Le défaut reste l'inclusion — on ne
--    retire personne sans qu'il l'ait demandé.
--
-- 3. `families.token_version` : le lien familial n'avait aucun moyen d'être
--    changé. Une famille qui le publiait par erreur restait sans recours,
--    alors que les liens personnels se révoquent depuis toujours (§4.1).

-- DropForeignKey
ALTER TABLE "threads" DROP CONSTRAINT "threads_entity_id_fkey";

-- DropForeignKey
ALTER TABLE "threads" DROP CONSTRAINT "threads_story_id_fkey";

-- AlterTable
ALTER TABLE "families" ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "calendar_opt_out" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

