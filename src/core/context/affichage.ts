/**
 * LE DERNIER AFFICHAGE — ce contre quoi un ordinal se résout. ADR-107.
 *
 * ⚠ IL DIT CE QUI A ÉTÉ MONTRÉ, JAMAIS CE QUI EXISTE
 * ---------------------------------------------------------------------------
 * C'est la distinction qui rend ce module sûr. Une tâche montrée il y a dix
 * minutes a pu être terminée, supprimée ou modifiée depuis. Ce module ne le
 * sait pas, et il ne doit pas prétendre le savoir : il rend une IDENTITÉ, et
 * l'outil visé refera son propre contrôle, comme le Policy Gate refera le
 * sien.
 *
 * Confondre les deux produirait le pire défaut possible ici — une action
 * réelle, sur la mauvaise cible, annoncée comme un succès.
 *
 * ⚠ ET LE GENRE EST VÉRIFIÉ, PAS SUPPOSÉ
 * ---------------------------------------------------------------------------
 * « Supprime la deuxième » après une liste de tâches et après une recherche en
 * mémoire ne désignent pas la même chose. La règle d'intention déclare le
 * genre qu'elle attend ; si le dernier affichage n'est pas de ce genre, on
 * **demande**. On ne convertit pas, on ne devine pas.
 *
 * C'est l'interdit de `docs/05 §A2`, mot pour mot : *« interdit : deviner si
 * deux interprétations ont un impact différent »*.
 */
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import { GenreDesigne } from './designation.js';
import type { ElementEnumere } from '../tools/enumeration.js';
import type { Ordinal } from './ordinal.js';

/* ⚠ RELU PAR ZOD À LA SORTIE DE LA BASE, et `genre` par l'ÉNUMÉRATION.

   Un `z.string()` aurait suffi à faire compiler, et aurait laissé entrer
   n'importe quelle chaîne écrite en base — puis un `as GenreDesigne` au
   retour, c'est-à-dire un `as` sur une frontière (`CLAUDE.md`). Le genre
   décide de ce qu'un ordinal supprime : c'est le dernier endroit où l'on
   voudrait croire une chaîne sur parole. */
const Element = z.object({
  id: z.string().min(1),
  genre: GenreDesigne,
  libelle: z.string(),
});

const Ligne = z.object({
  tool_id: z.string().min(1),
  elements: z.array(Element),
});

/** Ce qu'une résolution d'ordinal peut donner. Quatre issues, une seule agit. */
export type ResolutionOrdinale =
  | { readonly kind: 'RESOLU'; readonly element: ElementEnumere }
  /** Rien n'a été montré dans cette conversation. */
  | { readonly kind: 'RIEN_MONTRE' }
  /** Le dernier affichage existe, mais il n'est pas du genre attendu. */
  | {
      readonly kind: 'MAUVAIS_GENRE';
      readonly montre: GenreDesigne;
      readonly attendu: GenreDesigne;
    }
  /** La position dépasse ce qui a été montré. */
  | { readonly kind: 'HORS_LISTE'; readonly taille: number };

export interface MemoireDAffichage {
  /** Enregistre ce qui vient d'être montré. Remplace l'affichage précédent. */
  retenir(
    sessionId: string,
    toolId: string,
    elements: readonly ElementEnumere[],
  ): Promise<Result<void>>;

  /** Résout une position contre le dernier affichage de cette session. */
  resoudre(
    sessionId: string,
    position: Ordinal,
    genreAttendu: GenreDesigne,
  ): Promise<Result<ResolutionOrdinale>>;
}

export function createMemoireDAffichage(db: Db): MemoireDAffichage {
  return {
    async retenir(sessionId, toolId, elements): Promise<Result<void>> {
      /* UNE LISTE VIDE EFFACE L'AFFICHAGE PRÉCÉDENT, elle ne le laisse pas en
         place. « Mes tâches » qui ne rend rien doit faire disparaître « la
         première » — sinon elle continuerait de désigner la liste d'avant, que
         l'utilisateur ne voit plus. */
      if (elements.length === 0) {
        const efface = await db.query(
          'DELETE FROM dernier_affichage WHERE session_id = $1::uuid',
          [sessionId],
        );
        return efface.ok ? ok(undefined) : efface;
      }

      const ecrit = await db.query(
        `INSERT INTO dernier_affichage (session_id, tool_id, elements, montre_at)
         VALUES ($1::uuid, $2, $3::jsonb, now())
         ON CONFLICT (session_id) DO UPDATE
            SET tool_id = EXCLUDED.tool_id,
                elements = EXCLUDED.elements,
                montre_at = EXCLUDED.montre_at`,
        [sessionId, toolId, JSON.stringify(elements)],
      );
      return ecrit.ok ? ok(undefined) : ecrit;
    },

    async resoudre(sessionId, position, genreAttendu): Promise<Result<ResolutionOrdinale>> {
      const rows = await db.query(
        'SELECT tool_id, elements FROM dernier_affichage WHERE session_id = $1::uuid',
        [sessionId],
      );
      if (!rows.ok) return rows;

      const brut = rows.value.rows[0];
      if (brut === undefined) return ok({ kind: 'RIEN_MONTRE' });

      const lu = Ligne.safeParse(brut);
      if (!lu.success) {
        /* ⚠ UNE LIGNE ILLISIBLE N'EST PAS UNE LISTE VIDE. La traiter comme
           « rien montré » serait honnête par accident ; la traiter comme une
           erreur dit à l'utilisateur que quelque chose ne va pas, au lieu de
           lui faire croire qu'il n'a rien demandé. */
        return err(
          jarvisError('INTERNAL', `dernier affichage illisible : ${lu.error.message}`),
        );
      }

      const elements = lu.data.elements;
      if (elements.length === 0) return ok({ kind: 'RIEN_MONTRE' });

      /* ⚠ LE GENRE AVANT LA POSITION. Vérifier la position d'abord rendrait
         « supprime la deuxième » après une liste d'UN élément avec le message
         « il n'y en a qu'une » — alors que le vrai problème est qu'on parlait
         de mémoires et pas de tâches. On dit la première chose qui cloche, et
         c'est celle-là. */
      const genre = elements[0]?.genre;
      if (genre === undefined) return ok({ kind: 'RIEN_MONTRE' });
      if (genre !== genreAttendu) {
        return ok({ kind: 'MAUVAIS_GENRE', montre: genre, attendu: genreAttendu });
      }

      const index =
        'depuisLaFin' in position ? elements.length - position.depuisLaFin : position.rang - 1;

      const element = elements[index];
      if (element === undefined) {
        return ok({ kind: 'HORS_LISTE', taille: elements.length });
      }
      return ok({ kind: 'RESOLU', element });
    },
  };
}
