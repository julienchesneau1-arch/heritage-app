/**
 * DÉSIGNER UNE CHOSE PAR SON NOM — la troisième espèce de référent.
 *
 * Référence : ADR-096, `docs/26 §4.1`, et le même interdit qu'ADR-073.
 *
 * LE TROU QUE CE MODULE FERME
 * ---------------------------------------------------------------------------
 * Six outils du dépôt étaient écrits, éprouvés, conformes — et **hors
 * d'atteinte**. La raison tenait en une ligne :
 *
 * ```text
 * task_complete   parameters: [{ name: 'taskId' }]
 * note_delete     parameters: [{ name: 'noteId' }]
 * memory_forget   parameters: [{ name: 'memoryId' }]
 * ```
 *
 * **Ils exigent un identifiant qu'une phrase ne porte pas.** Dire « supprime la
 * note du carreleur » ne fournit pas d'UUID, et le moteur d'intention est une
 * fonction PURE du texte — il n'a pas de base à interroger.
 *
 * Le dépôt avait déjà la forme de la réponse, deux fois :
 *
 * ```text
 * ANAPHORA   « ça »       → le contexte de conversation résout     ADR-073
 * TEMPORAL   « jeudi »    → la base résout                         ADR-077
 * DESIGNATION « la note du carreleur » → la base résout            ADR-096
 * ```
 *
 * Les trois sont **le même fait** : un champ dont la valeur n'est pas encore la
 * valeur. Le moteur SIGNALE, l'Assistant RÉSOUT.
 *
 * L'INTERDIT QUI GOUVERNE TOUT CE FICHIER
 * ---------------------------------------------------------------------------
 *   > Il ne doit jamais choisir arbitrairement si l'erreur est coûteuse.
 *
 * Et ici l'erreur est **maximale** : quatre des six outils sont `L4`,
 * irréversibles. Supprimer la mauvaise note est une perte sèche.
 *
 * D'où la règle, sans exception : **un seul candidat → on résout. Plusieurs →
 * on demande. Aucun → on le dit.** Il n'existe dans ce fichier aucune
 * heuristique de départage — ni le plus récent, ni le mieux noté, ni le
 * premier. Départager, ce serait choisir à la place de quelqu'un.
 *
 * ⚠ LE PIÈGE QU'IL A FALLU VOIR AVANT D'ÉCRIRE LA PREMIÈRE REQUÊTE
 * ---------------------------------------------------------------------------
 * Une question de désambiguïsation ÉNUMÈRE les candidats :
 *
 *     « J'en trouve deux : “mot de passe de la banque : xxxx” ou … ? »
 *
 * Sur une mémoire de catégorie `CREDENTIAL`, cette question **imprime le
 * secret** — dans le terminal, dans la passerelle web, et dans tout ce qui
 * journalise la conversation. Le module qui sert à EFFACER une donnée sensible
 * l'aurait affichée en chemin.
 *
 * Aucune règle existante ne l'aurait attrapé : ce n'est ni une égression, ni un
 * log, ni un contexte de modèle. C'est une **question posée à l'utilisateur**,
 * et rien ne classait ce canal.
 *
 * `libelleSur` applique donc le plancher de `docs/14 §3` : au-dessus de
 * `PERSONAL`, on nomme la chose sans la citer. On peut toujours la désigner —
 * on ne l'entend plus.
 */
import { z } from 'zod';
import { floorFor } from '../privacy/classify.js';
import { levelAtLeast, DataCategory } from '../types/domain.js';
import { ok, type Result } from '../types/result.js';
import type { Db, TxClient } from '../db/client.js';

/**
 * TOUT CE DONT CE MODULE A BESOIN : savoir interroger.
 *
 * ⚠ `Db` AURAIT ÉTÉ TROP LARGE, et le compilateur l'a dit avant moi. Un
 * résolveur qui exige `Db` ne peut pas tourner DANS une transaction —
 * `TxClient` n'a ni `transaction`, ni `health`, ni `close`. Les tests de ce
 * module sèment leurs lignes dans une transaction annulée : les leur interdire
 * aurait signifié semer pour de vrai dans `jarvis_test`, ou ne pas les écrire.
 *
 * Demander le minimum n'est pas de la coquetterie de typage : c'est ce qui
 * rend le module éprouvable sans laisser de trace.
 */
export type Interrogeable = Pick<Db, 'query'> | TxClient;

/**
 * Ce qu'une désignation peut viser.
 *
 * ⚠ `ENTITY` N'Y FIGURE PAS, ET C'EST DÉLIBÉRÉ. `EntityResolver` résout déjà
 * les mentions nominales, avec ses alias confirmés et sa preuve contextuelle.
 * En ajouter une seconde ici créerait deux registres de « comment on retrouve
 * une personne » (ADR-041) — et le jour où ils divergeraient, aucun ne ferait
 * autorité.
 */
export const GenreDesigne = z.enum(['TASK', 'NOTE', 'MEMORY', 'REMINDER']);
export type GenreDesigne = z.infer<typeof GenreDesigne>;

export interface Designe {
  readonly id: string;
  /** Ce qui sera MONTRÉ. Pas forcément ce qui est stocké — voir `libelleSur`. */
  readonly libelle: string;
}

export type ResolutionDesignation =
  | { readonly kind: 'RESOLU'; readonly cible: Designe }
  | {
      readonly kind: 'AMBIGU';
      readonly candidats: readonly Designe[];
      readonly question: string;
    }
  | { readonly kind: 'INTROUVABLE'; readonly mention: string };

/** Au-delà, on ne lit plus une question : on subit une liste. */
const CANDIDATS_MONTRES = 5;

/**
 * Accents retirés des DEUX côtés de la comparaison.
 *
 * « rappelle-moi d'appeler le medecin » doit retrouver « le médecin ». Sans ça,
 * la moitié des désignations françaises échouent sur un accent oublié — et
 * l'utilisateur conclut que la note n'existe pas.
 *
 * ⚠ `translate()` PLUTÔT QUE L'EXTENSION `unaccent`. Elle ferait le travail
 * mieux, et elle coûterait une extension PostgreSQL de plus à installer — donc
 * une fiche de dépendance (`docs/04`) et une machine de plus à configurer, pour
 * quinze caractères. Ce qui est perdu : les alphabets non latins. Ce qui est
 * gagné : `pnpm jarvis:setup` continue de marcher partout.
 */
const ACCENTUEES = 'àâäáãéèêëíìîïóòôöõúùûüýÿñç';
const PLATES = 'aaaaaeeeeiiiiooooouuuuyync';

function sansAccent(s: string): string {
  let out = '';
  for (const c of s.toLowerCase()) {
    const i = ACCENTUEES.indexOf(c);
    out += i === -1 ? c : (PLATES[i] ?? c);
  }
  return out;
}

/** La même transformation, côté SQL — sur la MÊME table de caractères. */
const SQL_SANS_ACCENT = `translate(lower(%COL%), '${ACCENTUEES}', '${PLATES}')`;

interface Ligne {
  id: string;
  libelle: string;
  /** Renseigné pour `MEMORY` seulement — sert à décider si on peut citer. */
  data_category: string | null;
}

/**
 * Le libellé montrable d'une ligne.
 *
 * `docs/14 §3` : au-dessus de `PERSONAL`, une donnée ne s'affiche pas en clair
 * dans une question. On rend alors une désignation qui permet de CHOISIR sans
 * RÉVÉLER — la catégorie, et rien d'autre.
 *
 * Une catégorie illisible retombe sur `OTHER`, dont le plancher est `PERSONAL`
 * … ce qui autoriserait la citation. On ne fait donc pas ça : une catégorie
 * qu'on ne sait pas lire est traitée comme **masquée**. Le repli va vers la
 * protection, jamais vers l'affichage.
 */
export function libelleSur(brut: string, categorie: string | null): string {
  if (categorie === null) return brut;

  const lue = DataCategory.safeParse(categorie);
  if (!lue.success) return '[mémoire de catégorie illisible]';

  // `PERSONAL` et en dessous : citable. Au-dessus : nommée, pas citée.
  if (levelAtLeast('PERSONAL', floorFor(lue.data))) return brut;
  return `[mémoire ${lue.data}, contenu masqué]`;
}

/** Formule UNE question — `docs/05 §A3`, PRD §85 : une seule à la fois. */
export function questionDesignation(
  mention: string,
  candidats: readonly Designe[],
): string {
  const montres = candidats.slice(0, CANDIDATS_MONTRES);
  const reste = candidats.length - montres.length;
  const liste = montres.map((c) => `« ${c.libelle} »`).join(', ');
  const suite = reste > 0 ? `, et ${String(reste)} autre(s)` : '';
  return (
    `« ${mention} » correspond à ${String(candidats.length)} éléments : `
    + `${liste}${suite}. Lequel ?`
  );
}

export interface DesignationResolver {
  resoudre(
    genre: GenreDesigne,
    mention: string,
  ): Promise<Result<ResolutionDesignation>>;
}

/**
 * Une requête par genre. Écrites en toutes lettres plutôt que composées.
 *
 * ⚠ LE FILTRE D'ÉTAT N'EST PAS DÉCORATIF. On ne propose que ce sur quoi
 * l'action a un sens : une tâche déjà annulée n'est pas un candidat à
 * l'annulation. Sans ce filtre, « annule la tâche café » pourrait devenir
 * ambigu à cause d'une tâche annulée le mois dernier — et l'utilisateur se
 * verrait poser une question dont une des réponses ne fait rien.
 */
const REQUETES: Readonly<Record<GenreDesigne, string>> = {
  TASK: `SELECT id, title AS libelle, NULL::text AS data_category
           FROM tasks
          WHERE state = 'OPEN'
            AND ${SQL_SANS_ACCENT.replace('%COL%', 'title')} LIKE '%' || $1 || '%'
          ORDER BY created_at DESC`,

  NOTE: `SELECT id, left(content, 60) AS libelle, NULL::text AS data_category
           FROM notes
          WHERE ${SQL_SANS_ACCENT.replace('%COL%', 'content')} LIKE '%' || $1 || '%'
          ORDER BY created_at DESC`,

  /* La CATÉGORIE est sélectionnée — c'est elle qui décidera si le contenu peut
     être cité dans la question. La requête qui l'oublierait rendrait
     `libelleSur` incapable de faire son travail : un filtre ne peut pas trier
     sur ce qu'on ne lui donne pas (même leçon qu'ADR-083). */
  MEMORY: `SELECT id, left(content, 60) AS libelle, data_category
             FROM memories
            WHERE state <> 'DELETED'
              AND ${SQL_SANS_ACCENT.replace('%COL%', 'content')} LIKE '%' || $1 || '%'
            ORDER BY created_at DESC`,

  REMINDER: `SELECT id, text AS libelle, NULL::text AS data_category
               FROM reminders
              WHERE state = 'PENDING'
                AND ${SQL_SANS_ACCENT.replace('%COL%', 'text')} LIKE '%' || $1 || '%'
              ORDER BY remind_at ASC`,
};

export function createDesignationResolver(db: Interrogeable): DesignationResolver {
  return {
    async resoudre(
      genre: GenreDesigne,
      mention: string,
    ): Promise<Result<ResolutionDesignation>> {
      const aplatie = sansAccent(mention.trim());

      /* Une mention VIDE ne désigne rien. Sans cette garde, `LIKE '%%'`
         matcherait TOUT — et une phrase mal découpée proposerait d'effacer
         n'importe laquelle des mémoires. Le cas le plus dangereux du fichier
         est celui où l'utilisateur n'a rien dit. */
      if (aplatie.length === 0) return ok({ kind: 'INTROUVABLE', mention });

      const rows = await db.query<Ligne>(REQUETES[genre], [aplatie]);
      if (!rows.ok) return rows;

      const candidats: readonly Designe[] = rows.value.rows.map((r) => ({
        id: r.id,
        libelle: libelleSur(r.libelle, r.data_category),
      }));

      if (candidats.length === 0) return ok({ kind: 'INTROUVABLE', mention });

      const seul = candidats[0];
      if (candidats.length === 1 && seul !== undefined) {
        return ok({ kind: 'RESOLU', cible: seul });
      }

      /* PLUSIEURS. Et on s'arrête là — aucune règle de départage.

         La tentation est forte : « le plus récent », « celui qui correspond le
         mieux ». Les deux sont des heuristiques, et une heuristique appliquée à
         un `memory_forget` efface parfois la mauvaise ligne sans que personne
         ne le sache jamais. */
      return ok({
        kind: 'AMBIGU',
        candidats,
        question: questionDesignation(mention, candidats),
      });
    },
  };
}
