/**
 * Tool Gateway.
 *
 * Référence : 03 §10, ADR-004, invariants S3, S4, S6, S7.
 *
 * C'est le seul chemin par lequel une proposition de modèle devient une action.
 * L'ordre des étapes est la sécurité elle-même :
 *
 *   validation → politique → idempotence → secrets → exécution
 *              → vérification → journal
 *
 * Deux inversions seraient fatales et méritent d'être nommées :
 *   — injecter les secrets AVANT la politique donnerait une clé à une action
 *     qui va être refusée ;
 *   — journaliser AVANT la vérification écrirait un succès que rien ne prouve.
 */
import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import type { Ledger } from '../ledger/ledger.js';
import { digestPayload } from '../ledger/event.js';
import type { PolicyGate } from '../policy/gate.js';
import type { PolicyOutcome } from '../policy/types.js';
import type { SecretVault } from '../secrets/vault.js';
import type { Actor, Mode, Provenance, VerificationStatus } from '../types/domain.js';
import { isUntrusted } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import type { VerificationEngine } from '../verification/engine.js';
import type {
  RegisteredTool,
  ToolContext,
  ToolExecution,
  VerificationOutcome,
} from './contract.js';
import { validateDefinition } from './contract.js';

export interface ToolCall {
  readonly toolId: string;
  /** Entrée brute, telle que proposée par le modèle. Jamais typée avant Zod. */
  readonly input: unknown;
  /**
   * Provenance par paramètre.
   *
   * C'est l'appelant (le Planning Engine) qui la renseigne, à partir de la
   * source réelle de chaque valeur. Un paramètre absent de cette carte est
   * traité comme `EXTERNAL_UNTRUSTED` : le défaut penche vers la prudence.
   */
  readonly parameterProvenance: Readonly<Record<string, Provenance>>;
  readonly operationId: string;
  readonly actor: Actor;
  readonly context: {
    readonly mode: Mode;
    readonly cloudEnabled: boolean;
    readonly proactive: boolean;
    readonly userConfirmed: boolean;
  };
}

export interface GatewayResult {
  readonly status: VerificationStatus;
  readonly output: unknown;
  readonly verification: VerificationOutcome;
  readonly policy: PolicyOutcome;
  readonly eventId: string;
  /** Vrai si l'opération existait déjà : rien n'a été réexécuté. */
  readonly replayed: boolean;
}

export interface ToolGateway {
  register(tool: RegisteredTool): Result<void>;
  list(): readonly RegisteredTool[];
  invoke(call: ToolCall): Promise<Result<GatewayResult>>;
}

function inputDigest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input) ?? 'null').digest('hex');
}

interface OperationRow {
  operation_id: string;
  tool_id: string;
  status: string;
  resource_kind: string | null;
  resource_id: string | null;
  input_digest: string;
}

/** Exécute avec un plafond de temps. Un outil qui ne rend pas la main ne bloque pas Jarvis. */
async function withTimeout<T>(
  promise: Promise<Result<T>>,
  timeoutMs: number,
  toolId: string,
): Promise<Result<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Result<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve(
        err(
          jarvisError(
            'TIMEOUT',
            `${toolId} n'a pas répondu en ${String(timeoutMs)} ms. ` +
              "L'action a peut-être abouti : le statut ne sera pas promu.",
          ),
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createToolGateway(deps: {
  db: Db;
  gate: PolicyGate;
  vault: SecretVault;
  ledger: Ledger;
  verifier: VerificationEngine;
}): ToolGateway {
  const tools = new Map<string, RegisteredTool>();

  return {
    register(tool: RegisteredTool): Result<void> {
      const problems = validateDefinition(tool.definition);
      if (problems.length > 0) {
        // Un contrat incohérent doit faire échouer le démarrage, pas produire
        // une surprise au premier appel.
        return err(
          jarvisError('CONFIGURATION', `Contrat d'outil invalide`, {
            tool: tool.definition.id,
            problems: problems.join(' | '),
          }),
        );
      }
      tools.set(tool.definition.id, tool);
      return ok(undefined);
    },

    list(): readonly RegisteredTool[] {
      return [...tools.values()];
    },

    async invoke(call: ToolCall): Promise<Result<GatewayResult>> {
      const tool = tools.get(call.toolId);
      if (tool === undefined) {
        return err(
          jarvisError('NOT_FOUND', `Outil inconnu : ${call.toolId}`, {
            // On ne liste pas les outils disponibles dans l'erreur : ce serait
            // renseigner un appelant hostile sur la surface d'attaque.
            requested: call.toolId,
          }),
        );
      }
      const def = tool.definition;

      /* --- 1. Validation de l'entrée ------------------------------------ */
      const parsed = tool.parseInput(call.input);
      if (!parsed.ok) return parsed;

      /* --- 2. Politique --------------------------------------------------
         `egress` est DÉRIVÉ du contrat, jamais fourni par l'appelant : sinon
         il suffirait de mentir sur ce champ pour contourner le Data Firewall
         et le mode privé. */
      const parameters = def.parameters.map((spec) => ({
        name: spec.name,
        provenance: call.parameterProvenance[spec.name] ?? 'EXTERNAL_UNTRUSTED',
        sensitive: spec.sensitive,
      }));

      const decision = deps.gate.decide({
        actor: call.actor,
        action: { tool: def.id, operation: 'invoke' },
        declaredAutonomy: def.autonomy,
        resource: {
          type: def.id,
          id: call.operationId,
          privacyClass: def.privacyClass,
        },
        context: {
          mode: call.context.mode,
          egress: def.networkRequired,
          cloudEnabled: call.context.cloudEnabled,
          proactive: call.context.proactive,
          userConfirmed: call.context.userConfirmed,
        },
        parameters,
      });
      if (!decision.ok) return decision;
      const policy = decision.value;

      if (policy.decision === 'DENY') {
        await deps.ledger.append({
          actor: call.actor,
          eventType: `${def.auditEvent}_DENIED`,
          tool: def.id,
          policyDecision: 'DENY',
          autonomyLevel: policy.effectiveAutonomy,
          status: 'FAILED',
          operationId: call.operationId,
          payloadDigest: digestPayload(parsed.value),
        });
        return err(
          jarvisError('POLICY_DENIED', policy.reasons.join(' '), {
            tool: def.id,
            autonomy: policy.effectiveAutonomy,
          }),
        );
      }

      if (policy.decision === 'CONFIRM') {
        // On expose les VALEURS concrètes des paramètres sensibles : la
        // confirmation doit porter sur ce qui va réellement se produire, pas
        // sur une intention résumée (03 §3).
        const sensitiveValues: Record<string, string> = {};
        const input = parsed.value;
        if (typeof input === 'object' && input !== null) {
          for (const spec of def.parameters) {
            if (!spec.sensitive) continue;
            const value = (input as Record<string, unknown>)[spec.name];
            if (value !== undefined) {
              sensitiveValues[spec.name] = String(value).slice(0, 200);
            }
          }
        }

        await deps.ledger.append({
          actor: call.actor,
          eventType: `${def.auditEvent}_PREPARED`,
          tool: def.id,
          policyDecision: 'CONFIRM',
          autonomyLevel: policy.effectiveAutonomy,
          status: 'UNKNOWN',
          operationId: call.operationId,
          payloadDigest: digestPayload(parsed.value),
        });

        return err(
          jarvisError('CONFIRMATION_REQUIRED', policy.reasons.join(' '), {
            tool: def.id,
            autonomy: policy.effectiveAutonomy,
            ...sensitiveValues,
          }),
        );
      }

      /* --- 3. Idempotence ------------------------------------------------ */
      const digest = inputDigest(parsed.value);
      const existing = await deps.db.query<OperationRow>(
        'SELECT * FROM tool_operations WHERE operation_id = $1',
        [call.operationId],
      );
      if (!existing.ok) return existing;

      const prior = existing.value.rows[0];
      if (prior !== undefined) {
        if (prior.input_digest !== digest) {
          // Même clé, arguments différents : ce n'est pas un rejeu, c'est un
          // défaut d'appelant. Exécuter serait pire que refuser.
          return err(
            jarvisError(
              'CONFLICT',
              `La clé d'opération ${call.operationId} a déjà servi avec des ` +
                'arguments différents.',
              { tool: def.id },
            ),
          );
        }

        // Rejeu authentique : on ne réexécute pas, on relit l'état réel.
        const replayContext: ToolContext = {
          db: deps.db,
          secrets: new Map(),
          operationId: call.operationId,
          actor: call.actor,
        };
        const replayExecution: ToolExecution = {
          output: null,
          ...(prior.resource_id !== null && prior.resource_kind !== null
            ? { resource: { kind: prior.resource_kind, id: prior.resource_id } }
            : {}),
        };
        const reVerified = await tool.readBack(replayExecution, replayContext);

        const verification: VerificationOutcome = reVerified.ok
          ? reVerified.value
          : {
              status: 'UNKNOWN',
              detail: `Rejeu : relecture impossible (${reVerified.error.message}).`,
            };

        const event = await deps.ledger.append({
          actor: call.actor,
          eventType: `${def.auditEvent}_REPLAYED`,
          tool: def.id,
          policyDecision: 'ALLOW',
          autonomyLevel: policy.effectiveAutonomy,
          status: verification.status,
          operationId: call.operationId,
          payloadDigest: digest,
        });
        if (!event.ok) return event;

        return ok({
          status: verification.status,
          output: null,
          verification,
          policy,
          eventId: event.value.eventId,
          replayed: true,
        });
      }

      /* --- 4. Secrets ----------------------------------------------------
         Résolus ici, après la politique, et remis à l'outil seul. Le modèle
         n'a jamais vu ni le nom résolu ni la valeur (invariant S3). */
      const secrets = new Map<string, string>();
      for (const name of def.requiredSecrets) {
        const secret = deps.vault.get(name);
        if (!secret.ok) return secret;
        secrets.set(name, secret.value.expose());
      }

      const ctx: ToolContext = {
        db: deps.db,
        secrets,
        operationId: call.operationId,
        actor: call.actor,
      };

      /* --- 5. Exécution --------------------------------------------------- */
      const executed = await withTimeout(
        tool.execute(parsed.value, ctx),
        def.timeoutMs,
        def.id,
      );

      if (!executed.ok) {
        await deps.ledger.append({
          actor: call.actor,
          eventType: `${def.auditEvent}_FAILED`,
          tool: def.id,
          policyDecision: 'ALLOW',
          autonomyLevel: policy.effectiveAutonomy,
          // Un timeout n'est pas un échec constaté : on ne sait pas.
          status: executed.error.kind === 'TIMEOUT' ? 'UNKNOWN' : 'FAILED',
          operationId: call.operationId,
          payloadDigest: digest,
        });
        return executed;
      }

      /* --- 6. Vérification ------------------------------------------------ */
      const verified = await deps.verifier.verify(tool, executed.value, ctx);
      if (!verified.ok) return verified;
      const verification = verified.value;

      /* --- 7. Registre d'opérations + journal ----------------------------- */
      const resource = executed.value.resource;
      const recorded = await deps.db.query(
        `INSERT INTO tool_operations
           (operation_id, tool_id, tool_version, status, resource_kind,
            resource_id, input_digest, actor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (operation_id) DO NOTHING`,
        [
          call.operationId,
          def.id,
          def.version,
          verification.status,
          resource?.kind ?? null,
          resource?.id ?? null,
          digest,
          call.actor,
        ],
      );
      if (!recorded.ok) return recorded;

      const event = await deps.ledger.append({
        actor: call.actor,
        eventType: def.auditEvent,
        tool: def.id,
        policyDecision: 'ALLOW',
        autonomyLevel: policy.effectiveAutonomy,
        status: verification.status,
        proof: verification.proof ?? null,
        operationId: call.operationId,
        payloadDigest: digest,
      });
      if (!event.ok) return event;

      return ok({
        status: verification.status,
        output: executed.value.output,
        verification,
        policy,
        eventId: event.value.eventId,
        replayed: false,
      });
    },
  };
}
