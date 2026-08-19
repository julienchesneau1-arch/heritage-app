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
import { reconnaitre } from '../temps/expression.js';

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
       *
       * DEUX ESPÈCES DE RÉFÉRENT — ADR-077 a ajouté la seconde.
       *
       * ```text
       * ANAPHORA   « ça », « celui-ci »   → désigne une ENTITÉ évoquée
       * TEMPORAL   « jeudi », « demain »  → désigne un INSTANT non nommé
       * ```
       *
       * Elles partagent la même table plutôt que d'en avoir deux, et ce n'est
       * pas de l'économie : ce sont **le même fait** — un champ dont la valeur
       * n'est pas encore la valeur. Deux tables du même fait finissent par
       * diverger (ADR-041), et la garde du champ vide devrait alors consulter
       * les deux en se souvenant de le faire.
       *
       * « Jeudi » est bien un référent : il désigne un instant sans le nommer,
       * et seul un état extérieur — la date du jour, connue de la base — permet
       * de savoir lequel.
       */
      readonly referents: Readonly<Record<string, 'ANAPHORA' | 'TEMPORAL'>>;
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
  /**
   * LA FORMULATION CANONIQUE — ce que l'utilisateur doit dire pour l'atteindre.
   *
   * ⚠ CE CHAMP EXISTE PARCE QUE LA LISTE DES CAPACITÉS VIVAIT À SIX ENDROITS,
   * ET QU'ELLE AVAIT DIVERGÉ (ADR-075). Le moteur disait *« je ne sais pas
   * chercher sur le web »* alors que `web_search` existait depuis ADR-055 ;
   * *« je ne sais pas accéder à l'agenda »* alors que trois outils d'agenda
   * étaient écrits. Jarvis mentait sur lui-même — pas sur un effet, sur son
   * propre catalogue.
   *
   * ADR-041 l'avait tranché pour les données : *deux registres du même fait
   * finissent par diverger, et le jour où ils divergent aucun ne fait
   * autorité.* Une capacité se déclare donc ICI, à côté de la règle qui la rend
   * vraie, et nulle part ailleurs.
   */
  readonly exemple: string;
  /**
   * `null` = « la forme correspond, mais ce cas n'est pas le mien ».
   *
   * Ajouté par ADR-077 : « rappelle-moi … » est un rappel s'il porte une date,
   * une tâche sinon. Deux règles partagent donc le même motif, et la première
   * décline. L'alternative — un seul `build` qui choisit son outil — mélangeait
   * deux capacités dans une règle et rendait `exemple` impossible à écrire.
   */
  build(match: RegExpMatchArray, raw: string): IntentProposal | null;
}

/** Nettoie une capture : espaces, ponctuation finale. */
function clean(value: string): string {
  return value.trim().replace(/[.!?;,\s]+$/u, '').trim();
}

const RULES: readonly Rule[] = [
  /* --- Mémoire : retenir ------------------------------------------------- */
  {
    id: 'memory_add',
    exemple: '« retiens que … »',
    pattern:
      /^(?:retiens|souviens-toi|rappelle-toi|m[ée]morise)\s+(?:que(?![\p{L}\p{N}_])|:)?\s*(.*)$/iu,
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
    exemple: '« que sais-tu sur … »',
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
    exemple: '« que sais-tu sur … »',
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
      /^(?:qu|que|quoi|rappelle)[^]*?(?<![\p{L}\p{N}_])d[ée]cid[ée]e?s?(?![\p{L}\p{N}_])\s*(?:concernant|pour|[àa] propos de|sur|au sujet de)?\s*(.*)$/iu,
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
    exemple: '« enregistre <nom> comme personne »',
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
    exemple: '« ajoute … à ma liste »',
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
    exemple: '« ajoute … à ma liste »',
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
  /* --- Rappel DATÉ : la règle que Julien attendait — ADR-077 -------------
     ⚠ ELLE DOIT PRÉCÉDER `task_create_reminder`, qui capture la même phrase.

     Avant ADR-077, « rappelle-moi jeudi d'appeler le médecin » tombait sur la
     garde `TEMPORAL_QUALIFIER` et rendait UNSUPPORTED : Jarvis disait
     honnêtement qu'il ne savait pas résoudre les dates. Il le sait désormais,
     et c'est la base qui les calcule.

     La date n'est PAS résolue ici : `remindAt` porte l'expression telle que
     dite — « jeudi » — et le marqueur `TEMPORAL` dit à l'Assistant de la faire
     résoudre. Le moteur reste une fonction pure du texte (ADR-073), et
     ADR-036/037 restent tenus : aucune horloge de processus n'intervient. */
  {
    id: 'reminder_create_date',
    exemple: '« rappelle-moi jeudi de … »',
    pattern:
      /^rappelle-moi\s+(?:de\s+|d(?:'|’))?(.+)$/iu,
    build(match) {
      const dit = clean(match[1] ?? '');

      /* UNE SEULE AUTORITÉ SUR CE QU'EST UNE DATE — et la première rédaction
         en avait deux. Elle employait `temporalQualifier`, dont le motif
         diffère de celui de `reconnaitre` : « demain matin » y rendait
         « demain », l'heure du matin était perdue et le texte du rappel
         devenait « matin de sortir la poubelle ». ADR-041, encore.

         `reconnaitre` est PUR — aucune horloge — donc le moteur reste une
         fonction du texte (ADR-073), et ADR-036/037 restent tenus. */
      const lu = reconnaitre(dit);

      /* Sans expression temporelle, ce n'est pas un rappel : c'est une tâche.
         On rend `null` pour laisser la règle suivante s'en saisir — un rappel
         sans date ne sonnerait jamais, et prétendre le contraire serait le
         mensonge que `docs/06` interdit. */
      if (lu === null) return null;

      /* `remindAt` porte l'énoncé TEL QUEL. L'Assistant lui appliquera la même
         fonction pure sur le même argument : deux appels déterministes de la
         même fonction ne peuvent pas diverger — ce n'est donc pas un second
         registre, contrairement à ce que la forme suggère. */
      return {
        kind: 'TOOL_CALL',
        toolId: 'reminder_create',
        input: { text: lu.reste, remindAt: dit },
        parameterProvenance: { text: FROM_USER, remindAt: FROM_USER },
        confidence: 0.9,
        tier: 0,
        /* PAS de confirmation implicite : l'heure retenue peut être un défaut
           (9 h), et l'utilisateur doit VOIR l'instant avant qu'il soit posé.
           C'est ce qui rend `HEURE_PAR_DEFAUT` honnête plutôt qu'inventé. */
        userConfirms: false,
        referents: { remindAt: 'TEMPORAL' },
      };
    },
  },
  {
    id: 'task_create_reminder',
    exemple: '« ajoute … à ma liste »',
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
    exemple: '« ajoute … à ma liste »',
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
    exemple: '« mes tâches »',
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
    exemple: '« note … »',
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

  /* ====================================================================== *
   * LES QUATRE RÈGLES D'ADR-075 — des outils qui existaient sans porte
   * ====================================================================== *
   *
   * Chacune rend atteignable un outil ÉCRIT, ÉPROUVÉ, et que la conversation
   * n'atteignait pas. Trois d'entre elles ferment un MENSONGE : le moteur
   * répondait « cette capacité n'est pas encore construite » sur des capacités
   * construites depuis plusieurs commits.
   *
   * LA PORTÉE RESTE EXPLICITE, et c'est ce qui les distingue d'un élargissement
   * commode. « Cherche X » n'est toujours pas accepté : il ne dit pas OÙ, et
   * deviner la portée est exactement la substitution silencieuse que HIGH-4
   * avait fait retirer. Ce qui change, c'est qu'il y a désormais TROIS portées
   * nommables au lieu d'une.
   */

  /* --- Web : la portée est DITE ------------------------------------------ */
  {
    id: 'web_search_explicit',
    exemple: '« cherche sur le web … »',
    pattern:
      /^(?:cherche|recherche|trouve)\s+(?:sur\s+(?:le\s+web|internet|google)|en\s+ligne)\s+(.+)$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'web_search',
        input: { query: clean(match[1] ?? '') },
        parameterProvenance: { query: FROM_USER },
        confidence: 0.9,
        tier: 0,
        /* PAS de confirmation implicite. Une recherche web est une SORTIE de
           données vers un tiers : elle traverse le Data Firewall, et c'est lui
           qui décide. L'énoncé ne vaut pas accord pour une égression. */
        userConfirms: false,
        referents: {},
      };
    },
  },

  /* --- Documents : la portée est DITE ------------------------------------ */
  {
    id: 'file_search_explicit',
    exemple: '« cherche dans mes documents … »',
    pattern:
      /^(?:cherche|recherche|trouve)\s+(?:dans\s+(?:mes\s+)?(?:documents?|fichiers?)|le\s+fichier)\s+(.+)$/iu,
    build(match) {
      return {
        kind: 'TOOL_CALL',
        toolId: 'file_search',
        input: { query: clean(match[1] ?? '') },
        parameterProvenance: { query: FROM_USER, path: 'SYSTEM', limit: 'SYSTEM' },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: {},
      };
    },
  },

  /* --- Briefing : aucun paramètre à extraire ----------------------------- */
  {
    id: 'briefing_du_jour',
    exemple: '« fais-moi un point »',
    pattern:
      /^(?:fais(?:-moi)?\s+un\s+point|o[ùu]\s+en\s+suis-je|ma\s+journ[ée]e|quoi\s+de\s+neuf|r[ée]sume\s+ma\s+journ[ée]e)\s*[?.!]*$/iu,
    build() {
      return {
        kind: 'TOOL_CALL',
        toolId: 'briefing_generate',
        input: {},
        parameterProvenance: { limit: 'SYSTEM' },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: {},
      };
    },
  },

  /* --- État du système : aucun paramètre non plus ------------------------ */
  {
    id: 'etat_du_systeme',
    exemple: '« comment vas-tu »',
    pattern:
      /^(?:comment\s+(?:vas-tu|ça\s+va|ca\s+va)|[ée]tat\s+du\s+syst[èe]me|tout\s+va\s+bien)\s*[?.!]*$/iu,
    build() {
      return {
        kind: 'TOOL_CALL',
        toolId: 'system_status',
        input: {},
        parameterProvenance: {},
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: {},
      };
    },
  },
];

/**
 * CE QUE JARVIS SAIT FAIRE EN L'ÉCOUTANT — la source UNIQUE.
 *
 * Dérivée des règles, jamais recopiée. C'est le correctif d'ADR-075 : cette
 * liste vivait à **six** endroits — deux messages du moteur, la question
 * d'ambiguïté, l'aide du CLI, et deux tables de capacités absentes — et les six
 * avaient divergé au fil des outils ajoutés.
 *
 * Un texte qui énumère les capacités et qu'aucun mécanisme ne relie aux règles
 * est un texte qui deviendra faux. La seule question est quand.
 */
export function capacitesParlees(): readonly string[] {
  // `Set` : plusieurs règles servent la même capacité (quatre pour les tâches,
  // deux pour la mémoire). L'utilisateur n'a pas à connaître nos règles.
  return [...new Set(RULES.map((r) => r.exemple))];
}

/**
 * La formulation canonique d'UNE règle, par son identifiant.
 *
 * Pour les messages qui doivent nommer des capacités PRÉCISES plutôt que la
 * liste entière — la question de portée, par exemple, qui propose trois
 * endroits où chercher. Sans cette fonction, ce message les recopierait, et il
 * les recopiait : c'est ainsi qu'il en est venu à affirmer *« ni sur le web,
 * ni dans tes documents »* alors que les deux existaient.
 */
function exempleDe(ruleId: string): string {
  const rule = RULES.find((r) => r.id === ruleId);
  /* Un identifiant inconnu est un défaut de programmation, pas une condition
     d'exploitation : le rendre visible tout de suite vaut mieux qu'afficher un
     trou dans une phrase adressée à l'utilisateur. */
  if (rule === undefined) throw new Error(`règle inconnue : ${ruleId}`);
  return rule.exemple;
}

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
  /(?<![\p{L}\p{N}_])(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|demain|apr[èe]s-demain|ce soir|ce matin|cet apr[èe]s-midi|la semaine prochaine|le mois prochain|dans\s+\d+\s*(?:minutes?|heures?|jours?|semaines?|mois)|[àa]\s*\d{1,2}\s*h|avant\s+(?:le|la|demain)|le\s+\d{1,2}\s*\/\s*\d{1,2})/iu;

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
interface Absente {
  readonly pattern: RegExp;
  readonly capability: string;
  /**
   * L'outil qui SERVIRAIT cette capacité, ou `null` si aucun n'est écrit.
   *
   * ⚠ CE CHAMP REND L'AFFIRMATION VÉRIFIABLE, et c'est tout son objet.
   * `tests/intent/capacites-declarees.test.ts` exige qu'un outil nommé ici soit
   * ABSENT du catalogue. Le jour où quelqu'un l'écrit, la CI rougit et force à
   * changer le message — au lieu de le laisser mentir en silence pendant vingt
   * commits, ce qui est exactement ce qui s'est passé.
   */
  readonly outilQuiManque: string | null;
}

/**
 * ⚠ QUATRE DE CES ENTRÉES ÉTAIENT FAUSSES — ADR-075.
 *
 * Le moteur répondait *« cette capacité n'est pas encore construite »* pour
 * `web_search` (écrit à ADR-055), `file_search` (ADR-046), les trois outils
 * d'agenda (ADR-043/044/045) et `memory_forget` / `note_delete` (ADR-065/067).
 *
 * Ce n'est pas un mensonge sur un EFFET — aucune action n'était annoncée à
 * tort. C'est un mensonge sur le CATALOGUE, et il coûte la même chose :
 * l'utilisateur renonce à demander ce que Jarvis sait faire.
 */
const KNOWN_BUT_UNAVAILABLE: readonly Absente[] = [
  {
    pattern: /\benvoie?\b.*\b(mail|email|message|sms)\b/iu,
    capability: 'envoyer un message',
    // Vrai : aucun outil d'envoi n'existe, et c'est ce qui bloque A8.
    outilQuiManque: 'message_send',
  },
  {
    /* L'AGENDA EXISTE — le message change de nature.
       `calendar_read`, `calendar_create` et `calendar_update` sont écrits et
       éprouvés. Ce qui manque est double, et aucune des deux moitiés n'est
       « la capacité » : (1) aucun ADAPTATEUR n'est branché, donc l'outil rend
       `PROVIDER_UNAVAILABLE` ; (2) une règle `Tier 0` ne peut pas produire les
       dates ISO qu'il exige — et ADR-036/037 interdisent de les calculer avec
       l'horloge du processus. Voir ADR-075. */
    pattern: /(?<![\p{L}\p{N}_])(rendez-vous|agenda|calendrier|r[ée]union)(?![\p{L}\p{N}_])/iu,
    capability:
      'accéder à l\'agenda — je sais le lire et l\'écrire, mais aucun agenda ' +
      'n\'est connecté, et je ne sais pas encore résoudre une date dite en ' +
      'français',
    outilQuiManque: null,
  },
  {
    /* SUPPRIMER EXISTE — mais seulement sur ma dernière action.
       `memory_forget`, `note_delete`, `task_cancel` et `reminder_cancel` sont
       écrits. Ils exigent un identifiant qu'une phrase ne porte pas : désigner
       « cette note » demande une résolution qui n'existe que pour la dernière
       opération, par `/annule`. Le dire vaut mieux que de prétendre l'inverse
       dans un sens comme dans l'autre. */
    pattern: /\b(supprime|efface|oublie)\b/iu,
    capability:
      'supprimer une donnée — je sais défaire ma dernière action avec ' +
      '« /annule », mais pas encore supprimer un élément que tu me désignes',
    outilQuiManque: null,
  },
  {
    pattern: /(?<![\p{L}\p{N}_])(allume|[ée]teins|chauffage|lumi[èe]re)(?![\p{L}\p{N}_])/iu,
    capability: 'contrôler la maison',
    outilQuiManque: 'home_control',
  },
  {
    pattern: /(?<![\p{L}\p{N}_])m[ée]t[ée]o(?![\p{L}\p{N}_])/iu,
    capability: 'consulter la météo',
    outilQuiManque: 'weather_read',
  },
];

/** Réponse unique aux capacités reconnues mais absentes (PRD §23). */
function unavailable(capability: string): IntentProposal {
  return {
    kind: 'UNSUPPORTED',
    understood: `que tu veux ${capability}`,
    missing:
      `cette capacité — elle n'est pas encore construite. ` +
      `Je sais aujourd'hui : ${capacitesParlees().join(', ')}.`,
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
          /* Une règle peut RECONNAÎTRE la forme et décliner le cas (ADR-077) :
             « rappelle-moi … » est un rappel s'il porte une date, une tâche
             sinon. On poursuit alors la boucle au lieu de s'arrêter. */
          if (proposal === null) continue;

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
          /* ⚠ CETTE QUESTION AFFIRMAIT « ni sur le web, ni dans tes documents ».
             Les deux étaient FAUX (ADR-075) : `web_search` et `file_search`
             existent. La portée reste à préciser — c'est la propriété de
             HIGH-4 et elle ne bouge pas — mais il y a désormais TROIS réponses
             possibles au lieu d'une seule, et l'utilisateur doit les connaître
             pour pouvoir choisir. */
          question:
            `Où dois-je chercher « ${clean(bare[1] ?? '')} » ? Précise : ` +
            `${exempleDe('memory_search')} (ta mémoire), ` +
            `${exempleDe('web_search_explicit')}, ou ` +
            `${exempleDe('file_search_explicit')}.`,
        };
      }

      return {
        kind: 'UNSUPPORTED',
        understood: 'ta phrase, mais pas ce qu\'elle demande',
        missing:
          `une formulation que je reconnais. Essaie : ${capacitesParlees().join(', ')}.`,
      };
    },
  };
}
