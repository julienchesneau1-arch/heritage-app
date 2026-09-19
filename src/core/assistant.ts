/**
 * Assistant — la boucle de conversation, indépendante de l'interface.
 *
 * Référence : 02 Étape C, `06 §Style des réponses`.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Le CLI et le serveur web doivent traverser **exactement** la même chaîne :
 *
 *   intention → Policy Gate → outil → vérification → journal
 *
 * Dupliquer cette logique dans chaque interface, c'est accepter qu'un jour
 * l'une des deux oublie une étape. Une interface ne décide de rien : elle
 * affiche ce que l'Assistant a décidé.
 *
 * PROPRIÉTÉ EXPLOITÉE ICI
 * -----------------------
 * L'Intent Engine est déterministe (Tier 0, règles). Rejouer le même texte
 * produit la même proposition. Cela permet un flux de confirmation **sans état
 * serveur** : le client renvoie le texte d'origine avec la clé d'opération, on
 * redérive la proposition, et on l'exécute confirmée. Aucune session à stocker,
 * donc aucune session à détourner.
 */
import { fromClient, mint, type OperationIdentity } from './tools/identity.js';
import type { IntentEngine } from './intent/engine.js';
import { reconnaitre } from './temps/expression.js';
import type { ResolveurTemporel } from './temps/resolution.js';
import type { Tier1 } from './intent/tier1.js';
import type { EntityResolver } from './context/resolver.js';
import {
  GenreDesigne,
  type DesignationResolver,
} from './context/designation.js';
import type { FileDeConfirmations } from './confirmation/file.js';
import { readConfirmables } from './tools/confirmation.js';
import type { ToolGateway } from './tools/gateway.js';
import type { ControleDArret } from './safety/controle.js';
import { estUneParoleDArret } from './safety/parole-d-arret.js';
import { estUneDemandeDAnnulation } from './undo/parole.js';
import { estUnPassageEnModePrive } from './privacy/parole.js';
import type { ModePrive } from './privacy/mode-prive.js';
import type { UndoEngine, UndoOutcome } from './undo/engine.js';
import type { Result } from './types/result.js';
import type { Mode, Surface, VerificationStatus } from './types/domain.js';

export type AssistantReply =
  | {
      readonly kind: 'DONE';
      readonly status: VerificationStatus;
      readonly toolId: string;
      readonly detail: string;
      readonly output: unknown;
      /**
       * LES ENTITÉS ÉVOQUÉES PAR CET ÉCHANGE — ADR-072.
       *
       * Toujours présent, éventuellement vide. C'est ce qui permet à l'appelant
       * d'enregistrer le tour avec `mentionedEntityIds`, et donc au résolveur de
       * répondre à « ça » (`docs/05 §A2`).
       *
       * **AUCUNE INFÉRENCE ICI.** L'entité est retenue parce que l'outil a
       * déclaré l'avoir touchée — `resource.kind === 'entity'` —, jamais parce
       * qu'un nom a été reconnu dans une phrase. C'est la frontière qui garde
       * ce chemin compatible `Tier 0` (ADR-071).
       */
      readonly mentionedEntityIds: readonly string[];
    }
  | {
      readonly kind: 'CONFIRM';
      /** À renvoyer tel quel pour confirmer. */
      readonly operationId: OperationIdentity;
      readonly reason: string;
      /** Les VALEURS concrètes sur lesquelles porte la confirmation (03 §3). */
      readonly values: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'CLARIFY'; readonly question: string }
  | {
      readonly kind: 'UNSUPPORTED';
      readonly understood: string;
      readonly missing: string;
    }
  | { readonly kind: 'DENIED'; readonly reason: string }
  | {
      /**
       * MIS EN FILE — ADR-099. Rien n'a été exécuté, et rien n'est autorisé.
       *
       * Le téléphone a demandé une action irréversible. Elle est enregistrée
       * comme une INTENTION ; c'est la machine qui la rejouera, Policy Gate
       * compris, si quelqu'un l'approuve devant elle.
       */
      readonly kind: 'EN_ATTENTE';
      readonly resume: string;
      readonly minutesRestantes: number;
      readonly reason: string;
    }
  | {
      /**
       * LA DERNIÈRE ACTION A ÉTÉ DÉFAITE — `docs/09 §2.1`, ADR-105.
       *
       * Pas un `DONE` : un `DONE` porte l'outil que l'utilisateur a demandé,
       * et ici il en a demandé **l'inverse d'un autre**. Afficher
       * « ✓ note_create » après une annulation serait exactement à l'envers.
       *
       * `status` vient du Verification Engine, jamais d'ici : une annulation
       * non vérifiée n'est pas une annulation (`CLAUDE.md`, règle 3).
       */
      readonly kind: 'ANNULE';
      readonly status: VerificationStatus;
      readonly detail: string;
      /** Ce qui a été remis en état, pour que la phrase soit concrète. */
      readonly cible: string;
    }
  | {
      /**
       * LE MODE PRIVÉ EST ACTIF — `docs/02` Phase 4, `docs/03 §7`, ADR-106.
       *
       * `depuis` est rendu même quand le mode était DÉJÀ actif : « c'est fait »
       * sur une bascule qui n'a rien basculé laisserait croire à un
       * changement. L'utilisateur doit pouvoir distinguer « je viens de
       * l'activer » de « il l'était déjà ».
       */
      readonly kind: 'MODE_PRIVE';
      readonly depuis: string;
      readonly dejaActif: boolean;
    }
  | {
      /**
       * JARVIS EST ARRÊTÉ — `docs/05 §C2`, ADR-104.
       *
       * Ce n'est pas un `DONE` : un `DONE` porte un `toolId`, et l'arrêt
       * d'urgence **n'est pas un outil** — il ne traverse pas le Policy Gate,
       * précisément parce qu'une politique pourrait le refuser.
       *
       * `enVol` est le champ à ne jamais fondre dans `annulees`. C'est ce que
       * l'arrêt n'a PAS pu défaire (`docs/26 §5`), et donc la seule chose que
       * l'utilisateur doit savoir après avoir dit « stop ».
       */
      readonly kind: 'ARRET';
      readonly annulees: number;
      readonly enVol: number;
      /** L'arrêt tient, mais le journal n'a pas pris l'événement. Dit, pas tu. */
      readonly journalMuet: boolean;
    }
  | { readonly kind: 'ERROR'; readonly message: string };

export interface SayOptions {
  /** Fournie pour confirmer une action préparée. Sinon générée. */
  readonly operationId?: OperationIdentity;
  readonly confirm?: boolean;
  readonly mode?: Mode;
  /**
   * La conversation en cours, pour résoudre « ça » — ADR-073.
   *
   * OPTIONNELLE, et c'est un fait plutôt qu'un oubli : un appelant sans session
   * existe. Mais son absence ne relâche RIEN — sans elle, un référent produit
   * une question, jamais une supposition.
   */
  readonly sessionId?: string;
  /**
   * D'OÙ LA DEMANDE ARRIVE — ADR-090. **REQUIS.**
   *
   * Tous les autres champs de ce type sont optionnels. Celui-ci ne l'est pas,
   * et la différence est délibérée : un défaut serait forcément `LOCALE`,
   * c'est-à-dire le régime le PLUS PERMISSIF, accordé précisément aux
   * appelants qui auraient oublié de se déclarer — dont les surfaces à venir.
   *
   * Le rendre requis force chaque appelant à répondre à la question, à la
   * compilation. C'est le seul endroit où l'on peut encore l'exiger.
   */
  readonly surface: Surface;
}

export interface Assistant {
  /**
   * ⚠ `options` N'A PLUS DE DÉFAUT, ET C'EST LA GARDE — ADR-090.
   *
   * La signature était `options?: SayOptions`, avec `= {}` à l'implémentation.
   * Tout appel sans options obtenait donc le régime local. Désormais il faut
   * au moins déclarer sa surface.
   */
  say(text: string, options: SayOptions): Promise<AssistantReply>;
}

export interface AssistantDeps {
  readonly intent: IntentEngine;
  readonly gateway: ToolGateway;
  /** Pilote la confirmation côté Memory Guard (voir `src/tools/index.ts`). */
  setGuardConfirmed(value: boolean): void;
  /**
   * L'INTERRUPTEUR CLOUD DE L'UTILISATEUR — invariant S13, ADR-069.
   *
   * Ce champ valait `false` EN DUR ici, et dans le runtime. La politique
   * `00_hard_security.cedar` interdit toute égression quand il est faux, avec
   * ce commentaire : *« L'utilisateur doit pouvoir couper le cloud, et cela
   * doit être vrai. »*
   *
   * Ça ne l'était pas. `config/default.json` expose `cloud.enabled`, et la clé
   * ne pilotait RIEN : la protection tenait par un littéral — le bon résultat
   * pour la mauvaise raison, ce que ce dépôt refuse partout ailleurs.
   *
   * **Un interrupteur qui n'interrompt pas est pire que pas d'interrupteur :
   * l'utilisateur se croit protégé par son choix alors qu'il l'est par un
   * hasard d'écriture.** Le jour où quelqu'un remplace le littéral, plus rien
   * ne le signale.
   *
   * Fourni par l'appelant, jamais deviné. Le défaut de `config/default.json`
   * reste `false` : ce qui change n'est pas le comportement par défaut, c'est
   * que le choix de l'utilisateur soit HONORÉ.
   */
  readonly cloudEnabled: boolean;
  /**
   * LE RÉSOLVEUR DE RÉFÉRENTS — ADR-073.
   *
   * La résolution vit ICI plutôt que dans le moteur d'intention, et le choix
   * est une propriété qu'on refuse de perdre : `propose(text)` est une fonction
   * PURE du texte — déterministe, éprouvable sans base, incapable d'échouer
   * pour une raison d'infrastructure.
   *
   * La rendre asynchrone aurait fait dépendre la COMPRÉHENSION d'une
   * entrée-sortie. L'Assistant, lui, est déjà asynchrone et orchestre déjà :
   * c'est sa place.
   */
  readonly resolver: EntityResolver;
  /**
   * LE RÉSOLVEUR DE DÉSIGNATIONS — ADR-096.
   *
   * REQUIS, pour la raison exacte qui rend `temps` requis : un champ optionnel
   * est un champ qu'on oublie, et l'oublier ici ferait échouer « supprime la
   * note du carreleur » en production pendant que tous les tests passeraient
   * avec un double qui le fournit.
   */
  readonly designation: DesignationResolver;
  /**
   * LA FILE D'ATTENTE DE CONFIRMATIONS — ADR-099, ou `null`.
   *
   * `null` est un état NORMAL et déclaré : un appelant qui ne sert aucune
   * surface distante n'a pas de file à tenir, et le champ est REQUIS pour que
   * son absence soit un choix écrit plutôt qu'un oubli.
   *
   * Avec `null`, une action L3/L4 venue d'une surface distante reste
   * simplement REFUSÉE — le comportement d'avant ADR-099. La file ajoute un
   * chemin ; elle n'en retire aucun.
   */
  readonly file: FileDeConfirmations | null;
  /**
   * Le résolveur de dates — ADR-077.
   *
   * REQUIS, pas optionnel : un champ optionnel est un champ qu'on oublie, et
   * l'oublier ici ferait échouer « rappelle-moi jeudi » en production alors
   * que tous les tests passeraient avec un double qui le fournit.
   */
  readonly temps: ResolveurTemporel;
  /**
   * Le `Tier 1`, ou `null` — ADR-081.
   *
   * `null` est un état NORMAL et déclaré : aucun modèle local n'est installé
   * par défaut, et Jarvis fonctionne entièrement sans (invariants I1/I2). Le
   * champ est REQUIS pour que son absence soit un choix écrit, pas un oubli.
   */
  readonly tier1: Tier1 | null;
  /**
   * L'ARRÊT D'URGENCE — ADR-104, `docs/05 §C2`.
   *
   * ⚠ REQUIS ET NON NULLABLE, contrairement à `tier1` et à `file`.
   *
   * Ces deux-là ont un `null` légitime : un assemblage sans modèle local, ou
   * sans surface distante, est un assemblage normal. **Un assemblage qu'on ne
   * peut pas arrêter ne l'est pas.** Autoriser `null` ici reviendrait à
   * permettre, par distraction, un Jarvis dont le bouton rouge ne serait
   * câblé à rien — c'est-à-dire exactement l'état que cette ADR corrige.
   */
  readonly arret: ControleDArret;
  /**
   * LE MOTEUR D'ANNULATION — ADR-105, `docs/09 §2.1`.
   *
   * ⚠ REQUIS ET NON NULLABLE, pour la raison exacte d'`arret`. « Annule la
   * dernière action » est une promesse de `QUICKSTART` et du pack ; un
   * assemblage qui ne peut pas défaire n'est pas un assemblage normal, c'est
   * un assemblage diminué — et un champ optionnel est un champ qu'on oublie.
   *
   * Il vivait jusqu'ici UNIQUEMENT dans le CLI, ce qui revenait au même : la
   * capacité existait, et une seule surface l'atteignait.
   */
  readonly undo: UndoEngine;
  /**
   * LE MODE PRIVÉ — ADR-106, livrable de la Phase 4.
   *
   * ⚠ REQUIS ET NON NULLABLE, pour la raison d'`arret` et d'`undo` : un
   * assemblage qui ne peut pas se taire n'est pas un assemblage normal. La
   * règle du Policy Gate existait depuis le début et personne ne pouvait
   * l'atteindre — un champ optionnel aurait laissé ce trou se reformer.
   */
  readonly modePrive: ModePrive;
}

/**
 * La durée d'un rendez-vous dont personne n'a dit la fin — ADR-097.
 *
 * Une heure : la convention la plus répandue, et surtout un CHOIX écrit plutôt
 * qu'une constante enfouie. Condition de révision : le premier agenda réel
 * connecté, où l'on verra si une heure est la bonne valeur pour Julien.
 */
export const DUREE_PAR_DEFAUT_MINUTES = 60;

/**
 * « Annule la dernière action. » — ADR-105.
 *
 * ⚠⚠ CE QUI EST DÉFAIT EST UNE OPÉRATION **NOMMÉE**, JAMAIS « LA DERNIÈRE ».
 *
 * C'est la propriété qui rend la confirmation sûre, et elle n'est pas
 * évidente. Entre la question et la réponse, le monde bouge :
 *
 * ```text
 * t0   « annule »                    → « annuler la note du carreleur ? »
 * t1   (une autre action a lieu, ou le téléphone attend le passage au Mac)
 * t2   « oui »                       → si on relisait « la dernière », on
 *                                      défferait AUTRE CHOSE que ce qui a
 *                                      été montré à l'écran
 * ```
 *
 * On ne confirme pas ce qu'on n'a pas vu (ADR-063). La question porte donc
 * l'identité de l'opération visée, et la confirmation la rejoue **telle
 * quelle** : `undoOperation(id)`, jamais `undoLast()`.
 *
 * ⚠ ET LA MISE EN FILE SUIT LE MÊME CHEMIN QUE TOUT LE RESTE — ADR-099.
 * On n'anticipe pas le refus : on tente, et c'est le Policy Gate qui tranche.
 * Anticiper reviendrait à porter une seconde décision de politique dans
 * l'Assistant, et le jour où les deux divergeraient, aucune ne ferait
 * autorité (ADR-041).
 */
async function annuler(
  deps: AssistantDeps,
  options: SayOptions,
): Promise<AssistantReply> {
  const confirm = options.confirm === true;
  const contexte = {
    mode: options.mode ?? 'NORMAL',
    cloudEnabled: deps.cloudEnabled,
    proactive: false,
    userConfirmed: confirm,
    /* ADR-090 — transmise telle quelle. L'inverse d'un outil est souvent PLUS
       strict que lui (`memory_add` est L2, son inverse L4) : une annulation
       demandée à distance est exactement le cas que la règle vise. */
    surface: options.surface,
  } as const;

  /* CHEMIN DE CONFIRMATION : l'identité est celle qu'on a MONTRÉE. Aucun
     aperçu n'est relu ici — le relire rouvrirait la fenêtre décrite ci-dessus. */
  const vise =
    confirm && options.operationId !== undefined ? String(options.operationId) : null;

  if (vise !== null) {
    const fait = await deps.undo.undoOperation(vise, contexte);
    return versReponseDAnnulation(fait, vise, vise, deps, options);
  }

  const apercu = await deps.undo.previewLast();
  if (!apercu.ok) return { kind: 'ERROR', message: apercu.error.message };

  if (apercu.value === null) {
    /* « Rien à annuler » est une RÉPONSE, pas une erreur. C'est aussi la
       seule information utile : l'utilisateur croyait avoir fait quelque
       chose. */
    return {
      kind: 'CLARIFY',
      question: 'Je n’ai rien à annuler — aucune action récente n’est défaisable.',
    };
  }

  if (apercu.value.empechement !== null) {
    /* UN EMPÊCHEMENT SE DIT AVANT LA QUESTION. Demander un accord pour une
       action qu'on sait refusée fait perdre du temps ET use la confirmation :
       quelqu'un qui voit ses « oui » ne rien produire finit par les donner
       sans lire. */
    return {
      kind: 'UNSUPPORTED',
      understood: 'que tu veux annuler la dernière action',
      missing: `la possibilité de la défaire : ${apercu.value.empechement}.`,
    };
  }

  /* ⚠ CE QUE L'UTILISATEUR LIRA — ADR-063 : « on ne confirme pas ce qu'on n'a
     pas vu ». La première rédaction posait l'identifiant d'opération dans la
     question :

         annuler : c639cf86-65fe-4e5f-abce-9a34fec61bb4

     C'est un oui donné sur une chaîne hexadécimale. La question doit nommer la
     CHOSE — « note », « tâche » — et l'outil qui la défera. */
  const libelle =
    `${apercu.value.resource.kind} ${apercu.value.resource.id}`
    + ` (par ${apercu.value.inverseToolId ?? 'un outil inverse'})`;

  const fait = await deps.undo.undoOperation(apercu.value.operationId, contexte);
  return versReponseDAnnulation(fait, apercu.value.operationId, libelle, deps, options);
}

async function versReponseDAnnulation(
  fait: Result<UndoOutcome>,
  operationVisee: string,
  /** Ce que l'utilisateur LIRA. Jamais un identifiant seul (ADR-063). */
  libelle: string,
  deps: AssistantDeps,
  options: SayOptions,
): Promise<AssistantReply> {
  if (fait.ok) {
    return {
      kind: 'ANNULE',
      /* Le statut vient du Verification Engine, au travers de l'Undo Engine.
         Aucune ligne de ce fichier ne le fabrique — une annulation non
         vérifiée n'est pas une annulation. */
      status: fait.value.status,
      detail: fait.value.detail,
      cible: `${fait.value.resource.kind} ${fait.value.resource.id}`,
    };
  }

  if (fait.error.kind === 'CONFIRMATION_REQUIRED') {
    return {
      kind: 'CONFIRM',
      /* ⚠ L'IDENTITÉ RENDUE EST CELLE DE L'OPÉRATION À DÉFAIRE. C'est elle
         qui reviendra au tour suivant, et c'est elle qui sera défaite — pas
         « la dernière » telle qu'elle sera à ce moment-là. */
      operationId: fromClient(operationVisee),
      reason: fait.error.message,
      values: { annuler: libelle },
    };
  }

  if (fait.error.kind === 'POLICY_DENIED') {
    const motif = fait.error.details?.['motif'];
    if (motif === 'SURFACE_DISTANTE' && deps.file !== null) {
      const mis = await deps.file.mettreEnFile({
        operationId: operationVisee,
        /* LE GENRE EST CE QUI PERMET DE LA RENDRE À SON PROPRIÉTAIRE.
           `undoLast` fait deux choses — invoquer l'outil inverse, puis marquer
           la capture annulée. La file ne sait rejouer que la première ; c'est
           l'Undo Engine qui possède les deux, et `/confirmer` la lui rend. */
        genre: 'ANNULATION',
        /* Informatif : ce qui sera réellement exécuté. La file ne s'en sert
           pas pour décider — le genre le fait — mais `/audit` et l'écran de
           confirmation doivent pouvoir le nommer. */
        toolId: 'undo',
        input: {},
        provenance: {},
        resume: `annuler — ${libelle}`,
        demandeeDe: options.surface,
      });
      if (!mis.ok) return { kind: 'ERROR', message: mis.error.message };
      return {
        kind: 'EN_ATTENTE',
        resume: mis.value.resume,
        minutesRestantes: mis.value.minutesRestantes,
        reason: fait.error.message,
      };
    }
    return { kind: 'DENIED', reason: fait.error.message };
  }

  return { kind: 'ERROR', message: fait.error.message };
}

export function createAssistant(deps: AssistantDeps): Assistant {
  return {
    async say(text: string, options: SayOptions): Promise<AssistantReply> {
      /* ⚠ L'ARRÊT D'URGENCE PASSE AVANT TOUT LE RESTE — `docs/05 §C2`, ADR-104.

         Avant le `Tier 0`, avant le `Tier 1`, avant le résolveur de référents,
         avant le Policy Gate. `halt.ts` l'a tranché dès sa première ligne :
         *« un arrêt d'urgence que la politique peut refuser n'est pas un arrêt
         d'urgence »* — et le moment où l'on appuie sur le bouton est
         précisément celui où le reste peut se comporter autrement qu'attendu.

         ⚠ ET IL N'EST PAS RESTREINT PAR LA SURFACE, alors qu'ADR-090 restreint
         tout le reste. Ce n'est pas un oubli : ADR-090 protège contre les
         actions DANGEREUSES venues d'un canal moins sûr. Arrêter va dans le
         sens inverse — et quelqu'un qui n'est pas devant sa machine est
         exactement celui qui a le plus besoin de pouvoir dire stop. */
      if (estUneParoleDArret(text)) {
        const arrete = await deps.arret.engager(`demandé par l’utilisateur : « ${text} »`);
        if (!arrete.ok) return { kind: 'ERROR', message: arrete.error.message };
        return {
          kind: 'ARRET',
          annulees: arrete.value.annulees,
          enVol: arrete.value.enVol,
          journalMuet: arrete.value.journalMuet,
        };
      }

      /* PASSER EN MODE PRIVÉ — `docs/03 §7`, ADR-106.

         Comme l'arrêt d'urgence et l'annulation : ce n'est pas un appel
         d'outil, c'est un changement de RÉGIME. Lui inventer un `toolId` le
         ferait traverser le Policy Gate — c'est-à-dire soumettre à la
         politique le geste qui durcit la politique. */
      if (estUnPassageEnModePrive(text)) {
        const actif = await deps.modePrive.activer(
          `demandé par l’utilisateur : « ${text} »`,
        );
        if (!actif.ok) return { kind: 'ERROR', message: actif.error.message };
        /* `dejaActif` est calculé par comparaison d'instants plutôt que rendu
           par le module : `activer()` est idempotent et ne distingue pas les
           deux cas — c'est justement ce qui le rend sûr à répéter. */
        const depuis = actif.value.depuis ?? new Date().toISOString();
        return {
          kind: 'MODE_PRIVE',
          depuis,
          dejaActif: Date.now() - new Date(depuis).getTime() > 2000,
        };
      }

      /* ANNULER LA DERNIÈRE ACTION — `docs/09 §2.1`, ADR-105.

         Placé après l'arrêt d'urgence et avant le `Tier 0`, comme lui : ce
         n'est pas un appel d'outil que l'utilisateur formule, c'est une
         demande SUR l'historique. Le moteur d'intention produit des
         propositions d'outil ; celle-ci n'en est pas une, et lui inventer un
         `toolId` reviendrait à choisir l'outil inverse à la place de l'Undo
         Engine, qui seul sait lequel c'est. */
      if (estUneDemandeDAnnulation(text)) {
        return annuler(deps, options);
      }

      /* L'ORDRE EST UNE PROPRIÉTÉ — ADR-081.

         `Tier 0` d'abord, toujours. Ses règles sont déterministes, gratuites,
         répondent en 4,6 µs, et marquent leurs paramètres `USER` : là où elles
         suffisent, aucune confirmation n'est exigée. Passer par le modèle
         d'abord ajouterait latence, variabilité ET une confirmation, pour un
         résultat identique.

         Le `Tier 1` ne parle donc que sur ce que les règles n'ont pas compris.
         `CLARIFY` ne le déclenche pas : une question posée est un travail
         accompli, pas un échec — la relancer au modèle reviendrait à ignorer une
         ambiguïté que `Tier 0` a su nommer. */
      let proposal = deps.intent.propose(text);

      if (proposal.kind === 'UNSUPPORTED' && deps.tier1 !== null) {
        const repli = await deps.tier1.propose(text);
        /* Un `Tier 1` en panne ne casse pas Jarvis : on garde la réponse du
           `Tier 0`, qui était honnête. Une dégradation se subit, elle ne se
           propage pas. */
        if (repli.ok) proposal = repli.value;
      }

      if (proposal.kind === 'CLARIFY') {
        return { kind: 'CLARIFY', question: proposal.question };
      }
      if (proposal.kind === 'UNSUPPORTED') {
        return {
          kind: 'UNSUPPORTED',
          understood: proposal.understood,
          missing: proposal.missing,
        };
      }

      /* RÉSOUDRE LES RÉFÉRENTS — `docs/05 §A2`, ADR-073.

         > *Attendu : Jarvis résout le référent depuis le contexte récent.*
         > *Interdit : **deviner** si deux interprétations ont un impact
         >  différent.*

         L'INTERDIT GOUVERNE TOUT CE BLOC. Quatre issues, une seule agit :
         résolu → on substitue ; ambigu, introuvable, ou pas de session → **on
         demande**. Aucun chemin ne remplit un paramètre par défaut, et c'est
         exactement ce qui distingue « résoudre » de « choisir à la place de
         quelqu'un ». */
      let input: Readonly<Record<string, unknown>> = proposal.input;
      /* Les espèces de référent partagent une table (ADR-077) mais pas un
         résolveur : chacune interroge une source différente. On les sépare
         ici, à un seul endroit. */
      const anaphores = Object.entries(proposal.referents)
        .filter(([, genre]) => genre === 'ANAPHORA')
        .map(([cle]) => cle);
      const temporels = Object.entries(proposal.referents)
        .filter(([, genre]) => genre === 'TEMPORAL')
        .map(([cle]) => cle);
      const mentions = Object.entries(proposal.referents)
        .filter(([, genre]) => genre === 'MENTION')
        .map(([cle]) => cle);
      const fenetreDebut = Object.entries(proposal.referents)
        .filter(([, genre]) => genre === 'FENETRE:DEBUT')
        .map(([cle]) => cle);
      const fenetreFin = Object.entries(proposal.referents)
        .filter(([, genre]) => genre === 'FENETRE:FIN')
        .map(([cle]) => cle);
      const finParDefaut = Object.entries(proposal.referents)
        .filter(([, genre]) => genre === 'TEMPORAL:FIN_PAR_DEFAUT')
        .map(([cle]) => cle);
      const designations = Object.entries(proposal.referents)
        .flatMap(([cle, genre]) =>
          genre.startsWith('DESIGNATION:')
            ? [[cle, genre.slice('DESIGNATION:'.length)] as const]
            : [],
        );

      if (anaphores.length > 0) {
        if (options.sessionId === undefined) {
          /* Sans session, il n'y a pas de « contexte récent ». Deviner
             reviendrait à inventer le passé de la conversation. */
          return {
            kind: 'CLARIFY',
            question: 'À quoi fais-tu référence ? Je n’ai pas de conversation en cours.',
          };
        }

        const resolution = await deps.resolver.resolveAnaphora(options.sessionId);
        if (!resolution.ok) return { kind: 'ERROR', message: resolution.error.message };

        if (resolution.value.kind === 'AMBIGUOUS') {
          // Le résolveur formule LA question — une seule à la fois (`05/A3`).
          return { kind: 'CLARIFY', question: resolution.value.question };
        }
        if (resolution.value.kind === 'NOT_FOUND') {
          return {
            kind: 'CLARIFY',
            question: 'À quoi fais-tu référence ? Rien n’a été évoqué récemment.',
          };
        }

        const nom = resolution.value.entity.displayName;
        input = Object.fromEntries(
          Object.entries(proposal.input).map(([cle, valeur]) =>
            anaphores.includes(cle) ? [cle, nom] : [cle, valeur],
          ),
        );
      }

      /* RÉSOUDRE LES DATES — ADR-077, et le MÊME interdit qu'au-dessus.

         « Jeudi » désigne un instant sans le nommer : c'est un référent, au
         même titre que « ça ». La différence est ce qui le résout — la base et
         non le contexte de conversation — pas la nature du problème.

         `reconnaitre` est rejoué ICI sur le même argument que dans le moteur.
         Deux appels déterministes d'une fonction pure ne peuvent pas diverger :
         ce n'est pas un second registre, c'est le même calcul refait pour rien
         — et « pour rien » coûte quelques microsecondes. */
      const lisible: Record<string, string> = {};
      for (const cle of temporels) {
        const brut = input[cle];
        if (typeof brut !== 'string') {
          return { kind: 'ERROR', message: `date illisible pour « ${cle} »` };
        }
        const lu = reconnaitre(brut);
        if (lu === null) {
          /* ON DEMANDE, ON NE POSE PAS UNE DATE PAR DÉFAUT. Un rappel posé
             pour un moment que l'utilisateur n'a pas dit est pire qu'un rappel
             absent : il crée une confiance fausse. */
          return {
            kind: 'CLARIFY',
            question:
              'Pour quand exactement ? Je comprends « demain », « jeudi », ' +
              '« demain matin », « dans 2 heures », « jeudi à 14h ».',
          };
        }
        const instant = await deps.temps.resoudre(lu.expression);
        if (!instant.ok) return { kind: 'ERROR', message: instant.error.message };

        input = { ...input, [cle]: instant.value.iso };
        /* La forme LISIBLE sert la confirmation. C'est elle qui rend honnête
           l'heure par défaut : l'utilisateur voit « jeudi 20 août à 09:00 »
           avant toute écriture, et peut corriger. Un défaut montré n'est pas
           un mensonge ; un défaut silencieux en serait un. */
        lisible[cle] = instant.value.humain;
      }

      /* RÉSOUDRE UNE FENÊTRE DE JOURNÉE — ADR-097.

         ⚠ UNE SEULE RÉSOLUTION POUR DEUX BORNES, et c'est la raison d'être de
         ce bloc. Résoudre `fromIso` puis `toIso` séparément ferait deux appels
         à la base : à minuit moins une seconde, ils encadreraient DEUX JOURS
         DIFFÉRENTS, et l'agenda affiché ne serait celui d'aucune journée
         réelle. ADR-041, sur un intervalle de quelques millisecondes. */
      for (const cle of fenetreDebut) {
        const brut = input[cle];
        if (typeof brut !== 'string') {
          return { kind: 'ERROR', message: `fenêtre illisible pour « ${cle} »` };
        }
        const lu = reconnaitre(brut);
        if (lu === null) {
          return {
            kind: 'CLARIFY',
            question:
              'Pour quel jour ? Je comprends « aujourd’hui », « demain », '
              + '« après-demain », « jeudi », « dans 3 jours ».',
          };
        }

        const fenetre = await deps.temps.resoudreFenetre(lu.expression, 1);
        if (!fenetre.ok) return { kind: 'ERROR', message: fenetre.error.message };

        input = { ...input, [cle]: fenetre.value.debutIso };
        lisible[cle] = fenetre.value.humain;
        // LA MÊME résolution remplit la ou les bornes de fin.
        for (const fin of fenetreFin) {
          input = { ...input, [fin]: fenetre.value.finIso };
        }
      }

      /* LA FIN D'UN ÉVÉNEMENT QUE PERSONNE N'A DITE — ADR-097.

         On résout le DÉBUT une seconde fois, puis on ajoute la durée par
         défaut. L'addition se fait sur un instant DÉJÀ RÉSOLU par la base, en
         UTC : aucune horloge de processus n'est lue, et une heure UTC dure une
         heure même les jours de changement d'heure.

         ⚠ CE DÉFAUT EST MONTRÉ, PAS APPLIQUÉ EN SILENCE. `calendar_create` est
         `L3` : la confirmation affiche l'heure de fin retenue avant toute
         écriture. C'est la discipline d'`HEURE_PAR_DEFAUT` (ADR-077), sur un
         effet externe cette fois. */
      for (const cle of finParDefaut) {
        const brut = input[cle];
        if (typeof brut !== 'string') {
          return { kind: 'ERROR', message: `date illisible pour « ${cle} »` };
        }
        const lu = reconnaitre(brut);
        if (lu === null) {
          return {
            kind: 'CLARIFY',
            question: 'Pour quand exactement ? Je n’ai pas saisi l’heure.',
          };
        }
        const debut = await deps.temps.resoudre(lu.expression);
        if (!debut.ok) return { kind: 'ERROR', message: debut.error.message };

        const fin = new Date(
          new Date(debut.value.iso).getTime() + DUREE_PAR_DEFAUT_MINUTES * 60_000,
        );
        input = { ...input, [cle]: fin.toISOString().replace(/\.\d{3}Z$/, 'Z') };
        lisible[cle] =
          `${String(DUREE_PAR_DEFAUT_MINUTES)} min après le début (durée par défaut)`;
      }

      /* RÉSOUDRE LES DÉSIGNATIONS — ADR-096.

         « supprime la note du carreleur » : le moteur a porté le texte
         « carreleur » dans `noteId` et l'a marqué. C'est ici qu'il devient un
         identifiant — ou qu'une question est posée.

         ⚠ LE MÊME INTERDIT QUE POUR LES DEUX AUTRES ESPÈCES, ET IL PÈSE PLUS
         LOURD ICI. Quatre des six outils ouverts par ce mécanisme sont `L4`,
         irréversibles. Un départage automatique entre deux notes effacerait
         parfois la mauvaise, et personne ne le saurait jamais.

         Trois issues, une seule agit : résolu → on substitue ; ambigu → on
         demande, en NOMMANT les candidats ; introuvable → on le dit, sans
         proposer de repli. */
      for (const [cle, genre] of designations) {
        const lu = GenreDesigne.safeParse(genre);
        if (!lu.success) {
          /* Un genre illisible est un défaut de règle, pas une ambiguïté de
             l'utilisateur. On ne devine pas la table à interroger. */
          return { kind: 'ERROR', message: `genre de désignation inconnu : ${genre}` };
        }

        const brut = input[cle];
        if (typeof brut !== 'string' || brut.trim().length === 0) {
          return {
            kind: 'CLARIFY',
            question: 'Laquelle exactement ? Je n’ai pas saisi ce que tu désignes.',
          };
        }

        const trouve = await deps.designation.resoudre(lu.data, brut);
        if (!trouve.ok) return { kind: 'ERROR', message: trouve.error.message };

        if (trouve.value.kind === 'AMBIGU') {
          return { kind: 'CLARIFY', question: trouve.value.question };
        }
        if (trouve.value.kind === 'INTROUVABLE') {
          /* ON NE PROPOSE PAS DE REPLI. « Je n'ai pas trouvé, veux-tu que je
             cherche ailleurs ? » relancerait l'utilisateur vers une action
             qu'il n'a pas demandée — et sur un verbe de suppression, c'est la
             dernière chose à faire. */
          return {
            kind: 'CLARIFY',
            question: `Je ne trouve rien qui corresponde à « ${brut} ». Peux-tu le nommer autrement ?`,
          };
        }

        /* La PROVENANCE ne change pas, et c'est délibéré — même choix que pour
           `ANAPHORA` et `TEMPORAL`. L'identifiant vient de la base, donc du
           noyau ; mais c'est l'utilisateur qui a désigné la ligne, et c'est sa
           désignation que la confirmation L4 lui remontrera. Réétiqueter en
           `SYSTEM` ferait perdre exactement cette information. */
        input = { ...input, [cle]: trouve.value.cible.id };
        lisible[cle] = trouve.value.cible.libelle;
      }

      /* RÉSOUDRE LES MENTIONS NOMINALES — ADR-096.

         « supprime la fiche de Camille » passe par `EntityResolver`, qui
         existait avant ce mécanisme et porte ce qu'un résolveur de désignation
         n'a pas : les alias confirmés, et la preuve contextuelle de session.
         Deux registres de « comment on retrouve une personne » auraient fini
         par diverger (ADR-041). */
      for (const cle of mentions) {
        const brut = input[cle];
        if (typeof brut !== 'string' || brut.trim().length === 0) {
          return { kind: 'CLARIFY', question: 'De qui parles-tu ?' };
        }

        const trouve = await deps.resolver.resolveMention(brut, options.sessionId);
        if (!trouve.ok) return { kind: 'ERROR', message: trouve.error.message };

        if (trouve.value.kind === 'AMBIGUOUS') {
          return { kind: 'CLARIFY', question: trouve.value.question };
        }
        if (trouve.value.kind === 'NOT_FOUND') {
          return {
            kind: 'CLARIFY',
            question: `Je ne connais personne sous le nom « ${brut} ».`,
          };
        }

        input = { ...input, [cle]: trouve.value.entity.id };
        lisible[cle] = trouve.value.entity.displayName;
      }

      /* LE POINT DE FRAPPE UNIQUE — ADR-030.
         Une intention utilisateur donne UNE identité d'opération. Tout ce qui
         suit — reprise, vérification, et un jour repli sur un autre
         fournisseur — doit la conserver.
         `tests/lab/invariants.test.ts` (I5) vérifie que `mint()` n'est appelé
         nulle part ailleurs dans `src/`. */
      const operationId = options.operationId ?? mint();
      const confirm = options.confirm === true;

      // « Retiens que X » vaut confirmation par lui-même ; les autres non.
      deps.setGuardConfirmed(proposal.userConfirms || confirm);
      try {
        const result = await deps.gateway.invoke({
          toolId: proposal.toolId,
          input,
          parameterProvenance: proposal.parameterProvenance,
          operationId,
          actor: 'USER',
          context: {
            mode: options.mode ?? 'NORMAL',
            cloudEnabled: deps.cloudEnabled,
            proactive: false,
            userConfirmed: confirm,
            /* ADR-090 — transmis tel quel jusqu'au Policy Gate. L'Assistant
               ne réinterprète pas : un intermédiaire qui pourrait requalifier
               la surface contournerait la règle en se déclarant local. */
            surface: options.surface,
          },
        });

        if (!result.ok) {
          if (result.error.kind === 'CONFIRMATION_REQUIRED') {
            /* LISTE BLANCHE PARTAGÉE — ADR-063. Ce tri existait ici ET dans
               le CLI, chacun par `key !== 'tool' && key !== 'autonomy'`. Deux
               tris du même fait finissent par diverger. */
            const values: Record<string, string> = {};
            for (const v of readConfirmables(result.error.details)) {
              /* La date résolue s'affiche en FRANÇAIS, pas en ISO — ADR-077.
                 `2026-08-20T09:00:00+02:00` ne se relit pas, et c'est
                 précisément cette relecture qui rend acceptable l'heure par
                 défaut. Les deux formes viennent du même calcul, dans la même
                 requête : elles ne peuvent pas désigner deux instants. */
              values[v.nom] = lisible[v.nom] ?? v.rendu;
            }
            return {
              kind: 'CONFIRM',
              operationId,
              reason: result.error.message,
              values,
            };
          }
          if (result.error.kind === 'POLICY_DENIED') {
            /* ⚠ MISE EN FILE — ADR-099, ET LA CONDITION EST TOUT LE SUJET.

               On ne met en file QUE les refus portant
               `motif: 'SURFACE_DISTANTE'` — c'est-à-dire les refus RÉPARABLES,
               ceux que la même demande faite devant la machine passerait.

               Un `forbid` Cedar, un `L0`, une donnée `RED` en égression
               n'ont aucun motif : ils restent `DENIED`, définitivement. Sans
               cette condition, la file deviendrait un contournement de
               politique — il suffirait de demander depuis le téléphone pour
               obtenir « à confirmer plus tard » ce qui est interdit.

               Et la distinction se fait sur un CHAMP TYPÉ. La faire sur
               `message` ferait dépendre une décision de sécurité d'une phrase
               française, qu'une reformulation changerait en silence.

               ⚠ ENFIN : MISE EN FILE ≠ AUTORISATION. La ligne enregistrée est
               une intention. La confirmation rejouera la chaîne COMPLÈTE,
               Policy Gate compris, sur la surface locale. */
            const motif = result.error.details?.['motif'];
            if (motif === 'SURFACE_DISTANTE' && deps.file !== null) {
              const quoi = Object.values(lisible);
              const resume =
                quoi.length > 0
                  ? `${proposal.toolId} — ${quoi.join(', ')}`
                  : proposal.toolId;

              const mis = await deps.file.mettreEnFile({
                /* `OperationIdentity` est une chaîne MARQUÉE (ADR-030). Elle
                   traverse la frontière de la base comme du texte, et c'est
                   `fromClient()` qui la remarquera au retour — jamais un
                   `as` ici. */
                operationId: String(operationId),
                /* ADR-105 — un appel d'outil ordinaire : `/confirmer` le
                   rejouera par `gateway.invoke`. Le genre n'est PAS un détail
                   d'affichage : c'est lui qui dit à qui rendre l'intention. */
                genre: 'OUTIL',
                toolId: proposal.toolId,
                input: { ...input },
                provenance: { ...proposal.parameterProvenance },
                resume,
                demandeeDe: options.surface,
              });
              if (!mis.ok) return { kind: 'ERROR', message: mis.error.message };

              return {
                kind: 'EN_ATTENTE',
                resume: mis.value.resume,
                minutesRestantes: mis.value.minutesRestantes,
                reason: result.error.message,
              };
            }

            return { kind: 'DENIED', reason: result.error.message };
          }

          /* ⚠ UN PRÉREQUIS MANQUANT N'EST PAS UNE PANNE — ADR-097.

             Mesuré sur le banc des 30 actions, dès que les règles d'agenda ont
             existé : « qu'ai-je de prévu demain » sans compte Google rendait

                 « ERREUR : Aucun fournisseur d'agenda n'est configuré… »

             Le texte était juste ; le CANAL était faux. `docs/11` interdit
             qu'une phrase du quotidien produise une erreur technique brute, et
             l'utilisateur ne peut pas distinguer « ça a cassé » de « il te
             manque une étape ».

             `PROVIDER_UNAVAILABLE` est la même distinction qu'ADR-075 : la
             capacité EXISTE, il lui manque un prérequis que l'utilisateur peut
             fournir. « Aucun agenda connecté » dit quoi faire ; « ERREUR » dit
             d'attendre.

             L'outil, lui, ne change pas : il refuse toujours plutôt que de
             rendre une liste vide sur une journée dont on ne sait rien. */
          if (result.error.kind === 'PROVIDER_UNAVAILABLE') {
            return {
              kind: 'UNSUPPORTED',
              understood: `que tu veux utiliser ${proposal.toolId}`,
              missing: result.error.message,
            };
          }

          return { kind: 'ERROR', message: result.error.message };
        }

        /* CE QUE L'ÉCHANGE A ÉVOQUÉ — ADR-072.
           L'outil DÉCLARE la ressource touchée ; on ne devine rien et on ne
           connaît la forme d'aucun `output`. Une ressource d'un autre genre —
           note, tâche, mémoire — n'est pas une entité résoluble, et la liste
           reste vide plutôt que d'être remplie approximativement. */
        const touchee = result.value.resource;

        /* ⚠ LA DATE RETENUE SE DIT, MÊME SANS CONFIRMATION — ADR-077.

           J'avais justifié `HEURE_PAR_DEFAUT` par « elle est montrée dans la
           confirmation ». Mesuré ensuite : `reminder_create` ne DEMANDE aucune
           confirmation. Le défaut de 9 h était donc parfaitement silencieux, et
           mon raisonnement portait sur un chemin que cette action ne prend pas.

           Un défaut montré n'est pas un mensonge ; un défaut silencieux en est
           un. Jarvis dit donc l'instant qu'il a retenu, en français, dans la
           réponse elle-même — et la forme vient du MÊME calcul que la valeur
           écrite. */
        const quand = Object.values(lisible);
        const detail =
          quand.length > 0
            ? `${result.value.verification.detail}\n  J’ai retenu : ${quand.join(', ')}.`
            : result.value.verification.detail;

        return {
          kind: 'DONE',
          status: result.value.status,
          toolId: proposal.toolId,
          detail,
          output: result.value.output,
          mentionedEntityIds:
            touchee !== null && touchee.kind === 'entity' ? [touchee.id] : [],
        };
      } finally {
        // La confirmation ne doit jamais fuir vers l'appel suivant.
        deps.setGuardConfirmed(false);
      }
    },
  };
}
