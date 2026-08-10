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
import type { Db } from '../db/client.js';
import type {
  Actor,
  AutonomyLevel,
  PrivacyClass,
  VerificationStatus,
} from '../types/domain.js';
import type { Result } from '../types/result.js';

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
}

/** Ce que le Gateway fournit à l'outil au moment de l'exécution. */
export interface ToolContext {
  readonly db: Db;
  /**
   * Secrets déjà résolus, par nom. Contient exactement `requiredSecrets`.
   * L'outil n'a pas accès au coffre complet — moindre privilège jusqu'au bout.
   */
  readonly secrets: ReadonlyMap<string, string>;
  readonly operationId: string;
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
}

export interface VerificationOutcome {
  readonly status: VerificationStatus;
  readonly detail: string;
  readonly proof?: string;
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
  verifyAttempt?(operationId: string, ctx: ToolContext): Promise<Result<AttemptVerdict>>;
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
    operationId: string,
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

  return problems;
}
