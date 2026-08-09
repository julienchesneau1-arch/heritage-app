/**
 * Résolution de référents.
 *
 * Référence : 02 Phase 1, scénarios 05/A2 et 05/A3, PRD §22 et §86.
 *
 * Le Context Engine doit résoudre « Paul », « celui-ci », « le projet »,
 * « comme la dernière fois ». La règle qui gouverne ce module :
 *
 *   > « Il ne doit jamais choisir arbitrairement si l'erreur est coûteuse. »
 *
 * Mais elle se combine avec « do the obvious » (PRD §86) : quand le contexte
 * récent ne laisse qu'un candidat plausible, demander devient une friction
 * inutile. La frontière retenue ici est nette — on ne tranche que sur une
 * PREUVE contextuelle (l'entité a été mentionnée dans la session), jamais sur
 * une heuristique de popularité ou d'ordre alphabétique.
 */
import type { Db } from '../db/client.js';
import { ok, type Result } from '../types/result.js';

export interface EntityRef {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  /** Vrai si la correspondance vient d'un alias confirmé par l'utilisateur. */
  readonly viaConfirmedAlias: boolean;
}

export type Resolution =
  | { readonly kind: 'RESOLVED'; readonly entity: EntityRef; readonly confidence: number; readonly reason: string }
  | { readonly kind: 'AMBIGUOUS'; readonly candidates: readonly EntityRef[]; readonly question: string }
  | { readonly kind: 'NOT_FOUND'; readonly mention: string };

interface CandidateRow {
  id: string;
  kind: string;
  display_name: string;
  via_confirmed_alias: boolean;
}

/**
 * Formule UNE question de désambiguïsation.
 *
 * `05/A3` et PRD §85 : une seule question à la fois. Poser « Pierre Dupont,
 * Pierre Martin ou Pierre du domaine ? » est correct ; enchaîner cinq
 * questions ne l'est pas.
 */
export function disambiguationQuestion(
  mention: string,
  candidates: readonly EntityRef[],
): string {
  const names = candidates.map((c) => c.displayName);
  if (names.length === 2) {
    return `${names[0] ?? ''} ou ${names[1] ?? ''} ?`;
  }
  const last = names[names.length - 1] ?? '';
  return `${names.slice(0, -1).join(', ')} ou ${last} ?`;
}

export interface EntityResolver {
  /**
   * Résout une mention nominale.
   *
   * `sessionId` sert uniquement à départager : une entité déjà mentionnée dans
   * la conversation en cours est une preuve contextuelle, pas une supposition.
   */
  resolveMention(
    mention: string,
    sessionId?: string,
  ): Promise<Result<Resolution>>;

  /** Résout un référent anaphorique (« celui-ci », « ça ») depuis la session. */
  resolveAnaphora(sessionId: string): Promise<Result<Resolution>>;
}

export function createEntityResolver(db: Db): EntityResolver {
  async function findCandidates(
    mention: string,
  ): Promise<Result<readonly EntityRef[]>> {
    const rows = await db.query<CandidateRow>(
      `SELECT DISTINCT ON (e.id)
              e.id, e.kind, e.display_name,
              COALESCE(a.confirmed_by_user, false) AS via_confirmed_alias
         FROM entities e
         LEFT JOIN entity_aliases a
                ON a.entity_id = e.id AND lower(a.alias) = lower($1)
        WHERE lower(e.display_name) = lower($1)
           OR lower(e.display_name) LIKE lower($1) || ' %'
           OR a.id IS NOT NULL
        ORDER BY e.id, via_confirmed_alias DESC`,
      [mention],
    );
    if (!rows.ok) return rows;

    return ok(
      rows.value.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        displayName: r.display_name,
        viaConfirmedAlias: r.via_confirmed_alias,
      })),
    );
  }

  /** Entités mentionnées dans les tours récents de la session. */
  async function mentionedInSession(
    sessionId: string,
    limit = 12,
  ): Promise<Result<ReadonlySet<string>>> {
    const rows = await db.query<{ mentioned_entity_ids: string[] }>(
      `SELECT mentioned_entity_ids FROM session_turns
        WHERE session_id = $1
        ORDER BY turn_index DESC LIMIT $2`,
      [sessionId, limit],
    );
    if (!rows.ok) return rows;
    const ids = new Set<string>();
    for (const row of rows.value.rows) {
      for (const id of row.mentioned_entity_ids) ids.add(id);
    }
    return ok(ids);
  }

  return {
    async resolveMention(
      mention: string,
      sessionId?: string,
    ): Promise<Result<Resolution>> {
      const candidates = await findCandidates(mention);
      if (!candidates.ok) return candidates;

      if (candidates.value.length === 0) {
        return ok({ kind: 'NOT_FOUND', mention });
      }

      const only = candidates.value[0];
      if (candidates.value.length === 1 && only !== undefined) {
        return ok({
          kind: 'RESOLVED',
          entity: only,
          confidence: only.viaConfirmedAlias ? 1 : 0.9,
          reason: 'Un seul candidat connu porte ce nom.',
        });
      }

      /* Plusieurs candidats. On ne tranche que sur preuve contextuelle. */
      if (sessionId !== undefined) {
        const mentioned = await mentionedInSession(sessionId);
        if (!mentioned.ok) return mentioned;

        const inContext = candidates.value.filter((c) => mentioned.value.has(c.id));
        const single = inContext[0];
        if (inContext.length === 1 && single !== undefined) {
          return ok({
            kind: 'RESOLVED',
            entity: single,
            // Confiance délibérément inférieure au cas non ambigu : la
            // résolution repose sur le contexte, pas sur le nom.
            confidence: 0.75,
            reason:
              `${String(candidates.value.length)} personnes portent ce nom, mais une seule ` +
              'a été évoquée dans la conversation en cours.',
          });
        }
      }

      return ok({
        kind: 'AMBIGUOUS',
        candidates: candidates.value,
        question: disambiguationQuestion(mention, candidates.value),
      });
    },

    async resolveAnaphora(sessionId: string): Promise<Result<Resolution>> {
      const rows = await db.query<{
        mentioned_entity_ids: string[];
      }>(
        `SELECT mentioned_entity_ids FROM session_turns
          WHERE session_id = $1 AND cardinality(mentioned_entity_ids) > 0
          ORDER BY turn_index DESC LIMIT 1`,
        [sessionId],
      );
      if (!rows.ok) return rows;

      const ids = rows.value.rows[0]?.mentioned_entity_ids ?? [];
      if (ids.length === 0) {
        return ok({ kind: 'NOT_FOUND', mention: 'référent implicite' });
      }

      const entities = await db.query<CandidateRow>(
        `SELECT id, kind, display_name, false AS via_confirmed_alias
           FROM entities WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      if (!entities.ok) return entities;

      const refs: EntityRef[] = entities.value.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        displayName: r.display_name,
        viaConfirmedAlias: false,
      }));

      const single = refs[0];
      if (refs.length === 1 && single !== undefined) {
        return ok({
          kind: 'RESOLVED',
          entity: single,
          confidence: 0.8,
          reason: 'Seule entité évoquée au tour précédent.',
        });
      }

      // Deux entités au tour précédent : « celui-ci » est réellement ambigu.
      // Deviner ici reviendrait à jouer à pile ou face sur l'action suivante.
      return ok({
        kind: 'AMBIGUOUS',
        candidates: refs,
        question: disambiguationQuestion('celui-ci', refs),
      });
    },
  };
}
