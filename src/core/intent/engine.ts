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
import type { GenreDesigne } from '../context/designation.js';

/**
 * LES TROIS ESPÈCES DE RÉFÉRENT — un champ dont la valeur n'est pas la valeur.
 *
 * Une seule table pour les trois, volontairement : ce sont le même fait, et
 * deux tables du même fait finissent par diverger (ADR-041). La garde qui
 * vérifie qu'un champ référencé est vide devrait sinon consulter les deux en
 * se souvenant de le faire.
 *
 * `DESIGNATION:<GENRE>` porte le genre dans le tag plutôt que dans une seconde
 * clé. Ce n'est pas de la coquetterie : une seconde clé serait facultative, et
 * une règle qui l'oublierait produirait un référent de genre indéfini que
 * l'Assistant devrait deviner — c'est-à-dire exactement ce que tout ce
 * mécanisme existe pour empêcher.
 */
export type EspeceDeReferent =
  | 'ANAPHORA'
  | 'TEMPORAL'
  /**
   * Une mention NOMINALE — « Camille », « le carreleur ».
   *
   * Résolue par `EntityResolver`, qui existait avant ce mécanisme et porte ce
   * qu'un résolveur de désignation n'a pas : les alias confirmés et la preuve
   * contextuelle de session. La réutiliser plutôt que la réécrire est ce qui
   * évite deux registres de « comment on retrouve une personne » (ADR-041).
   */
  | 'MENTION'
  /**
   * Les DEUX bornes d'une journée — ADR-097.
   *
   * « Qu'ai-je demain » ne désigne pas un instant : il désigne une JOURNÉE.
   * `calendar_read` prend deux bornes, et elles doivent venir du même calcul —
   * deux résolutions séparées à minuit moins une seconde encadreraient deux
   * jours différents.
   *
   * L'Assistant résout donc la fenêtre UNE fois, depuis le champ `:DEBUT`, et
   * remplit les deux.
   */
  | 'FENETRE:DEBUT'
  | 'FENETRE:FIN'
  /**
   * La FIN d'un événement, faute de l'avoir dite — ADR-097.
   *
   * « Crée un rendez-vous jeudi à 14h » ne donne aucune heure de fin. La
   * refuser rendrait la règle inutilisable ; l'inventer en silence serait le
   * défaut d'HIGH-5 sur un effet EXTERNE — un événement chez Google, visible
   * par ses invités.
   *
   * On applique donc la discipline d'`HEURE_PAR_DEFAUT` (ADR-077) : un défaut
   * MONTRÉ n'est pas un mensonge. `calendar_create` est `L3`, donc la
   * confirmation affiche l'heure de fin retenue avant toute écriture.
   */
  | 'TEMPORAL:FIN_PAR_DEFAUT'
  | `DESIGNATION:${GenreDesigne}`;

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
       * ANAPHORA     « ça », « celui-ci »       → une ENTITÉ évoquée
       * TEMPORAL     « jeudi », « demain »      → un INSTANT non nommé
       * DESIGNATION  « la note du carreleur »   → une LIGNE, cherchée par son
       *                                           nom dans la base  (ADR-096)
       * ```
       *
       * La troisième a ouvert six outils d'un coup. Ils étaient écrits,
       * éprouvés, conformes — et hors d'atteinte, parce qu'ils exigent un
       * identifiant qu'une phrase ne porte pas.
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
      readonly referents: Readonly<Record<string, EspeceDeReferent>>;
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


/**
 * UNE DÉSIGNATION QUI NE DÉSIGNE RIEN — ADR-096.
 *
 * ⚠ CETTE FONCTION FERME UN DÉFAUT QUE J'AI INTRODUIT, PUIS MESURÉ.
 *
 * La première version des règles de suppression acceptait n'importe quelle
 * capture. Résultat mesuré, avant toute correction :
 *
 * ```text
 * « efface ça »  →  memory_forget { memoryId: "ça" }
 * ```
 *
 * C'est EXACTEMENT le défaut d'ADR-073 — « ajoute ça à ma liste » créait une
 * tâche intitulée « ça » — reproduit dans un outil `L4`, **irréversible**.
 * L'Assistant aurait cherché les mémoires contenant littéralement « ça », et
 * en aurait effacé une si une seule correspondait.
 *
 * Un pronom ou un nom commun nu ne désigne pas : il RENVOIE. Ces mots ne
 * peuvent pas fonder une suppression, et la règle doit alors DEMANDER.
 */
const DESIGNATION_CREUSE =
  /^(?:(?:ce|cet|cette|ces|ça|ca|cela|ceci|celui-ci|celle-ci|la|le|les|l|mon|ma|mes|un|une|des)\s*)*(?:notes?|t[âa]ches?|rappels?|m[ée]moires?|fiches?|personnes?|contacts?|[ée]l[ée]ments?|trucs?|choses?)?\s*$/iu;

/**
 * La question posée quand la cible n'est pas nommée.
 *
 * Elle dit le chemin qui MARCHE plutôt que de constater l'échec : `/annule`
 * couvre la dernière action sans qu'aucun nom soit nécessaire. C'est la règle
 * de `PRD §23` — on ne répond jamais « je n'ai pas compris » tout court.
 */
function ciblerPlutotQueDeviner(quoi: string): IntentProposal {
  return {
    kind: 'CLARIFY',
    question:
      `Quelle ${quoi} exactement ? Nomme-la — par exemple « supprime la `
      + `${quoi} du carreleur ». Pour défaire ta dernière action, « /annule » `
      + 'suffit et ne demande aucun nom.',
    understood: `que tu veux supprimer une ${quoi}, sans savoir laquelle. `
      + '« /annule » défait la dernière action.',
  };
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
      /^(?:qu(?:'|’)est-ce que (?:je sais|tu sais)(?: sur)?|que sais-tu(?: sur)?|qu(?:'|’)as-tu retenu(?: sur)?|montre(?:-moi)?\s+(?:tout\s+)?ce\s+que\s+tu\s+sais(?:\s+sur)?|dis(?:-moi)?\s+(?:tout\s+)?ce\s+que\s+tu\s+sais(?:\s+sur)?|(?:cherche|recherche|retrouve)\s+dans\s+(?:ma|ta)\s+m[ée]moire(?:\s+sur)?)\s+(.+)$/iu,
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
      /^(?:fais(?:-moi)?\s+(?:un\s+point|le\s+briefing(?:\s+(?:du\s+matin|du\s+jour|de\s+la\s+journ[ée]e))?)|briefing(?:\s+(?:du\s+matin|du\s+jour))?|le\s+point(?:\s+du\s+(?:matin|jour))?|o[ùu]\s+en\s+suis-je|ma\s+journ[ée]e|quoi\s+de\s+neuf|r[ée]sume\s+ma\s+journ[ée]e)\s*[?.!]*$/iu,
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
  /* ====================================================================== *
   * DÉSIGNER PAR LE NOM — ADR-096, et six outils qui sortent de l'ombre
   *
   * Chacune de ces règles porte le texte de la désignation TEL QUEL dans le
   * champ d'identifiant, et le marque `DESIGNATION:<GENRE>`. Le moteur ne
   * cherche rien : `propose()` reste une fonction PURE du texte (ADR-073).
   * C'est l'Assistant qui interroge la base — et qui DEMANDE si plusieurs
   * lignes répondent.
   *
   * ⚠ L'ORDRE COMPTE. Ces règles doivent précéder toute règle générale qui
   * capturerait les mêmes verbes, et elles suivent la garde
   * `KNOWN_BUT_UNAVAILABLE` — d'où le retrait, dans la même passe, de l'entrée
   * qui déclarait la suppression « pas encore construite ». Une capacité niée
   * est aussi absente qu'une capacité manquante (ADR-075).
   * ====================================================================== */

  /* --- Tâches : terminer -------------------------------------------------- */
  {
    id: 'task_complete_designee',
    exemple: '« termine la tâche … »',
    pattern:
      /^(?:termine|j(?:'|’)ai\s+(?:fait|fini|termin[ée])|coche|marque)\s+(?:(?:la|ma|cette)\s+)?(?:t[âa]ches?\s+)?(?:du\s+|de\s+la\s+|des\s+|de\s+|sur\s+|d(?:'|’))?(.*?)\s*(?:comme\s+(?:faite?|termin[ée]e?))?\s*[?.!]*$/iu,
    build(match) {
      const cible = clean(match[1] ?? '');
      if (DESIGNATION_CREUSE.test(cible)) return ciblerPlutotQueDeviner('tâche');
      return {
        kind: 'TOOL_CALL',
        toolId: 'task_complete',
        input: { taskId: cible },
        parameterProvenance: { taskId: FROM_USER },
        confidence: 0.85,
        tier: 0,
        userConfirms: false,
        referents: { taskId: 'DESIGNATION:TASK' },
      };
    },
  },

  /* --- Tâches : annuler --------------------------------------------------- */
  {
    id: 'task_cancel_designee',
    exemple: '« annule la tâche … »',
    pattern: /^(?:annule|supprime|retire)\s+(?:(?:la|ma|cette|une|mes)\s+)?t[âa]ches?\s*(?:du\s+|de\s+la\s+|de\s+|sur\s+|d(?:'|’))?(.*?)\s*[?.!]*$/iu,
    build(match) {
      const cible = clean(match[1] ?? '');
      if (DESIGNATION_CREUSE.test(cible)) return ciblerPlutotQueDeviner('tâche');
      return {
        kind: 'TOOL_CALL',
        toolId: 'task_cancel',
        input: { taskId: cible },
        parameterProvenance: { taskId: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: { taskId: 'DESIGNATION:TASK' },
      };
    },
  },

  /* --- Rappels : annuler -------------------------------------------------- */
  {
    id: 'reminder_cancel_designe',
    exemple: '« annule le rappel … »',
    pattern: /^(?:annule|supprime|retire)\s+(?:(?:le|mon|ce|cet|mes)\s+)?rappels?\s*(?:du\s+|de\s+la\s+|des\s+|de\s+|pour\s+|sur\s+|d(?:'|’))?(.*?)\s*[?.!]*$/iu,
    build(match) {
      const cible = clean(match[1] ?? '');
      if (DESIGNATION_CREUSE.test(cible)) return ciblerPlutotQueDeviner('rappel');
      return {
        kind: 'TOOL_CALL',
        toolId: 'reminder_cancel',
        input: { reminderId: cible },
        parameterProvenance: { reminderId: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: { reminderId: 'DESIGNATION:REMINDER' },
      };
    },
  },

  /* --- Notes : supprimer — L4, irréversible ------------------------------- */
  {
    id: 'note_delete_designee',
    exemple: '« supprime la note … »',
    pattern: /^(?:supprime|efface|retire)\s+(?:(?:la|ma|cette|une|des|mes)\s+)?notes?\s*(?:du\s+|de\s+la\s+|des\s+|de\s+|sur\s+|d(?:'|’))?(.*?)\s*[?.!]*$/iu,
    build(match) {
      const cible = clean(match[1] ?? '');
      if (DESIGNATION_CREUSE.test(cible)) return ciblerPlutotQueDeviner('note');
      return {
        kind: 'TOOL_CALL',
        toolId: 'note_delete',
        input: { noteId: cible },
        parameterProvenance: { noteId: FROM_USER },
        confidence: 0.9,
        tier: 0,
        /* `false`, et c'est structurant : `note_delete` est L4. La
           confirmation portera sur la VALEUR résolue — donc sur la note
           réellement visée, pas sur l'intention de supprimer. C'est toute la
           différence entre « confirmer une suppression » et « confirmer
           CETTE suppression ». */
        userConfirms: false,
        referents: { noteId: 'DESIGNATION:NOTE' },
      };
    },
  },

  /* --- Mémoire : oublier — L4, irréversible ------------------------------- */
  {
    id: 'memory_forget_designee',
    exemple: '« oublie que … »',
    pattern: /^(?:oublie|efface)\s+(?:que\s+|ce\s+que\s+(?:tu\s+sais|je\s+t(?:'|’)ai\s+dit)\s+sur\s+|la\s+m[ée]moire\s+|tout\s+ce\s+que\s+tu\s+sais\s+sur\s+)?(.*?)\s*[?.!]*$/iu,
    build(match) {
      const cible = clean(match[1] ?? '');
      if (DESIGNATION_CREUSE.test(cible)) return ciblerPlutotQueDeviner('mémoire');
      return {
        kind: 'TOOL_CALL',
        toolId: 'memory_forget',
        input: { memoryId: cible },
        parameterProvenance: { memoryId: FROM_USER },
        confidence: 0.85,
        tier: 0,
        userConfirms: false,
        referents: { memoryId: 'DESIGNATION:MEMORY' },
      };
    },
  },

  /* --- Entités : supprimer — L4, et PAS une désignation ------------------- */
  {
    /**
     * ⚠ `MENTION`, PAS `DESIGNATION:ENTITY`.
     *
     * `EntityResolver` résout déjà les mentions nominales, avec ses alias
     * confirmés et sa preuve contextuelle de session. Ajouter un genre
     * `ENTITY` au résolveur de désignation aurait créé DEUX registres de
     * « comment on retrouve une personne » (ADR-041) — et celui-ci, plus
     * jeune et plus pauvre, aurait été le seul consulté ici.
     */
    id: 'entity_delete_mention',
    exemple: '« supprime la fiche de … »',
    pattern:
      /^(?:supprime|efface|retire)\s+(?:la\s+(?:fiche|personne)\s+(?:de\s+|d(?:'|’))?|le\s+contact\s+)(.+?)\s*[?.!]*$/iu,
    build(match) {
      const cible = clean(match[1] ?? '');
      if (DESIGNATION_CREUSE.test(cible)) return ciblerPlutotQueDeviner('fiche');
      return {
        kind: 'TOOL_CALL',
        toolId: 'entity_delete',
        input: { entityId: cible },
        parameterProvenance: { entityId: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: { entityId: 'MENTION' },
      };
    },
  },

  /* --- Le journal, et ce qui en est sorti --------------------------------- */
  {
    id: 'audit_parle',
    exemple: '« qu’as-tu fait … »',
    pattern:
      /^(?:qu(?:'|’)as-tu\s+fait|qu(?:'|’)est-ce\s+que\s+tu\s+as\s+fait)(?:\s+(aujourd(?:'|’)hui|cette\s+semaine|ce\s+mois(?:-ci)?))?\s*[?.!]*$/iu,
    build(match) {
      /* La fenêtre est LUE dans la phrase quand elle y est, et vaut « today »
         sinon — le défaut du schéma, pas une invention de cette règle. */
      const dit = (match[1] ?? '').toLowerCase();
      const window = dit.includes('semaine')
        ? 'week'
        : dit.includes('mois')
          ? 'month'
          : 'today';
      return {
        kind: 'TOOL_CALL',
        toolId: 'audit_query',
        input: { window, limit: 50 },
        parameterProvenance: { window: 'SYSTEM', limit: 'SYSTEM' },
        confidence: 0.95,
        tier: 0,
        userConfirms: false,
        referents: {},
      };
    },
  },

  {
    id: 'egress_parle',
    exemple: '« qu’est-ce qui est sorti de la machine »',
    pattern:
      /^(?:qu(?:'|’)est-ce\s+qui\s+(?:est\s+sorti|a\s+quitt[ée])|qu(?:'|’)as-tu\s+envoy[ée])(?:\s+de\s+(?:la\s+)?machine)?(?:\s+(aujourd(?:'|’)hui|cette\s+semaine|ce\s+mois(?:-ci)?))?\s*[?.!]*$/iu,
    build(match) {
      const dit = (match[1] ?? '').toLowerCase();
      const window = dit.includes('aujourd')
        ? 'today'
        : dit.includes('mois')
          ? 'month'
          : 'week';
      return {
        kind: 'TOOL_CALL',
        toolId: 'egress_review',
        input: { window, limit: 50 },
        parameterProvenance: { window: 'SYSTEM', limit: 'SYSTEM' },
        confidence: 0.95,
        tier: 0,
        userConfirms: false,
        referents: {},
      };
    },
  },
  /* ====================================================================== *
   * L'AGENDA — ADR-097
   *
   * ⚠ CES RÈGLES ONT ATTENDU UNE RAISON QUI N'EXISTE PLUS.
   *
   * `KNOWN_BUT_UNAVAILABLE` disait : « je sais le lire et l'écrire, mais aucun
   * agenda n'est connecté, ET JE NE SAIS PAS ENCORE RÉSOUDRE UNE DATE DITE EN
   * FRANÇAIS ». La seconde moitié est fausse depuis ADR-077 — c'est ce qui
   * fait marcher « rappelle-moi jeudi ». Elle est restée écrite, et elle a
   * servi de raison de ne pas écrire ces règles.
   *
   * Il ne reste donc qu'une seule absence, et ce n'est pas du code : les trois
   * secrets Google. Sans eux l'outil rend `PROVIDER_UNAVAILABLE`, ce qui est
   * une RÉPONSE — « aucun agenda connecté » dit quoi faire, là où « je ne sais
   * pas » dit d'attendre.
   * ====================================================================== */

  /* --- Agenda : lire une journée ----------------------------------------- */
  {
    id: 'calendar_read_jour',
    exemple: '« qu’ai-je de prévu demain »',
    pattern:
      /^(?:qu(?:'|’)ai-je\s+(?:de\s+)?(?:pr[ée]vu|dans\s+(?:mon\s+)?agenda)|qu(?:'|’)est-ce\s+que\s+j(?:'|’)ai\s+(?:de\s+)?pr[ée]vu|mon\s+agenda|mon\s+programme|qu(?:'|’)y\s+a-t-il\s+(?:[àa]\s+)?mon\s+agenda)\s*(.*?)\s*[?.!]*$/iu,
    build(match) {
      const dit = clean(match[1] ?? '') || "aujourd'hui";

      /* La même fonction PURE que pour les rappels, sur le même argument.
         Le moteur reconnaît la forme ; la base calcule la date. */
      if (reconnaitre(dit) === null) {
        return {
          kind: 'CLARIFY',
          question:
            'Pour quel jour ? Je comprends « aujourd’hui », « demain », '
            + '« après-demain », « jeudi », « dans 3 jours ».',
          understood: 'que tu veux consulter ton agenda',
        };
      }

      return {
        kind: 'TOOL_CALL',
        toolId: 'calendar_read',
        input: { fromIso: dit, toIso: dit },
        parameterProvenance: { fromIso: FROM_USER, toIso: FROM_USER },
        confidence: 0.9,
        tier: 0,
        userConfirms: false,
        referents: { fromIso: 'FENETRE:DEBUT', toIso: 'FENETRE:FIN' },
      };
    },
  },

  /* --- Agenda : créer un événement — L3, confirmation obligatoire --------- */
  {
    id: 'calendar_create_evenement',
    exemple: '« crée un rendez-vous jeudi à 14h … »',
    pattern:
      /^(?:cr[ée]e|ajoute|pose|mets)\s+(?:un\s+)?(?:rendez-vous|rdv|[ée]v[ée]nement|r[ée]union)\s+(.+)$/iu,
    build(match) {
      const reste = clean(match[1] ?? '');
      const lu = reconnaitre(reste);

      /* SANS DATE, PAS D'ÉVÉNEMENT — et on le DIT.
         Poser un rendez-vous à une heure que l'utilisateur n'a pas donnée
         serait la faute d'HIGH-5, sur un effet EXTERNE cette fois : un
         événement chez Google, visible par ses invités. */
      if (lu === null) {
        return {
          kind: 'CLARIFY',
          question:
            'Pour quand exactement ? Je comprends « jeudi à 14h », '
            + '« demain matin », « après-demain à 9h30 ».',
          understood: 'que tu veux créer un rendez-vous',
        };
      }

      /* L'INTITULÉ GARDE SA PRÉPOSITION — « Rendez-vous avec le carreleur ».

         La première version retirait « avec » et produisait un événement
         intitulé « le carreleur ». Ce n'est pas faux, c'est illisible dans un
         agenda partagé — et un titre d'événement est vu par les invités.

         `calendar_create` est `L3` : la confirmation montre l'intitulé avant
         écriture, donc l'utilisateur corrige s'il préfère autre chose. */
      const nu = clean(lu.reste);
      const titre = /^(?:avec|pour|chez)\s+/iu.test(nu) ? `Rendez-vous ${nu}` : nu;
      if (clean(nu).length === 0) {
        return {
          kind: 'CLARIFY',
          question: 'Quel intitulé pour ce rendez-vous ?',
          understood: 'que tu veux créer un rendez-vous, sans savoir lequel',
        };
      }

      /* LES DEUX CHAMPS PORTENT LE MÊME TEXTE, et c'est le marqueur qui les
         distingue. `reste` — l'énoncé tel quel — est ce que l'Assistant
         repassera à `reconnaitre` : deux appels déterministes de la même
         fonction pure ne peuvent pas diverger.

         Passer `lu.expression` ici aurait été une faute de type que le
         compilateur n'aurait pas vue : le chemin temporel de l'Assistant lit
         une CHAÎNE, et un objet y serait tombé sur « date illisible ». */
      return {
        kind: 'TOOL_CALL',
        toolId: 'calendar_create',
        input: { title: titre, startsAt: reste, endsAt: reste },
        parameterProvenance: {
          title: FROM_USER,
          startsAt: FROM_USER,
          endsAt: FROM_USER,
        },
        confidence: 0.85,
        tier: 0,
        userConfirms: false,
        referents: { startsAt: 'TEMPORAL', endsAt: 'TEMPORAL:FIN_PAR_DEFAUT' },
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
  /**
   * LA CONTRE-GARDE — ADR-096.
   *
   * Une garde de capacité passe AVANT les règles, délibérément (HIGH-4) : une
   * demande qui nomme une capacité absente ne doit jamais atteindre une règle
   * correspondant à une AUTRE capacité.
   *
   * ⚠ Mais le même ordre produit la faute symétrique, et elle est apparue dès
   * que la suppression est devenue atteignable :
   *
   * ```text
   * « annule le rappel de la réunion »
   *    ↳ la garde AGENDA voit « réunion » et répond « aucun agenda n'est
   *      connecté » — alors que l'utilisateur a nommé un RAPPEL, qui existe.
   * ```
   *
   * La garde niait une capacité présente parce qu'un mot d'une autre capacité
   * figurait dans le complément. C'est le même coût qu'HIGH-4 pris à l'envers :
   * l'utilisateur renonce à demander ce que Jarvis sait faire.
   *
   * `sauf` désarme la garde quand la phrase nomme explicitement l'objet d'une
   * capacité PRÉSENTE. Ce n'est pas un contournement de HIGH-4 : HIGH-4
   * interdisait de SUBSTITUER une capacité à une autre. Ici, la capacité servie
   * est celle que l'utilisateur a nommée.
   */
  readonly sauf?: RegExp;
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
  /* ⚠ « L'AGENDA » A QUITTÉ CETTE TABLE — ADR-097.

     L'entrée disait deux choses. La première était vraie : aucun adaptateur
     n'est branché sans les trois secrets Google. La seconde — « je ne sais pas
     encore résoudre une date dite en français » — **est fausse depuis
     ADR-077**, qui fait marcher « rappelle-moi jeudi ».

     Elle est restée écrite plusieurs ADR durant, et elle a servi de raison de
     ne pas écrire les règles d'agenda. C'est le motif d'ADR-094 dans sa forme
     la plus coûteuse : une limite périmée qui empêche le travail suivant.

     `calendar_read` et `calendar_create` ont désormais leurs règles. Sans
     compte connecté, l'outil rend `PROVIDER_UNAVAILABLE` — « aucun agenda
     connecté » dit quoi faire, là où « je ne sais pas » disait d'attendre. */
  /* ⚠ « SUPPRIMER » A QUITTÉ CETTE TABLE — ADR-096.

     L'entrée disait : « je sais défaire ma dernière action avec /annule, mais
     pas encore supprimer un élément que tu me désignes ». C'était vrai, et
     c'était la description exacte du trou : les outils existaient, seul
     l'identifiant manquait.

     Le résolveur de désignation le fournit. La garde devait donc partir dans
     la MÊME passe que la capacité — la laisser aurait nié une capacité
     présente, et `KNOWN_BUT_UNAVAILABLE` est consulté AVANT les règles : le
     message aurait gagné contre l'outil.

     C'est exactement le défaut qu'ADR-075 a fermé pour quatre autres outils.
     Ce fichier est celui qui l'avait subi. */
  {
    /* MODIFIER UN ÉVÉNEMENT — la seule moitié d'agenda qui reste hors
       d'atteinte, et pour une raison PRÉCISE, pas par manque de règle.

       `calendar_update` exige un `eventId` qui vit chez Google. Le désigner
       demande de LIRE l'agenda d'abord — donc un compte connecté. Il n'y a
       aucune manière d'écrire cette règle qui la rende vraie tant qu'aucun
       agenda ne répond.

       ⚠ Placée AVANT la garde « maison », et son motif exige un verbe de
       modification : sans lui, elle avalerait « crée un rendez-vous ». */
    pattern:
      /^(?:d[ée]cale|d[ée]place|modifie|change|reporte|avance)(?![\p{L}\p{N}_]).*(?<![\p{L}\p{N}_])(rendez-vous|rdv|[ée]v[ée]nement|r[ée]union)(?![\p{L}\p{N}_])/iu,
    capability:
      'modifier un rendez-vous — je sais le faire, mais il faut d\'abord que je '
      + 'puisse LIRE ton agenda pour savoir duquel tu parles, et aucun compte '
      + 'n\'est connecté',
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
      for (const { pattern, capability, sauf } of KNOWN_BUT_UNAVAILABLE) {
        if (!pattern.test(raw)) continue;
        if (sauf !== undefined && sauf.test(raw)) continue;
        return unavailable(capability);
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
