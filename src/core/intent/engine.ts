/**
 * Intent Engine — Tier 0.
 *
 * Référence : PRD §21–23 et §32, `00 §R2` (data-local-first + compute-adaptive).
 *
 * POURQUOI DES RÈGLES AVANT UN MODÈLE
 * -----------------------------------
 * Le PRD définit un Tier 0 : « Pas de modèle. Règles / code. » Ce n'est pas un
 * pis-aller en attendant mieux — c'est le tier le plus rapide, le moins cher,
 * le plus déterministe et le seul qui fonctionne avec **zéro modèle installé**.
 *
 * « Ajoute du café à ma liste » n'a jamais eu besoin d'un réseau de neurones.
 * Lui en donner un coûterait de la latence, de l'énergie, et introduirait une
 * variabilité là où il n'y en a aucune.
 *
 * CE QUE CE MODULE NE FAIT PAS
 * ----------------------------
 * Il **propose**. Il n'autorise rien, n'exécute rien, et ne décide d'aucune
 * confirmation. Sa sortie traverse le Policy Gate comme n'importe quelle autre
 * proposition — y compris quand elle vient de règles écrites par nous.
 */
import type { Provenance } from '../types/domain.js';

export type IntentProposal =
  | {
      readonly kind: 'TOOL_CALL';
      readonly toolId: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly parameterProvenance: Readonly<Record<string, Provenance>>;
      readonly confidence: number;
      /** 0 = règles déterministes, 1 = petit modèle local, etc. */
      readonly tier: 0 | 1;
      /**
       * Cet énoncé vaut-il lui-même confirmation de l'utilisateur ?
       *
       * « Retiens que X » EST une demande explicite de mémorisation : exiger
       * une seconde confirmation ajouterait de la friction sans rien protéger
       * (PRD §137). En revanche, une préférence *déduite* d'une conversation
       * ordinaire n'est pas confirmée — elle passe par le Memory Inbox.
       */
      readonly userConfirms: boolean;
    }
  | {
      readonly kind: 'CLARIFY';
      /** UNE seule question (PRD §85). */
      readonly question: string;
      readonly understood: string;
    }
  | {
      readonly kind: 'UNSUPPORTED';
      /**
       * Ce qui a été compris, et ce qui manque.
       *
       * `PRD §23` interdit « Désolé, je n'ai pas compris ». On dit ce qu'on a
       * saisi et ce qui bloque — c'est une information, pas une excuse.
       */
      readonly understood: string;
      readonly missing: string;
    };

/**
 * Le texte saisi par l'utilisateur est une entrée FIABLE.
 *
 * C'est le seul endroit du système où cette affirmation est vraie, et elle
 * mérite d'être isolée ici plutôt que répétée : un contenu lu dans un email ou
 * un PDF passe par la quarantaine et ressort en `EXTERNAL_UNTRUSTED`.
 */
const FROM_USER: Provenance = 'USER';

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  build(match: RegExpMatchArray, raw: string): IntentProposal;
}

/** Nettoie une capture : espaces, ponctuation finale. */
function clean(value: string): string {
  return value.trim().replace(/[.!?;,\s]+$/u, '').trim();
}

const RULES: readonly Rule[] = [
  /* --- Mémoire : retenir ------------------------------------------------- */
  {
    id: 'memory_add',
    pattern:
      /^(?:retiens|souviens-toi|rappelle-toi|m[ée]morise)\s+(?:que\b|:)?\s*(.*)$/iu,
    build(match) {
      const content = clean(match[1] ?? '');
      return {
        kind: 'TOOL_CALL',
        toolId: 'memory_add',
        input: {
          content,
          memoryType: 'SEMANTIC',
          // L'utilisateur l'a dit explicitement — mais le Memory Guard
          // vérifiera qu'une confirmation accompagne bien cette prétention.
          sourceType: 'USER_EXPLICIT',
          dataCategory: 'PERSONAL_MEMORY',
          source: 'conversation',
          suggestedConfidence: 0.9,
        },
        parameterProvenance: {
          content: FROM_USER,
          memoryType: 'SYSTEM',
          sourceType: 'SYSTEM',
          dataCategory: 'SYSTEM',
          subjectEntityId: 'SYSTEM',
        },
        confidence: 0.95,
        tier: 0,
        // Le verbe employé est un ordre de mémorisation : c'est la
        // confirmation.
        userConfirms: true,
      };
    },
  },

  /* --- Mémoire : chercher ------------------------------------------------ */
  {
    id: 'memory_search',
    pattern:
      /^(?:qu(?:'|’)est-ce que (?:je sais|tu sais)(?: sur)?|que sais-tu(?: sur)?|retrouve|recherche|cherche)\s+(.+)$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'memory_search',
        input: { query: clean(match[1] ?? '') },
        parameterProvenance: { query: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
      };
    },
  },
  {
    id: 'memory_search_decision',
    // Volontairement permissive : toute question portant sur une décision
    // passée devient une recherche mémoire. Tenter d'énumérer les tournures
    // françaises possibles était fragile — la première version échouait déjà
    // sur l'auxiliaire intercalé de « qu'on AVAIT décidé ».
    //
    // `(?![\p{L}])` plutôt que `\b` en fin de motif : en JavaScript, `\b` se
    // fonde sur `\w`, c'est-à-dire l'ASCII. « décidé » se termine par un
    // accent, donc aucune frontière de mot n'y est reconnue et `\b` échoue.
    // Piège systématique dès qu'on écrit des règles en français.
    pattern:
      /^(?:qu|que|quoi|rappelle)[^]*?\bd[ée]cid[ée]e?s?(?![\p{L}])\s*(?:concernant|pour|[àa] propos de|sur|au sujet de)?\s*(.*)$/iu,
    build(match, raw) {
      const subject = clean(match[1] ?? '');
      return {
        kind: 'TOOL_CALL',
        toolId: 'memory_search',
        input: { query: subject.length > 0 ? subject : clean(raw) },
        parameterProvenance: { query: FROM_USER },
        confidence: 0.85,
        tier: 0,
        userConfirms: false,
      };
    },
  },

  /* --- Tâches : créer ---------------------------------------------------- */
  {
    id: 'task_create_list',
    pattern: /^ajoute\s+(.+?)\s+(?:à|a|dans)\s+(?:ma|la)\s+liste.*$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'task_create',
        input: { title: clean(match[1] ?? ''), dueAt: null },
        parameterProvenance: { title: FROM_USER, dueAt: FROM_USER },
        confidence: 0.95,
        tier: 0,
        userConfirms: false,
      };
    },
  },
  {
    id: 'task_create_reminder',
    pattern: /^rappelle-moi\s+(?:de\s+|d(?:'|’))?(.+)$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'task_create',
        input: { title: clean(match[1] ?? ''), dueAt: null },
        parameterProvenance: { title: FROM_USER, dueAt: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
      };
    },
  },
  {
    id: 'task_create_explicit',
    pattern: /^(?:cr[ée]e|ajoute)\s+(?:une\s+)?t[âa]che\s*:?\s*(.+)$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'task_create',
        input: { title: clean(match[1] ?? ''), dueAt: null },
        parameterProvenance: { title: FROM_USER, dueAt: FROM_USER },
        confidence: 0.95,
        tier: 0,
        userConfirms: false,
      };
    },
  },

  /* --- Tâches : lister --------------------------------------------------- */
  {
    id: 'task_list',
    pattern:
      /^(?:mes t[âa]ches|liste (?:mes )?t[âa]ches|qu(?:'|’)est-ce que j(?:'|’)ai [àa] faire|quoi de pr[ée]vu)\s*\??$/iu,
    build() {
      return {
        kind: 'TOOL_CALL',
        toolId: 'task_list',
        input: { state: 'OPEN' },
        parameterProvenance: { state: 'SYSTEM' },
        confidence: 0.95,
        tier: 0,
        userConfirms: false,
      };
    },
  },

  /* --- Notes ------------------------------------------------------------- */
  {
    id: 'note_create',
    // `que\b` plutôt que `que\s+` : « Note que » tout court doit capturer une
    // chaîne vide, donc déclencher une demande de précision — et non créer une
    // note dont le contenu serait le mot « que ».
    pattern: /^note\s+(?:que\b|:)?\s*(.*)$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'note_create',
        input: { content: clean(match[1] ?? '') },
        parameterProvenance: { content: FROM_USER, privacyClass: 'SYSTEM' },
        confidence: 0.95,
        tier: 0,
        userConfirms: false,
      };
    },
  },
];

/**
 * Demandes reconnues mais non réalisables aujourd'hui.
 *
 * Les nommer explicitement vaut mieux que de les laisser tomber dans
 * « non compris » : l'utilisateur doit savoir si Jarvis n'a pas saisi sa
 * phrase, ou s'il l'a parfaitement saisie mais ne sait pas encore le faire
 * (PRD §23, et proposition n°13 « Capability Registry »).
 */
const KNOWN_BUT_UNAVAILABLE: readonly { pattern: RegExp; capability: string }[] = [
  { pattern: /\benvoie?\b.*\b(mail|email|message|sms)\b/iu, capability: 'envoyer un message' },
  { pattern: /\b(rendez-vous|agenda|calendrier|r[ée]union)\b/iu, capability: 'accéder à l\'agenda' },
  { pattern: /\b(supprime|efface|oublie)\b/iu, capability: 'supprimer une donnée' },
  { pattern: /\b(allume|[ée]teins|chauffage|lumi[èe]re)\b/iu, capability: 'contrôler la maison' },
  { pattern: /\bm[ée]t[ée]o\b/iu, capability: 'consulter la météo' },
  { pattern: /\b(cherche sur le web|recherche web|sur internet)\b/iu, capability: 'chercher sur le web' },
];

export interface IntentEngine {
  /** `text` est la saisie brute de l'utilisateur — fiable, mais pas structurée. */
  propose(text: string): IntentProposal;
}

export function createIntentEngine(): IntentEngine {
  return {
    propose(text: string): IntentProposal {
      const raw = text.trim();

      if (raw.length === 0) {
        return {
          kind: 'UNSUPPORTED',
          understood: 'une saisie vide',
          missing: 'la demande elle-même',
        };
      }

      for (const rule of RULES) {
        const match = raw.match(rule.pattern);
        if (match !== null) {
          const proposal = rule.build(match, raw);
          // Une règle qui capture une chaîne vide n'a rien compris : mieux
          // vaut demander que proposer un outil avec un paramètre vide.
          if (
            proposal.kind === 'TOOL_CALL' &&
            Object.values(proposal.input).some(
              (v) => typeof v === 'string' && v.length === 0,
            )
          ) {
            return {
              kind: 'CLARIFY',
              understood: `une demande de type ${proposal.toolId}`,
              question: 'Que dois-je retenir exactement ?',
            };
          }
          return proposal;
        }
      }

      for (const { pattern, capability } of KNOWN_BUT_UNAVAILABLE) {
        if (pattern.test(raw)) {
          return {
            kind: 'UNSUPPORTED',
            understood: `que tu veux ${capability}`,
            missing:
              'cette capacité — elle n\'est pas encore construite. ' +
              'Je sais aujourd\'hui : noter, créer et lister des tâches, ' +
              'mémoriser et rechercher en mémoire.',
          };
        }
      }

      return {
        kind: 'UNSUPPORTED',
        understood: 'ta phrase, mais pas ce qu\'elle demande',
        missing:
          'une formulation que je reconnais. Essaie : « note … », ' +
          '« ajoute … à ma liste », « mes tâches », « retiens que … », ' +
          '« que sais-tu sur … ».',
      };
    },
  };
}
