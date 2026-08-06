-- LE MODE ENTRETIEN, ET LE DROIT DE NE PAS PARLER D'UN SUJET.
--
-- Migration additive : aucune colonne supprimée, aucune donnée réécrite.
-- Tout ce qui existe continue de fonctionner exactement comme avant.
--
-- Trois choses :
--
-- 1. `transcription_drafts` apprend QUI A PARLÉ, qui relit, et à quelle
--    question. Jusqu'ici le brouillon ne connaissait que celui qui l'avait
--    demandé et celui qui l'avait validé — jamais la voix. Celui qui parlait
--    ne pouvait donc pas reprendre ce qu'il venait de dire.
--
-- 2. `stories` apprend la SUSPENSION, décision humaine distincte de la
--    quarantaine qui appartient au Conservateur. Seul l'auteur suspend, et
--    seulement s'il consent à la demande de quelqu'un : une suspension
--    déclenchée par la seule objection contredirait la §2.6 — « un membre
--    peut décider de ne plus voir un récit ; il ne peut pas décider à la
--    place des autres ». C'est un geste plus doux que la suppression,
--    réversible, et qui ne détruit aucun `Passage`.
--
-- 3. `reserves`, table nouvelle : « ne me demande jamais rien sur ceci ».
--    Silencieuse par défaut — une réserve visible apprendrait à toute la
--    famille que le sujet existe et qu'il fait mal.

-- ─── 1. L'entretien ───

ALTER TABLE "transcription_drafts"
  ADD COLUMN "spoken_by_id" TEXT,
  ADD COLUMN "reviewer_id"  TEXT,
  ADD COLUMN "prompt_text"  TEXT;

ALTER TABLE "transcription_drafts"
  ADD CONSTRAINT "transcription_drafts_spoken_by_id_fkey"
    FOREIGN KEY ("spoken_by_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "transcription_drafts_reviewer_id_fkey"
    FOREIGN KEY ("reviewer_id") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- `SET NULL` et non `CASCADE` : retirer un membre de la famille ne doit pas
-- détruire un brouillon en attente de relecture. §2.1 règle 1 — les récits
-- restent, l'auteur s'anonymise. Un brouillon suit la même règle.

-- ─── 2. La suspension ───

ALTER TABLE "stories"
  ADD COLUMN "suspended_at"     TIMESTAMP(3),
  ADD COLUMN "suspended_for_id" TEXT;

-- Index partiel : les récits suspendus sont rares par construction, et cette
-- colonne est lue à chaque page. Un index sur la seule minorité concernée
-- coûte quelques kilo-octets au lieu d'un index complet.
CREATE INDEX "stories_suspended_at_idx" ON "stories"("suspended_at")
  WHERE "suspended_at" IS NOT NULL;

-- ─── 3. La réserve ───

CREATE TABLE "reserves" (
  "id"         TEXT NOT NULL,
  "family_id"  TEXT NOT NULL,
  "member_id"  TEXT NOT NULL,
  "entity_id"  TEXT,
  "sujet"      TEXT,
  "portee"     TEXT NOT NULL DEFAULT 'silencieuse',
  "demande"    TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "reserves_pkey" PRIMARY KEY ("id")
);

-- Une réserve porte sur quelque chose : une entité de la mémoire, ou
-- quelques mots. Une réserve vide ne veut rien dire, et la base le refuse
-- plutôt que de laisser l'application s'en apercevoir plus tard.
ALTER TABLE "reserves"
  ADD CONSTRAINT "reserves_objet_check"
    CHECK ("entity_id" IS NOT NULL OR ("sujet" IS NOT NULL AND length(trim("sujet")) > 0));

-- Deux portées, et deux seulement. Le vocabulaire est fermé en base :
-- une troisième valeur inventée un jour par un appelant distrait
-- deviendrait, par défaut de filtre, une réserve qui ne protège rien.
ALTER TABLE "reserves"
  ADD CONSTRAINT "reserves_portee_check"
    CHECK ("portee" IN ('silencieuse', 'portee'));

ALTER TABLE "reserves"
  ADD CONSTRAINT "reserves_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "reserves_entity_id_fkey"
    FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `CASCADE` ici, et c'est la bonne direction : une réserve n'appartient qu'à
-- son auteur. Il part, elle part avec lui — elle n'a jamais eu de sens pour
-- personne d'autre, et la laisser derrière serait garder une trace d'un
-- silence que plus personne ne demande.

CREATE INDEX "reserves_family_id_member_id_idx" ON "reserves"("family_id", "member_id");
