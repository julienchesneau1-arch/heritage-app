-- LA DEMANDE DE SUSPENSION.
--
-- La suspension elle-même est en base depuis `20260805140000_entretien_reserve`
-- (`stories.suspended_at`, `stories.suspended_for_id`). Il manquait la moitié
-- humaine : la DEMANDE.
--
-- Rappel de la décision, parce qu'elle est contre-intuitive et qu'elle sera
-- relue : celui qui s'estime concerné par un récit qu'il n'a ni écrit ni
-- raconté ne peut pas le supprimer — ce sont les mots d'un autre — et la
-- §2.6 interdit qu'il décide à la place de la famille. Il demande ; seul
-- l'auteur suspend.
--
-- Une table plutôt qu'un champ sur `stories` : deux personnes peuvent
-- s'estimer concernées par le même récit, et écraser la demande de la
-- première serait la faire taire au profit de la seconde.

CREATE TABLE "suspension_requests" (
  "id"         TEXT NOT NULL,
  "family_id"  TEXT NOT NULL,
  "story_id"   TEXT NOT NULL,
  "member_id"  TEXT NOT NULL,
  "motif"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "suspension_requests_pkey" PRIMARY KEY ("id")
);

-- Une seule demande par personne et par récit. Sans cette contrainte, un
-- clic répété transformerait une demande en insistance, et l'auteur verrait
-- la même objection dix fois.
CREATE UNIQUE INDEX "suspension_requests_story_id_member_id_key"
  ON "suspension_requests"("story_id", "member_id");

CREATE INDEX "suspension_requests_family_id_story_id_idx"
  ON "suspension_requests"("family_id", "story_id");

ALTER TABLE "suspension_requests"
  ADD CONSTRAINT "suspension_requests_story_id_fkey"
    FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "suspension_requests_member_id_fkey"
    FOREIGN KEY ("member_id") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `CASCADE` dans les deux sens, et c'est la bonne direction. Le récit
-- disparaît : la demande n'a plus d'objet. La personne quitte la famille :
-- sa demande part avec elle — une objection sans personne pour la porter
-- n'engage plus rien, et la laisser derrière ferait peser un silence que
-- plus personne ne réclame.
