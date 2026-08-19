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
      /**
       * LES PARAMÈTRES QUI DÉSIGNENT SANS NOMMER — ADR-073.
       *
       * Toujours présent, le plus souvent vide. Chaque clé est un paramètre
       * d'`input` dont la valeur est un RÉFÉRENT — « ça », « celui-ci » — et
       * non le contenu voulu.
       *
       * ⚠ CE CHAMP FERME UN DÉFAUT ACTIF. « Ajoute **ça** à ma liste » matchait
       * la règle des tâches et créait une tâche INTITULÉE « ça ». Le moteur
       * passait le référent comme s'il était le texte.
       *
       * Le moteur ne RÉSOUT rien : reconnaître qu'un mot désigne autre chose est
       * une décision de texte, donc `Tier 0`. Résoudre demande la base, donc
       * l'Assistant (`docs/26 §4.12`).
       */
      readonly referents: Readonly<Record<string, 'ANAPHORA'>>;
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
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
      };
    },
  },

  /* --- Mémoire : chercher ------------------------------------------------
     PORTÉE EXPLICITE, ET C'EST LE POINT (HIGH-4).

     Cette règle capturait auparavant `retrouve|recherche|cherche` suivi de
     n'importe quoi. « Retrouve le devis du carreleur » et « Cherche le prix
     moyen d'un carrelage » devenaient donc des recherches dans la mémoire
     PERSONNELLE, ne trouvaient rien, et Jarvis répondait « ✓ C'est fait ».

     L'utilisateur ne pouvait pas distinguer « j'ai cherché sur le web, rien
     trouvé » de « j'ai cherché ailleurs que là où tu croyais ». C'est une
     action DIFFÉRENTE de celle demandée, annoncée comme un succès.

     Ne sont donc admises ici que les formulations qui désignent la mémoire
     sans ambiguïté. Un verbe de recherche nu est traité plus bas, comme
     l'ambiguïté qu'il est. */
  {
    id: 'memory_search',
    pattern:
      /^(?:qu(?:'|’)est-ce que (?:je sais|tu sais)(?: sur)?|que sais-tu(?: sur)?|qu(?:'|’)as-tu retenu(?: sur)?|(?:cherche|recherche|retrouve)\s+dans\s+(?:ma|ta)\s+m[ée]moire(?:\s+sur)?)\s+(.+)$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'memory_search',
        input: { query: clean(match[1] ?? '') },
        parameterProvenance: { query: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
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
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
      };
    },
  },

  /* --- Entités : enregistrer ce que l'utilisateur NOMME (ADR-073) --------- */
  {
    /**
     * « enregistre Pierre Dupont comme personne »
     *
     * AUCUNE EXTRACTION. Le genre est DIT par l'utilisateur, pas déduit du nom :
     * « Dupont » ne devient pas une personne parce qu'il ressemble à un nom. La
     * reconnaissance d'entités reste hors de portée du `Tier 0` — ce que cette
     * règle fait, c'est obéir à une déclaration explicite.
     *
     * Sans elle, `entity_create` n'était atteignable que par un appel direct à
     * la passerelle : un outil que la conversation n'atteint pas est un outil
     * que le produit n'a pas.
     */
    id: 'entity_create_explicit',
    pattern:
      /^enregistre\s+(.+?)\s+comme\s+(personne|organisation|projet|lieu|produit|document|[ée]v[ée]nement|t[âa]che|objet|appareil|compte)$/iu,
    build(match) {
      /* La table est ici et NULLE PART AILLEURS : deux tables de correspondance
         finiraient par diverger (ADR-041). Les valeurs sont celles de
         `EntityKind`, que `tests/tools/entities.test.ts` rapproche déjà de la
         contrainte SQL — la chaîne complète est donc liée. */
      const GENRES: Readonly<Record<string, string>> = {
        personne: 'PERSON',
        organisation: 'ORGANIZATION',
        projet: 'PROJECT',
        lieu: 'PLACE',
        produit: 'PRODUCT',
        document: 'DOCUMENT',
        evenement: 'EVENT',
        tache: 'TASK',
        objet: 'OBJECT',
        appareil: 'DEVICE',
        compte: 'ACCOUNT',
      };
      // Les accents sont retirés pour la CLÉ seulement — « événement » et
      // « evenement » désignent la même chose, et l'utilisateur ne doit pas
      // avoir à savoir laquelle nous attendions.
      const brut = (match[2] ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/gu, '');
      return {
        kind: 'TOOL_CALL',
        toolId: 'entity_create',
        input: { displayName: clean(match[1] ?? ''), kind: GENRES[brut] ?? 'OBJECT' },
        parameterProvenance: { displayName: FROM_USER, kind: FROM_USER },
        confidence: 0.95,
        tier: 0,
        // Une déclaration explicite VAUT confirmation : « enregistre X » est une
        // demande, pas une déduction (PRD §137, même raison que « retiens que »).
        userConfirms: true,
        referents: {},
      };
    },
  },

  /* --- Tâches : créer ---------------------------------------------------- */
  {
    /**
     * « ajoute ça à ma liste » — LE RÉFÉRENT, ADR-073.
     *
     * ⚠ CETTE RÈGLE FERME UN DÉFAUT ACTIF. La règle générale ci-dessous matchait
     * « ajoute **ça** à ma liste » et créait une tâche **intitulée « ça »**. Le
     * moteur passait le référent comme s'il était le texte voulu.
     *
     * Elle est placée AVANT la règle générale : l'ordre est la sémantique.
     *
     * Le moteur ne résout rien — il SIGNALE. Résoudre demande la base, donc
     * l'Assistant. `propose()` reste une fonction pure du texte, et c'est une
     * propriété qu'on garde : la compréhension ne doit pas dépendre d'une
     * entrée-sortie.
     */
    id: 'task_create_anaphora',
    pattern:
      /^ajoute\s+(?:ça|ca|cela|celui-ci|celle-ci)\s+(?:à|a|dans)\s+(?:ma|la|mes)\s+(?:liste|t[âa]ches?).*$/iu,
    build() {
      return {
        kind: 'TOOL_CALL',
        toolId: 'task_create',
        // Volontairement VIDE : l'Assistant le remplira, ou demandera.
        input: { title: '', dueAt: null },
        parameterProvenance: { title: FROM_USER, dueAt: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: { title: 'ANAPHORA' },
      };
    },
  },

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
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
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
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
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
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
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
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
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
        // Aucun référent : ces règles portent le texte de l'utilisateur.
        referents: {},
      };
    },
  },
];

/**
 * Expressions qui posent une ÉCHÉANCE.
 *
 * Référence : audit `docs/11` — défaut HIGH-5.
 *
 * « Rappelle-moi jeudi d'appeler le médecin » créait une tâche intitulée
 * « jeudi d'appeler le médecin », sans échéance, et répondait « ✓ C'est fait ».
 * L'utilisateur repartait en croyant qu'un rappel existait pour jeudi.
 *
 * Jarvis ne sait pas encore résoudre une date — c'est un travail de la Phase
 * suivante. En attendant, la seule conduite honnête est de le DIRE. Avaler
 * silencieusement le qualificatif temporel serait exécuter une action
 * différente de celle demandée.
 */
const TEMPORAL_QUALIFIER =
  /\b(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|apr[èe]s-demain|ce soir|ce matin|cet apr[èe]s-midi|la semaine prochaine|le mois prochain|dans\s+\d+\s*(?:minutes?|heures?|jours?|semaines?|mois)|[àa]\s*\d{1,2}\s*h|avant\s+(?:le|la|demain)|le\s+\d{1,2}\s*\/\s*\d{1,2})/iu;

/** Renvoie l'expression temporelle trouvée, ou `null`. */
function temporalQualifier(text: string): string | null {
  const match = TEMPORAL_QUALIFIER.exec(text);
  return match === null ? null : match[0];
}

/**
 * Verbes de recherche sans portée précisée.
 *
 * « Cherche X » ne dit pas OÙ. Jarvis ne sait chercher que dans la mémoire
 * personnelle ; deviner que c'est bien ce qui était demandé serait exactement
 * la substitution silencieuse qu'on vient de retirer.
 */
const BARE_SEARCH = /^(?:cherche|recherche|retrouve|trouve)\s+(.+)$/iu;

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
  { pattern: /\b(cherche sur le web|recherche web|sur internet|sur google|en ligne)\b/iu, capability: 'chercher sur le web' },
  {
    pattern:
      /\b(?:cherche|recherche|retrouve|trouve)\b[^]*\b(?:devis|documents?|pdf|fichiers?|factures?|contrats?|pi[èe]ce jointe)\b/iu,
    capability: 'chercher dans tes documents',
  },
];

/** Réponse unique aux capacités reconnues mais absentes (PRD §23). */
function unavailable(capability: string): IntentProposal {
  return {
    kind: 'UNSUPPORTED',
    understood: `que tu veux ${capability}`,
    missing:
      'cette capacité — elle n\'est pas encore construite. ' +
      'Je sais aujourd\'hui : noter, créer et lister des tâches, ' +
      'mémoriser et rechercher en mémoire.',
  };
}

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

      /* --- Frontière de capacité, AVANT les règles (HIGH-4) --------------
         Une demande qui nomme une capacité absente ne doit jamais atteindre
         une règle qui, elle, correspondrait à une autre capacité. L'ordre
         inverse est précisément ce qui produisait les substitutions
         silencieuses. */
      for (const { pattern, capability } of KNOWN_BUT_UNAVAILABLE) {
        if (pattern.test(raw)) return unavailable(capability);
      }

      for (const rule of RULES) {
        const match = raw.match(rule.pattern);
        if (match !== null) {
          const proposal = rule.build(match, raw);

          /* --- Aucune échéance ne disparaît en silence (HIGH-5) --------- */
          if (proposal.kind === 'TOOL_CALL' && proposal.toolId === 'task_create') {
            const when = temporalQualifier(raw);
            if (when !== null) {
              return {
                kind: 'UNSUPPORTED',
                understood: `que tu veux un rappel daté (« ${when} »)`,
                missing:
                  'la capacité de poser une échéance — je ne sais pas encore ' +
                  'résoudre les dates. Je préfère te le dire plutôt que de ' +
                  'créer une tâche sans date en te laissant croire que le ' +
                  'rappel existe. Sans la date, la demande passe.',
              };
            }
          }
          /* Une règle qui capture une chaîne vide n'a rien compris : mieux
             vaut demander que proposer un outil avec un paramètre vide.

             ⚠ SAUF SI LE CHAMP EST UN RÉFÉRENT — ADR-073, et cette garde avait
             raison de rougir avant l'exception. Elle traduit « l'utilisateur
             n'a pas dit quoi mettre ». Or pour « ajoute **ça** à ma liste », il
             l'a dit : il a dit « ça ». Le champ n'est pas MANQUANT, il est
             DIFFÉRÉ — l'Assistant le résoudra, ou demandera lui-même.

             La distinction compte : sans elle, on répondrait « que dois-je
             retenir exactement ? » à quelqu'un qui vient de désigner quelque
             chose. C'est la question de celui qui n'a pas écouté. */
          if (
            proposal.kind === 'TOOL_CALL' &&
            Object.entries(proposal.input).some(
              ([cle, v]) =>
                typeof v === 'string' &&
                v.length === 0 &&
                proposal.referents[cle] === undefined,
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

      /* --- Un verbe de recherche nu est une AMBIGUÏTÉ (HIGH-4) ----------
         On ne devine pas la portée. On dit ce qu'on sait faire, et on demande. */
      const bare = BARE_SEARCH.exec(raw);
      if (bare !== null) {
        return {
          kind: 'CLARIFY',
          understood: 'une demande de recherche',
          question:
            `Je ne sais chercher que dans ta mémoire personnelle — ni sur le ` +
            `web, ni dans tes documents. Dois-je y chercher « ${clean(bare[1] ?? '')} » ? ` +
            `(sinon, reformule avec « que sais-tu sur … »)`,
        };
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
