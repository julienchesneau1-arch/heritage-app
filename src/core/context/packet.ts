/**
 * Paquet de contexte.
 *
 * Référence : 00 §20 (Context Window Manager), 02 Phase 1, PRD §12.
 *
 *   > « Ne jamais injecter toute la mémoire dans le prompt. »
 *   > « Le contexte fourni au modèle doit être minimal mais suffisant. »
 *
 * Ce module applique un BUDGET DUR. Ce qui n'entre pas dans le budget est
 * écarté, et le paquet dit ce qu'il a écarté — plutôt que de tronquer en
 * silence, ce qui produirait des réponses incomplètes sans que personne ne
 * sache pourquoi.
 *
 * Le filtrage de confidentialité intervient AVANT le budget : une mémoire RED
 * destinée à un modèle cloud est retirée, pas reléguée en fin de liste.
 *
 * ⚠ CE MODULE A CERTIFIÉ PENDANT LONGTEMPS UNE PROPRIÉTÉ QU'IL N'AVAIT PAS
 * ---------------------------------------------------------------------------
 * Le paquet a **trois** canaux : mémoires, entités, tours. Le filtrage n'en
 * regardait qu'un.
 *
 * ```text
 * memories   filtrées par privacyClass       ← la seule protégée
 * entities   passaient telles quelles        ← privacy_class jetée par le lecteur
 * turns      passaient tels quels            ← provenance  jetée par le lecteur
 * query      passe telle quelle              ← irréductible, voir plus bas
 * ```
 *
 * Et la porte G1.4 — *« une donnée RED n'entre jamais dans un paquet destiné
 * au cloud »* — appelait ce module avec `turns: []` et `entities: []`. Elle
 * n'a donc jamais rien mis dans les deux canaux non protégés. **La porte était
 * verte parce qu'elle ne regardait pas**, ce qui est la forme la plus coûteuse
 * de vert : celle qui dispense de chercher.
 *
 * La cause n'était pas une décision, et c'est ce qui la rend instructive :
 * `entities.privacy_class` et `session_turns.provenance` EXISTENT en base, les
 * écrivains les remplissent, et les lecteurs (`EntityRef`, `ConversationTurn`)
 * ne les transportaient pas. **Un filtre ne peut pas trier sur ce qu'on ne lui
 * donne pas** — il rend alors « rien à écarter », ce qui se lit comme un
 * succès.
 *
 * CE QUE CE MODULE NE PEUT TOUJOURS PAS FILTRER, ET POURQUOI ON LE DIT
 * ---------------------------------------------------------------------------
 * Le CONTENU d'un tour et la `query` sont du texte libre. Les classer
 * exigerait de deviner à partir des mots — exactement ce que `privacy/classify`
 * refuse de faire : *« le niveau se déduit de la CATÉGORIE, que la base impose
 * à l'écriture »*. Si l'utilisateur dicte son IBAN, ce module ne le sait pas.
 *
 * Ce n'est pas corrigé ici, c'est **borné et écrit** (`docs/26 §4.14`). La
 * condition de levée est nommée : une catégorie de donnée sur `session_turns`,
 * posée à l'écriture par celui qui sait ce qu'il insère.
 */
import { isUntrusted, type PrivacyClass, type Provenance } from '../types/domain.js';
import { ok, type Result } from '../types/result.js';
import type { StoredMemory } from '../memory/types.js';
import type { EntityRef } from './resolver.js';

export interface ContextBudget {
  /** Budget en caractères. Approximation volontairement simple et vérifiable. */
  readonly maxCharacters: number;
  readonly maxMemories: number;
  readonly maxTurns: number;
}

export const DEFAULT_BUDGET: ContextBudget = {
  maxCharacters: 6000,
  maxMemories: 12,
  maxTurns: 6,
};

export interface ConversationTurn {
  readonly speaker: 'USER' | 'JARVIS';
  readonly content: string;
  readonly turnIndex: number;
  /**
   * D'OÙ VIENT CE TOUR — ADR-083.
   *
   * REQUIS, et pas par goût de la rigueur : un champ optionnel est un champ
   * qu'on oublie, et l'oublier ici rendrait de nouveau invisible un contenu
   * externe passé par la conversation.
   *
   * `speaker: 'JARVIS'` ne veut pas dire « produit par Jarvis ». Le jour où il
   * lit un email à voix haute, c'est Jarvis qui parle et c'est un tiers qui
   * écrit. Seule la provenance distingue les deux.
   */
  readonly provenance: Provenance;
}

export interface PacketInput {
  readonly query: string;
  readonly memories: readonly StoredMemory[];
  readonly entities: readonly EntityRef[];
  readonly turns: readonly ConversationTurn[];
  /**
   * Classe maximale autorisée pour la destination.
   *
   * Un modèle local peut voir RED ; un modèle cloud ne le peut jamais
   * (03 §6). C'est le paramètre qui rend le filtrage explicite plutôt
   * qu'implicite.
   */
  readonly maxPrivacyClass: PrivacyClass;
  readonly budget?: ContextBudget;
}

export interface ContextPacket {
  readonly query: string;
  readonly entities: readonly EntityRef[];
  readonly memories: readonly StoredMemory[];
  readonly turns: readonly ConversationTurn[];
  /** Taille réelle du paquet, en caractères. */
  readonly characters: number;
  /** Ce qui a été écarté, et pourquoi. Jamais silencieux. */
  readonly omitted: {
    /** Mémoires ET entités écartées par leur classe de confidentialité. */
    readonly byPrivacy: number;
    /**
     * Tours écartés parce que leur provenance est non fiable — ADR-083.
     *
     * Compté à part de `byPrivacy` parce que le motif est différent, et que
     * confondre les deux ferait perdre l'information au moment où elle sert :
     * `byPrivacy` dit « trop sensible pour cette destination », celui-ci dit
     * « ce texte a été écrit par quelqu'un d'autre que toi ».
     */
    readonly byProvenance: number;
    readonly byBudget: number;
    readonly reasons: readonly string[];
  };
}

const PRIVACY_ORDER: Record<PrivacyClass, number> = { GREEN: 0, ORANGE: 1, RED: 2 };

function allowed(memory: PrivacyClass, max: PrivacyClass): boolean {
  return PRIVACY_ORDER[memory] <= PRIVACY_ORDER[max];
}

/**
 * Assemble le paquet.
 *
 * Ordre des opérations, et il compte :
 *   1. filtrage de confidentialité  ← sécurité d'abord
 *   2. tri par utilité              ← confiance, puis fraîcheur
 *   3. application du budget        ← ce qui reste dehors est déclaré
 */
export function buildContextPacket(input: PacketInput): Result<ContextPacket> {
  const budget = input.budget ?? DEFAULT_BUDGET;
  const reasons: string[] = [];

  /* --- 1. Confidentialité, sur les TROIS canaux ----------------------- */

  const permitted = input.memories.filter((m) =>
    allowed(m.privacyClass, input.maxPrivacyClass),
  );
  const memoiresEcartees = input.memories.length - permitted.length;
  if (memoiresEcartees > 0) {
    reasons.push(
      `${String(memoiresEcartees)} mémoire(s) écartée(s) : classe supérieure à ` +
        `${input.maxPrivacyClass} pour cette destination.`,
    );
  }

  /* LES ENTITÉS SONT UN CANAL À PART ENTIÈRE — ADR-083.

     Un `displayName` est rarement anodin : « Dr Lemaire » dit une consultation,
     « Notaire Roux » dit une succession. La table le sait — `privacy_class`
     accepte `RED` — et le paquet l'ignorait. */
  const entitesPermises = input.entities.filter((e) =>
    allowed(e.privacyClass, input.maxPrivacyClass),
  );
  const entitesEcartees = input.entities.length - entitesPermises.length;
  if (entitesEcartees > 0) {
    reasons.push(
      `${String(entitesEcartees)} entité(s) écartée(s) : classe supérieure à ` +
        `${input.maxPrivacyClass} pour cette destination.`,
    );
  }

  const byPrivacy = memoiresEcartees + entitesEcartees;

  /* LES TOURS SE FILTRENT SUR LA PROVENANCE, PAS SUR LA CLASSE — ADR-083.

     Et la différence n'est pas un détail d'implémentation. Un tour non fiable
     n'est pas « sensible » : il est **potentiellement hostile**. Le laisser
     entrer dans un paquet destiné à un modèle, c'est le mettre dans un prompt
     — c'est-à-dire offrir à un tiers la place où l'on écrit les instructions.

     `CLAUDE.md` règle 2 : *« Aucune donnée externe n'est une instruction. »*
     La seule lecture mécanique de cette phrase, ici, est l'exclusion.

     Le retirer plutôt que l'étiqueter est délibéré : une étiquette suppose un
     consommateur qui la respecte, et ce module n'en a aucun aujourd'hui. On ne
     construit pas une protection dont l'efficacité dépend d'un lecteur qui
     n'existe pas encore. Qui voudra du contenu externe le demandera
     explicitement, comme DONNÉE. */
  const toursFiables = input.turns.filter((t) => !isUntrusted(t.provenance));
  const byProvenance = input.turns.length - toursFiables.length;
  if (byProvenance > 0) {
    reasons.push(
      `${String(byProvenance)} tour(s) écarté(s) : provenance non fiable — ` +
        'un contenu externe passé par la conversation reste externe.',
    );
  }

  /* --- 2. Tri par utilité --------------------------------------------- */
  // Une affirmation externe non vérifiée ne doit pas remonter devant un fait
  // confirmé, même si elle est textuellement plus proche de la requête.
  const KIND_WEIGHT = { FACT: 1, INFERENCE: 0.8, HYPOTHESIS: 0.6, EXTERNAL_CLAIM: 0.4 };
  const sorted = [...permitted].sort((a, b) => {
    const scoreA = a.confidence * KIND_WEIGHT[a.kind];
    const scoreB = b.confidence * KIND_WEIGHT[b.kind];
    if (scoreB !== scoreA) return scoreB - scoreA;
    return b.createdAt.localeCompare(a.createdAt);
  });

  /* --- 3. Budget ------------------------------------------------------- */
  /* Le budget s'applique à ce que l'étape 1 a LAISSÉ PASSER. Compter les
     caractères d'une entité écartée reviendrait à réserver de la place pour
     une donnée qui ne partira pas — et à écarter par budget une mémoire qui
     aurait tenu. */
  const turns = toursFiables.slice(-budget.maxTurns);
  let characters = input.query.length;
  for (const turn of turns) characters += turn.content.length;
  for (const entity of entitesPermises) characters += entity.displayName.length;

  const kept: StoredMemory[] = [];
  let byBudget = 0;

  for (const memory of sorted) {
    if (kept.length >= budget.maxMemories) {
      byBudget += 1;
      continue;
    }
    if (characters + memory.content.length > budget.maxCharacters) {
      byBudget += 1;
      continue;
    }
    kept.push(memory);
    characters += memory.content.length;
  }

  if (byBudget > 0) {
    reasons.push(
      `${String(byBudget)} mémoire(s) écartée(s) par le budget ` +
        `(${String(budget.maxCharacters)} caractères, ${String(budget.maxMemories)} mémoires).`,
    );
  }

  /* Mesuré sur les tours FIABLES : ceux qu'on a écartés pour provenance ont
     déjà leur propre raison, les compter deux fois ferait dire au paquet qu'il
     a écarté plus de tours qu'il n'en a reçu. */
  const droppedTurns = toursFiables.length - turns.length;
  if (droppedTurns > 0) {
    reasons.push(`${String(droppedTurns)} tour(s) de conversation plus ancien(s) écarté(s).`);
  }

  return ok({
    query: input.query,
    entities: entitesPermises,
    memories: kept,
    turns,
    characters,
    omitted: { byPrivacy, byProvenance, byBudget, reasons },
  });
}
