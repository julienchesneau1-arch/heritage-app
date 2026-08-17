/**
 * Contrat d'outil.
 *
 * Référence : 03 §10, PRD §39. « Aucun outil n'est accepté sans ces éléments. »
 *
 * Le contrat n'est pas de la documentation : c'est ce que lit le Tool Gateway
 * pour décider du niveau d'autonomie, de la vérification à effectuer, des
 * secrets à injecter et de l'événement à journaliser. Un champ manquant n'est
 * donc pas une omission de forme — c'est une décision de sécurité non prise.
 */
import { z } from 'zod';
import type { UnknownReason } from '../verification/engine.js';
import type { Db } from '../db/client.js';
import type {
  Actor,
  AutonomyLevel,
  DataCategory,
  EffectContract,
  EvidenceKind,
  PrivacyClass,
  Provenance,
  Verifiability,
  VerificationStatus,
} from '../types/domain.js';
import { isExternalEffect } from '../types/domain.js';
import type { Result } from '../types/result.js';
import type { OperationIdentity } from './identity.js';

/** Comment un outil prouve que le monde a changé (03 §10, invariant S7). */
export const VerificationStrategy = z.enum([
  // Lecture seule : il n'y a rien à vérifier, et prétendre le contraire
  // affaiblirait le sens du mot.
  'NONE',
  // On relit la ressource créée ou modifiée et on la compare à l'attendu.
  'READ_BACK',
  // Le fournisseur externe doit renvoyer une preuve (identifiant de message…).
  // Sans preuve : UNKNOWN, jamais CONFIRMED.
  'PROVIDER_PROOF',
]);
export type VerificationStrategy = z.infer<typeof VerificationStrategy>;

export const IdempotencyStrategy = z.enum([
  // L'outil ne mute rien : rejouer est sans conséquence.
  'NATURALLY_IDEMPOTENT',
  // Une clé d'opération protège contre la double exécution.
  'OPERATION_KEY',
]);
export type IdempotencyStrategy = z.infer<typeof IdempotencyStrategy>;

/** Déclaration d'un paramètre. C'est le CONTRAT qui dit ce qui est sensible. */
export interface ParameterSpec {
  readonly name: string;
  /**
   * Un paramètre est sensible quand une valeur erronée cause un dommage :
   * destinataire, montant, identifiant, chemin, URL.
   *
   * Cette déclaration est faite par nous, jamais par le modèle — c'est elle qui
   * arme la défense de provenance du Policy Gate (03 §3).
   */
  readonly sensitive: boolean;
}

export interface ToolDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;

  /** Niveau exigé. Le Gate peut le durcir, jamais l'assouplir. */
  readonly autonomy: AutonomyLevel;
  readonly privacyClass: PrivacyClass;

  readonly reversible: boolean;
  readonly networkRequired: boolean;

  readonly parameters: readonly ParameterSpec[];

  readonly idempotency: IdempotencyStrategy;
  readonly verification: VerificationStrategy;

  readonly timeoutMs: number;
  /** Nombre de tentatives. Toute reprise passe par la clé d'idempotence. */
  readonly maxRetries: number;

  /** Type d'événement écrit au journal. Un outil sans audit n'existe pas. */
  readonly auditEvent: string;

  /**
   * Secrets requis, par NOM.
   *
   * Le Gateway les résout depuis le coffre au moment de l'exécution. Le modèle
   * ne voit jamais ni le nom résolu ni la valeur (invariant S3).
   */
  readonly requiredSecrets: readonly string[];

  /** Comment défaire, quand c'est possible. `null` = irréversible. */
  readonly rollback: string | null;

  /**
   * L'outil sait-il dire, APRÈS COUP, si une tentative donnée a eu un effet ?
   *
   * Référence : ADR-027.
   *
   * C'est la question qui décide du sort d'une opération restée en
   * `EXECUTING` — le processus est mort pendant l'appel, et Jarvis ignore si
   * le monde a changé.
   *
   *   `NONE`               aucune vérification possible. La seule conduite
   *                        honnête est alors `UNKNOWN` + refus de rejouer.
   *   `BY_OPERATION_KEY`   le fournisseur sait répondre à « as-tu déjà traité
   *                        l'opération 8f2a… ? ». C'est la seule forme de
   *                        vérification qui soit réellement idempotente : elle
   *                        ne dépend pas d'une ressource dont on aurait perdu
   *                        l'identifiant.
   *
   * Déclarer `BY_OPERATION_KEY` sans fournir `verifyAttempt` est un défaut de
   * contrat, refusé à l'enregistrement.
   */
  readonly attemptVerification: 'NONE' | 'BY_OPERATION_KEY';

  /**
   * CONTRAT D'EFFET — ADR-033. Le champ le plus lourd de conséquences.
   *
   * Il décide de deux choses, et la seconde est celle qui coûte cher :
   *
   *   1. une erreur d'exécution prouve-t-elle l'absence d'effet ?
   *      → seuls `NO_EXTERNAL_EFFECT` et `LOCAL_TRANSACTIONAL` autorisent
   *        `FAILED` ; tous les autres donnent `UNKNOWN`.
   *
   *   2. un rejeu est-il autorisé après un `UNKNOWN` ?
   *      → seul `PROVIDER_IDEMPOTENT` l'autorise parmi les effets externes.
   *
   * Le point 2 vient d'un contre-exemple mesuré (`docs/21 §2`) : une requête
   * peut être encore EN VOL chez le fournisseur pendant qu'on observe un monde
   * vide. Aucune observation ne le détecte — seule une garantie du fournisseur
   * ferme le trou.
   */
  /**
   * DE QUOI cet outil parle — `docs/14 §3`.
   *
   * Le contrat déclare un FAIT (la nature de la donnée), jamais une POLITIQUE
   * (son niveau de protection). Le niveau est dérivé par le système :
   *
   *   > Le LLM ne choisit jamais lui-même son niveau de confidentialité.
   *   > Le système le détermine **avant** lui.
   *
   * La même discipline vaut pour un outil. S'il déclarait son niveau, il
   * suffirait d'écrire `PUBLIC` pour contourner la classification — et ce
   * serait tentant le jour où un outil légitime se ferait refuser.
   *
   * Pour un outil dont la catégorie varie avec l'appel (`memory_add` accepte
   * n'importe quelle catégorie en entrée), on déclare celle qui décrit sa
   * VOCATION ; le niveau par valeur reste l'affaire du Memory Guard.
   */
  readonly dataCategory: DataCategory;

  readonly effect: EffectContract;

  /**
   * Ce que cet outil est CAPABLE de prouver — ADR-030.
   *
   *   `VERIFIABLE`     présence ET absence. Peut conclure `FAILED`.
   *   `OBSERVABLE`     présence seulement. Ne peut JAMAIS conclure `FAILED` :
   *                    un effet différé pourrait encore arriver.
   *   `UNVERIFIABLE`   ni l'une ni l'autre. Plafonné à `PROBABLE`.
   *
   * Distinct de `verification`, qui dit COMMENT l'outil s'y prend. Ici on
   * déclare ce qu'il peut établir — et le Verification Engine bride son verdict
   * à cette déclaration, sans lui faire confiance.
   */
  readonly verifiability: Verifiability;

  /**
   * CE QUE VAUT LA SORTIE DE CET OUTIL — ADR-004, `docs/03 §3`.
   *
   * Le champ qui manquait pour que la séparation Privileged/Quarantined puisse
   * exister ailleurs que sur le papier.
   *
   *   `TOOL_OUTPUT`         la sortie vient de NOTRE code sur NOS données.
   *                         Semi-fiable : elle peut être fausse, elle n'est pas
   *                         hostile.
   *   `EXTERNAL_UNTRUSTED`  la sortie contient du contenu écrit par un TIERS —
   *                         page web, email, PDF, description d'outil MCP. Elle
   *                         peut être hostile, et elle n'est JAMAIS une
   *                         instruction.
   *
   * POURQUOI DANS LA DÉFINITION ET PAS DANS L'EXÉCUTION
   * ----------------------------------------------------
   * Même raisonnement que `dataCategory` : c'est un FAIT sur l'outil, connu à
   * l'enregistrement. Le laisser à l'exécution reviendrait à ce qu'un outil
   * décide au cas par cas si ce qu'il rend est fiable — c'est-à-dire à ce que
   * la valeur potentiellement hostile choisisse sa propre étiquette.
   *
   * `docs/26 §4.1` recensait `quarantine/processor.ts` comme « implémenté,
   * testé, JAMAIS APPELÉ : rien n'ingère aujourd'hui de contenu externe ». Ce
   * champ est ce par quoi la première ingestion se déclare.
   */
  readonly outputProvenance: Provenance;
}

/** Ce que le Gateway fournit à l'outil au moment de l'exécution. */
export interface ToolContext {
  readonly db: Db;
  /**
   * Secrets déjà résolus, par nom. Contient exactement `requiredSecrets`.
   * L'outil n'a pas accès au coffre complet — moindre privilège jusqu'au bout.
   */
  readonly secrets: ReadonlyMap<string, string>;
  readonly operationId: OperationIdentity;
  readonly actor: Actor;
}

/**
 * De quoi annuler l'exécution (ADR-019).
 *
 * C'est l'OUTIL qui sait comment se défaire — pas le Gateway, qui ignore la
 * sémantique de la ressource. Le Gateway se contente de capturer ce que
 * l'outil déclare, avant même que l'Undo Engine existe.
 */
export type UndoCapture =
  | {
      readonly kind: 'INVERSE_OPERATION';
      /**
       * Outil qui défait. Peut désigner un outil pas encore enregistré : la
       * capture est un enregistrement, pas une exécution. L'Undo Engine
       * vérifiera l'existence au moment d'annuler.
       */
      readonly inverseToolId: string;
      readonly inverseInput: unknown;
    }
  | { readonly kind: 'STATE_RESTORE'; readonly priorState: unknown }
  | { readonly kind: 'NOT_UNDOABLE' };

/** Résultat d'une exécution, avant vérification. */
export interface ToolExecution {
  readonly output: unknown;
  /** Ressource créée ou modifiée, s'il y en a une. Sert au rejeu et à la relecture. */
  readonly resource?: { readonly kind: string; readonly id: string };
  /** Preuve fournisseur, pour `PROVIDER_PROOF`. */
  readonly proof?: string;
  /**
   * Comment défaire. Obligatoire dès qu'il y a mutation : une action exécutée
   * sans capture est définitivement non annulable (ADR-019).
   */
  readonly undo?: UndoCapture;
  /**
   * OÙ C'EST PARTI — `docs/05 §C4`, ADR-052.
   *
   * Renseigné par les seuls outils qui sortent de la machine. Le Gateway ne
   * peut pas le déduire : il connaît le contrat, pas le fournisseur branché.
   * Prétendre le contraire produirait une console d'égression qui invente sa
   * colonne la plus utile.
   */
  readonly egress?: { readonly destination: string };
}

export interface VerificationOutcome {
  readonly status: VerificationStatus;
  readonly detail: string;
  readonly proof?: string;
  /**
   * Renseigné si et seulement si `status === 'UNKNOWN'`.
   *
   * Ne sert jamais à décider d'un rejeu — seulement à savoir quoi demander à
   * l'utilisateur, et quelle politique de reprise appliquer (`docs/14 §2`).
   */
  readonly unknownReason?: UnknownReason;
  /**
   * Ce qui FONDE le statut — ADR-030.
   *
   * `CONFIRMED` exige `POSITIVE_PRESENCE`, `FAILED` exige `POSITIVE_ABSENCE`.
   * Sans ce champ, les deux mots ne veulent rien dire de vérifiable.
   */
  readonly evidence?: EvidenceKind;
}

/**
 * Un outil enregistré, tel que manipulé par le Gateway.
 *
 * Le typage est volontairement effacé (`unknown`) à cette frontière : les
 * entrées viennent d'un modèle, donc elles franchissent Zod avant d'exister
 * en tant que type. `defineTool` restaure le typage à l'intérieur.
 */
/**
 * Ce qu'une vérification de tentative peut établir.
 *
 * `INCONCLUSIVE` n'est pas un échec de la vérification : c'est son résultat le
 * plus fréquent et le plus important. Le confondre avec `NO_EFFECT` produirait
 * exactement le double envoi qu'on cherche à empêcher.
 */
export type AttemptVerdict =
  | { readonly kind: 'EFFECT_CONFIRMED'; readonly detail: string; readonly proof?: string }
  | { readonly kind: 'NO_EFFECT'; readonly detail: string }
  | { readonly kind: 'INCONCLUSIVE'; readonly detail: string };

export interface RegisteredTool {
  readonly definition: ToolDefinition;
  parseInput(raw: unknown): Result<unknown>;
  execute(input: unknown, ctx: ToolContext): Promise<Result<ToolExecution>>;
  /** Relecture de l'état réel. Appelée par le Verification Engine. */
  readBack(
    execution: ToolExecution,
    ctx: ToolContext,
  ): Promise<Result<VerificationOutcome>>;
  /**
   * « Cette opération a-t-elle déjà eu un effet ? »
   *
   * Présente uniquement si `attemptVerification` vaut `BY_OPERATION_KEY`.
   * Appelée à la reprise, jamais pendant l'exécution normale.
   */
  verifyAttempt?(
    operationId: OperationIdentity,
    ctx: ToolContext,
  ): Promise<Result<AttemptVerdict>>;
}

/**
 * Fabrique un outil typé.
 *
 * L'implémentation reçoit un `input` déjà validé : elle n'a jamais à se
 * défendre elle-même contre une entrée de modèle.
 */
export function defineTool<I>(spec: {
  definition: ToolDefinition;
  inputSchema: z.ZodType<I>;
  execute: (input: I, ctx: ToolContext) => Promise<Result<ToolExecution>>;
  readBack?: (
    execution: ToolExecution,
    ctx: ToolContext,
  ) => Promise<Result<VerificationOutcome>>;
  verifyAttempt?: (
    operationId: OperationIdentity,
    ctx: ToolContext,
  ) => Promise<Result<AttemptVerdict>>;
}): RegisteredTool {
  return {
    definition: spec.definition,
    ...(spec.verifyAttempt === undefined ? {} : { verifyAttempt: spec.verifyAttempt }),

    parseInput(raw: unknown): Result<unknown> {
      const parsed = spec.inputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            kind: 'VALIDATION',
            message: `Entrée invalide pour ${spec.definition.id}`,
            details: {
              issues: parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join(' | '),
            },
          },
        };
      }
      return { ok: true, value: parsed.data };
    },

    async execute(input: unknown, ctx: ToolContext): Promise<Result<ToolExecution>> {
      // `input` a déjà franchi `parseInput` côté Gateway. On revalide malgré
      // tout : c'est bon marché, et cela rend l'outil sûr même si un futur
      // appelant oubliait l'étape.
      const parsed = spec.inputSchema.safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          error: {
            kind: 'VALIDATION',
            message: `Entrée invalide pour ${spec.definition.id}`,
          },
        };
      }
      return spec.execute(parsed.data, ctx);
    },

    async readBack(
      execution: ToolExecution,
      ctx: ToolContext,
    ): Promise<Result<VerificationOutcome>> {
      if (spec.readBack === undefined) {
        return {
          ok: true,
          value: {
            status: 'UNKNOWN',
            detail:
              `L'outil ${spec.definition.id} déclare ${spec.definition.verification} ` +
              `mais ne fournit pas de relecture. Statut non promu.`,
          },
        };
      }
      return spec.readBack(execution, ctx);
    },
  };
}

/**
 * Vérifie qu'un contrat est complet et cohérent.
 *
 * Appelé à l'enregistrement : un contrat incohérent doit faire échouer le
 * démarrage, pas produire un comportement surprenant au premier appel.
 */
export function validateDefinition(
  definition: ToolDefinition,
  hasVerifyAttempt = false,
): readonly string[] {
  const problems: string[] = [];

  if (definition.autonomy === 'L0') {
    problems.push('Un outil de niveau L0 ne peut pas exister : L0 signifie interdit.');
  }

  // Une mutation qui ne peut pas être vérifiée ne peut pas non plus être
  // annoncée comme réussie. On refuse le contrat plutôt que de laisser
  // l'ambiguïté se propager jusqu'à la réponse à l'utilisateur.
  if (definition.verification === 'NONE' && definition.autonomy !== 'L1') {
    problems.push(
      `${definition.id} mute (${definition.autonomy}) mais déclare une vérification NONE. ` +
        'Toute mutation doit être vérifiable, ou déclarer PROVIDER_PROOF.',
    );
  }

  if (
    definition.idempotency === 'NATURALLY_IDEMPOTENT' &&
    definition.autonomy !== 'L1'
  ) {
    problems.push(
      `${definition.id} mute mais se déclare naturellement idempotent. ` +
        'Une mutation exige une clé d\'opération (invariant S6).',
    );
  }

  if (!definition.reversible && definition.rollback !== null) {
    problems.push(
      `${definition.id} se déclare irréversible mais décrit un rollback.`,
    );
  }

  if (definition.reversible && definition.rollback === null) {
    problems.push(
      `${definition.id} se déclare réversible sans décrire comment défaire.`,
    );
  }

  if (definition.timeoutMs <= 0) {
    problems.push(`${definition.id} doit déclarer un timeout positif.`);
  }

  if (definition.auditEvent.length === 0) {
    problems.push(`${definition.id} doit déclarer un événement d'audit.`);
  }

  // Un outil qui promet de savoir vérifier une tentative, sans savoir le
  // faire, est pire qu'un outil qui l'avoue : la reprise croirait pouvoir
  // trancher et conclurait au hasard.
  if (definition.attemptVerification === 'BY_OPERATION_KEY' && !hasVerifyAttempt) {
    problems.push(
      `${definition.id} déclare BY_OPERATION_KEY sans fournir verifyAttempt.`,
    );
  }

  /* LA RÈGLE QUI REMPLACE UNE INTERDICTION — ADR-030.
     Foundation 3 s'était demandé s'il fallait interdire un outil EXTERNAL
     incapable de vérifier ses tentatives. Interdire aurait exclu des familles
     entières d'outils légitimes — un webhook chez un tiers sans API de
     consultation reste utile.
     On n'interdit donc pas l'OUTIL : on interdit l'ILLUSION DE FIABILITÉ.
     Un effet externe que le système ne sait pas observer ne peut pas se
     produire sans qu'un humain l'ait voulu explicitement. */
  if (
    isExternalEffect(definition.effect) &&
    definition.verifiability === 'UNVERIFIABLE' &&
    (definition.autonomy === 'L1' || definition.autonomy === 'L2')
  ) {
    problems.push(
      `${definition.id} produit un effet EXTERNAL qu'il ne sait pas vérifier ` +
        `(UNVERIFIABLE) et se déclare ${definition.autonomy} : un effet non ` +
        'observable ne peut pas être automatique. Exiger L3 (APPROVAL) ou L4.',
    );
  }

  /* UNE SORTIE D'OUTIL NE VAUT QUE DEUX CHOSES — ADR-055.

     `USER`, `SYSTEM` et `MEMORY` désignent des origines qu'un outil ne PRODUIT
     pas : il les consomme. Les autoriser ici permettrait à un outil de rendre
     du contenu web en le présentant comme une parole de l'utilisateur — la
     confusion exacte que la séparation Privileged/Quarantined existe pour
     empêcher.

     `MODEL_OUTPUT` est écarté pour une raison différente et volontairement
     stricte : aucun outil du dépôt n'appelle de modèle. Le jour où l'un le
     fera, cette règle devra être reprise — pas contournée. */
  if (
    definition.outputProvenance !== 'TOOL_OUTPUT' &&
    definition.outputProvenance !== 'EXTERNAL_UNTRUSTED'
  ) {
    problems.push(
      `${definition.id} déclare une sortie ${definition.outputProvenance} : ` +
        'un outil ne rend que TOOL_OUTPUT ou EXTERNAL_UNTRUSTED.',
    );
  }

  /* INGÉRER ET MUTER DANS LE MÊME OUTIL EST LE TROU QU'ADR-004 FERME.

     Un outil qui rapporte du contenu de tiers ET change le monde dans le même
     appel n'a aucune frontière entre les deux : le contenu hostile atteint
     l'effet sans repasser par le Policy Gate. Le plan doit se reformer entre
     l'ingestion et l'action, et c'est le Gateway qui en fait la garantie —
     seulement si le contrat interdit de les fondre.

     Concrètement : un outil ingérant est en LECTURE SEULE. Il rapporte, il ne
     décide pas. */
  if (definition.outputProvenance === 'EXTERNAL_UNTRUSTED') {
    if (definition.autonomy !== 'L1') {
      problems.push(
        `${definition.id} rapporte du contenu externe et se déclare ` +
          `${definition.autonomy} : un outil qui ingère est en lecture seule (L1). ` +
          'Ingérer et muter dans le même appel supprime la frontière ADR-004.',
      );
    }
    if (definition.verification !== 'NONE') {
      problems.push(
        `${definition.id} rapporte du contenu externe mais déclare une ` +
          'vérification de mutation : un outil qui ingère ne mute pas.',
      );
    }
  }

  // Un outil en lecture seule ne prouve ni présence ni absence d'une mutation
  // qu'il ne fait pas. Se déclarer VERIFIABLE y est un contresens.
  if (definition.verification === 'NONE' && definition.verifiability !== 'VERIFIABLE') {
    problems.push(
      `${definition.id} est en lecture seule : sa vérifiabilité doit être ` +
        'VERIFIABLE (la lecture EST son observation).',
    );
  }

  return problems;
}
