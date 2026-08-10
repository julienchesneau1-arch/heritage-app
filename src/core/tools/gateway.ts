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
import { err, ok, jarvisError, type Result } from '../types/result.js';
import { createSnapshotStore } from '../undo/snapshots.js';
import type { UnknownReason, VerificationEngine } from '../verification/engine.js';
import { verificationOutcome } from '../verification/engine.js';
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
  status: string | null;
  state: OperationState;
  resource_kind: string | null;
  resource_id: string | null;
  input_digest: string;
  attempts: number;
}

/**
 * Cycle de vie d'une opération — ADR-027.
 *
 *   PLANNED                  décidée, rien de tenté
 *   COMMITTED_TO_EXECUTION   barrière de durabilité, appel imminent
 *   EXECUTING                l'appel est parti — un effet est POSSIBLE
 *   SUCCEEDED │ FAILED │ UNKNOWN
 *
 * `EXECUTING` est l'état coûteux, et celui qui justifie tout le mécanisme :
 * c'est le seul depuis lequel Jarvis ignore si le monde a changé.
 */
export type OperationState =
  | 'PLANNED'
  | 'COMMITTED_TO_EXECUTION'
  | 'EXECUTING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'UNKNOWN';

/** Les états depuis lesquels un effet externe ne peut pas être exclu. */
const EFFECT_POSSIBLE: ReadonlySet<OperationState> = new Set<OperationState>([
  'EXECUTING',
  'UNKNOWN',
]);

/** Les états qui garantissent qu'aucun appel n'a été lancé. */
const NEVER_CALLED: ReadonlySet<OperationState> = new Set<OperationState>([
  'PLANNED',
  'COMMITTED_TO_EXECUTION',
]);

/**
 * Réponse au PERDANT d'une course sur une clé d'opération.
 *
 * La formulation est la partie qui compte. Cet appelant n'a pas échoué : il n'a
 * RIEN TENTÉ. Et il ne sait rien de l'issue de celui qui a pris l'engagement —
 * affirmer « c'est fait » comme « ça a échoué » serait également mensonger.
 *
 * C'est `FAIL CLOSED` appliqué à la concurrence : on ne sait pas, donc on
 * n'agit pas, et on le dit.
 */
function inFlight(call: ToolCall, toolId: string): Result<never> {
  return err(
    jarvisError(
      'OPERATION_IN_FLIGHT',
      `Une opération de même clé (${call.operationId}) est déjà engagée. ` +
        "Je n'ai rien tenté, et je n'affirme rien sur l'issue de l'autre appel.",
      { tool: toolId },
    ),
  );
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
  const snapshots = createSnapshotStore(deps.db);

  const gateway: ToolGateway = {
    register(tool: RegisteredTool): Result<void> {
      const problems = validateDefinition(
        tool.definition,
        tool.verifyAttempt !== undefined,
      );
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

    /**
     * Point d'entrée unique. Enveloppé par `guarded()` ci-dessous : quoi qu'il
     * arrive à l'intérieur, l'appelant reçoit une VALEUR, jamais une exception.
     */
    invoke(call: ToolCall): Promise<Result<GatewayResult>> {
      return guarded(call, () => execute(call));
    },
  };

  /**
   * Filet de sécurité du Gateway (HIGH-2).
   *
   * `06` pose que « les erreurs sont des valeurs typées, pas des exceptions
   * génériques ». Le Gateway violait sa propre règle : un outil qui levait
   * faisait rejeter `invoke()`, et — plus grave — l'exception échappait AVANT
   * toute écriture au journal. Une action qui casse ne laissait aucune trace,
   * donc `/audit` ne pouvait pas en parler.
   *
   * On ferme les deux trous d'un coup : l'exception devient un `Result`, et
   * l'incident est journalisé avant d'être rendu.
   */
  async function guarded(
    call: ToolCall,
    run: () => Promise<Result<GatewayResult>>,
  ): Promise<Result<GatewayResult>> {
    try {
      return await run();
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : 'défaut interne';
      const tool = tools.get(call.toolId);

      // Best-effort : si c'est la base qui est tombée, ce journal échouera
      // aussi. On ne masque pas l'erreur d'origine pour autant.
      await deps.ledger
        .append({
          actor: call.actor,
          eventType: `${tool?.definition.auditEvent ?? 'TOOL'}_CRASHED`,
          tool: call.toolId,
          policyDecision: null,
          autonomyLevel: null,
          // L'outil a peut-être eu un effet avant de lever : on ne sait pas.
          status: 'UNKNOWN',
          operationId: call.operationId,
          payloadDigest: digestPayload(call.input),
        })
        .catch(() => undefined);

      return err(
        jarvisError(
          'INTERNAL',
          `${call.toolId} a échoué de façon imprévue : ${message}. ` +
            'L\'action a peut-être eu un effet partiel ; le système ne l\'affirme pas.',
          { tool: call.toolId },
          cause,
        ),
      );
    }
  }

  /**
   * REPRISE D'UNE OPÉRATION DONT L'EFFET EST INCERTAIN — ADR-027.
   *
   * On arrive ici quand l'état trouvé est `EXECUTING` (le processus est mort
   * pendant l'appel) ou `UNKNOWN` (un timeout l'a déjà laissée en suspens).
   *
   * La règle est simple à énoncer et coûteuse à tenir :
   *
   *     ON NE REJOUE JAMAIS. On cherche à SAVOIR.
   *
   * Trois issues, et la troisième est la plus fréquente :
   *
   *   l'outil sait vérifier, et confirme  → CONFIRMED, sans réexécution
   *   l'outil sait vérifier, et infirme   → aucun effet : on peut exécuter
   *   l'outil ne sait pas, ou doute       → UNKNOWN, et Jarvis le DIT
   *
   * Le dernier cas n'est pas un échec du mécanisme : c'est son résultat le
   * plus honnête. Un système qui ne sait pas et le dit vaut infiniment mieux
   * qu'un système qui ne sait pas et renvoie un second virement.
   */
  async function resumeUncertain(
    call: ToolCall,
    tool: RegisteredTool,
    prior: OperationRow,
    digest: string,
    policy: PolicyOutcome,
    ctx: ToolContext,
  ): Promise<Result<GatewayResult>> {
    const def = tool.definition;

    const settle = async (
      state: OperationState,
      verification: VerificationOutcome,
      detail: string,
    ): Promise<Result<GatewayResult>> => {
      // Garde d'état (ADR-029) : on ne clôt que ce qui est encore en suspens.
      // Sans elle, une reprise lente écraserait le `SUCCEEDED` qu'une autre
      // reprise vient d'établir — Jarvis dirait « je ne sais pas » d'une
      // action qu'il vient pourtant de confirmer.
      await deps.db.query(
        `UPDATE tool_operations
            SET state = $2, status = $3, observed_at = now(), recovery_detail = $4
          WHERE operation_id = $1 AND state IN ('EXECUTING', 'UNKNOWN')`,
        [call.operationId, state, verification.status, detail.slice(0, 500)],
      );
      const event = await deps.ledger.append({
        actor: call.actor,
        eventType: `${def.auditEvent}_RESUMED`,
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
    };

    /* --- L'outil ne sait pas vérifier : c'est le cas des cinq outils --- */
    if (def.attemptVerification === 'NONE' || tool.verifyAttempt === undefined) {
      return settle(
        'UNKNOWN',
        verificationOutcome.unknown(
          `Une tentative de ${def.id} était en cours et son sort est inconnu. ` +
            'Je ne peux pas confirmer si l\'action a été exécutée, et je ne vais ' +
            'pas la rejouer automatiquement pour éviter un doublon.',
          // L'outil ne sait pas vérifier : c'est la cause RACINE de l'ignorance,
          // plus informative que « le processus a planté ».
          'VERIFICATION_UNAVAILABLE',
        ),
        `Reprise depuis ${prior.state} : aucune vérification de tentative disponible.`,
      );
    }

    /* --- L'outil sait vérifier : on lui demande --------------------------- */
    const verdict = await tool.verifyAttempt(call.operationId, ctx);
    if (!verdict.ok) {
      return settle(
        'UNKNOWN',
        verificationOutcome.unknown(
          `La vérification de la tentative a échoué (${verdict.error.message}). ` +
            'Je ne rejoue pas : le doute ne justifie pas un doublon.',
          'PROCESS_CRASH',
        ),
        'Reprise : vérification indisponible.',
      );
    }

    switch (verdict.value.kind) {
      case 'EFFECT_CONFIRMED':
        // `confirmed()` est la fabrique UNIQUE de CONFIRMED du système, et elle
        // exige une preuve. La reprise ne fait pas exception : elle passe par
        // le même goulot que l'exécution normale (S15).
        return settle(
          'SUCCEEDED',
          verificationOutcome.confirmed({
            observed: `reprise — ${verdict.value.detail}`,
            ...(verdict.value.proof === undefined ? {} : { proof: verdict.value.proof }),
          }),
          'Reprise : effet confirmé auprès du fournisseur, aucune réexécution.',
        );

      case 'NO_EFFECT': {
        /* Le seul chemin qui autorise une nouvelle exécution — et il exige une
           affirmation POSITIVE du fournisseur, jamais une absence de preuve.

           LE DÉFAUT QUE FOUNDATION 3 A MESURÉ ICI
           ---------------------------------------
           Ce retour à `PLANNED` était un `UPDATE` inconditionnel. Sur des
           reprises CONCURRENTES, il pouvait ramener en arrière une opération
           qu'une autre reprise venait d'engager : la seconde reprise rouvrait
           l'exécution d'un appel déjà en vol, et le monde changeait deux fois.

           La garde combine deux conditions, et il faut les deux :

             state IN ('EXECUTING','UNKNOWN')   l'opération est encore en suspens
             attempts = <valeur lue au départ>  personne ne l'a reprise depuis

           `attempts` sert ici de NUMÉRO DE VERSION. L'état seul ne suffit pas :
           il ne dit pas si le `EXECUTING` qu'on observe est celui d'un
           processus mort ou celui d'un appelant bien vivant. Le compteur, lui,
           les distingue. */
        const rewound = await deps.db.query(
          `UPDATE tool_operations
              SET state = 'PLANNED', recovery_detail = $3
            WHERE operation_id = $1
              AND state IN ('EXECUTING', 'UNKNOWN')
              AND attempts = $2`,
          [call.operationId, prior.attempts, `Reprise : ${verdict.value.detail}`],
        );
        if (!rewound.ok) return rewound;
        if ((rewound.value.rowCount ?? 0) === 0) {
          // Une autre reprise a pris la main entre notre lecture et notre
          // écriture. On ne rejoue pas derrière elle.
          return inFlight(call, def.id);
        }
        return gateway.invoke(call);
      }

      case 'INCONCLUSIVE':
        return settle(
          'UNKNOWN',
          verificationOutcome.unknown(
            `Vérification non concluante : ${verdict.value.detail}. ` +
              'Je ne peux pas confirmer si l\'action a été exécutée. Je ne la ' +
              'rejoue pas automatiquement.',
            // Le fournisseur a répondu, mais son état ne tranche pas.
            'EXTERNAL_STATE',
          ),
          'Reprise : vérification non concluante.',
        );
    }
  }

  return gateway;

  async function execute(call: ToolCall): Promise<Result<GatewayResult>> {
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

    /* --- 0. Santé de la base (CRIT-1) -----------------------------------
       Tout passe par PostgreSQL : la politique lit, le journal écrit, la
       vérification relit. Tenter une action alors que la base est tombée
       produirait une erreur à mi-parcours, dans un état indéterminé.

       On sonde d'abord : une base revenue doit être détectée sans redémarrer
       Jarvis. C'est la reconnexion automatique — `pg.Pool` crée un nouveau
       client, et une requête réussie remet l'état à UP. */
    if (deps.db.health().state === 'DOWN') {
      const probe = await deps.db.query('SELECT 1');
      if (!probe.ok) {
        const health = deps.db.health();
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            'La base de données est injoignable. Rien n\'a été tenté : ' +
              'aucune action ne sera annoncée comme faite tant qu\'elle ne ' +
              'peut pas être vérifiée.',
            {
              tool: def.id,
              depuis: health.state === 'DOWN' ? health.since : 'inconnu',
            },
          ),
        );
      }
    }

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
            // La confirmation doit porter sur la valeur CONCRÈTE. On la
            // sérialise sans supposer qu'elle est une chaîne : un objet
            // rendu « [object Object] » ne permettrait de confirmer rien.
            const rendered =
              typeof value === 'string' ? value : JSON.stringify(value);
            sensitiveValues[spec.name] = (rendered ?? '').slice(0, 200);
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

    /* --- 3. Idempotence et REPRISE (ADR-027) ---------------------------
       Ce bloc décide du sort d'une clé d'opération déjà connue. La règle qui
       le gouverne :

           « Le système ne doit jamais déduire "non exécuté" de "aucune
             trace". »

       Elle n'est tenable que parce que la trace PRÉCÈDE tout effet externe
       (§4 bis). L'absence de ligne devient alors une information fiable, et
       non un pari. */
    const digest = inputDigest(parsed.value);

    /* --- 3a. INSCRIPTION ATOMIQUE DE L'INTENTION (ADR-029) --------------
       L'ancien code lisait, puis insérait si rien n'existait. Entre les deux
       instants, N appels concurrents lisaient tous « rien » et concluaient
       tous « je suis le premier ».

       Le banc de Foundation 3 a mesuré 20 effets externes pour une clé unique
       à 100 appels simultanés — et 1 seul à 1 000, ce qui rendait le défaut
       invisible à qui ne testait qu'une seule charge.

       `ON CONFLICT DO NOTHING` supprime la fenêtre : sur N appels simultanés,
       PostgreSQL garantit qu'exactement un insère. Les autres l'apprennent par
       `rowCount === 0` et passent par le chemin de reprise. */
    const inscribed = await deps.db.query(
      `INSERT INTO tool_operations
         (operation_id, tool_id, tool_version, state, resource_kind,
          resource_id, input_digest, actor, attempts)
       VALUES ($1,$2,$3,'PLANNED',NULL,NULL,$4,$5,0)
       ON CONFLICT (operation_id) DO NOTHING`,
      [call.operationId, def.id, def.version, digest, call.actor],
    );
    if (!inscribed.ok) return inscribed;

    if ((inscribed.value.rowCount ?? 0) === 0) {
      /* --- 3b. La clé existait : rejeu, reprise, ou course ---------------- */
      const existing = await deps.db.query<OperationRow>(
        'SELECT * FROM tool_operations WHERE operation_id = $1',
        [call.operationId],
      );
      if (!existing.ok) return existing;

      const prior = existing.value.rows[0];
      if (prior === undefined) {
        // L'insertion a été refusée pour conflit, mais la ligne n'est pas
        // lisible. On ne devine pas : on refuse d'agir.
        return err(
          jarvisError(
            'INTEGRITY',
            `La clé d'opération ${call.operationId} est en conflit mais ` +
              'introuvable. Rien n\'a été tenté.',
            { tool: def.id },
          ),
        );
      }

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

      const replayContext: ToolContext = {
        db: deps.db,
        secrets: new Map(),
        operationId: call.operationId,
        actor: call.actor,
      };

      /* --- 3c. L'opération a pu avoir un effet : on NE REJOUE PAS ------- */
      if (EFFECT_POSSIBLE.has(prior.state)) {
        return await resumeUncertain(call, tool, prior, digest, policy, replayContext);
      }

      /* --- 3d. Aucun appel n'a jamais été lancé : on peut tenter -------- */
      if (NEVER_CALLED.has(prior.state)) {
        if (prior.state === 'COMMITTED_TO_EXECUTION') {
          // Arrêt entre les deux barrières : la décision était durable, l'appel
          // n'est jamais parti. On ramène à `PLANNED` — par compare-and-swap,
          // pour qu'un seul appelant le fasse et qu'aucun ne puisse ramener en
          // arrière une opération qu'un autre vient d'engager.
          const rewound = await deps.db.query(
            `UPDATE tool_operations SET state = 'PLANNED', recovery_detail = $2
               WHERE operation_id = $1 AND state = 'COMMITTED_TO_EXECUTION'`,
            [
              call.operationId,
              "Reprise depuis COMMITTED_TO_EXECUTION : aucun appel n'était parti.",
            ],
          );
          if (!rewound.ok) return rewound;
        }
        // `PLANNED` : rien à faire ici. Le compare-and-swap de l'étape 4 bis
        // départagera les appelants concurrents.
      } else {
        /* --- 3e. Rejeu d'une opération terminée : on relit l'état réel -- */
        const replayExecution: ToolExecution = {
          output: null,
          ...(prior.resource_id !== null && prior.resource_kind !== null
            ? { resource: { kind: prior.resource_kind, id: prior.resource_id } }
            : {}),
        };
        const reVerified = await tool.readBack(replayExecution, replayContext);

        const verification: VerificationOutcome = reVerified.ok
          ? reVerified.value
          : verificationOutcome.unknown(
              `Rejeu : relecture impossible (${reVerified.error.message}).`,
              'NO_OBSERVATION',
            );

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
    }

    /* --- 4. BARRIÈRE DE DURABILITÉ ET D'EXCLUSION (ADR-027, ADR-029) ----
       Deux écritures, et l'ordre est la propriété :

         COMMITTED_TO_EXECUTION   la décision d'appeler est durable ; l'appel
                                  n'est pas encore parti
         EXECUTING                l'appel part MAINTENANT

       Un arrêt entre les deux laisse `COMMITTED_TO_EXECUTION` : on sait
       qu'aucun effet n'existe, et la reprise peut exécuter sereinement.
       Un arrêt après laisse `EXECUTING` : on ne sait pas, et la reprise ne
       rejouera jamais d'elle-même.

       CE QUE FOUNDATION 3 A AJOUTÉ
       ----------------------------
       Ces deux écritures étaient des `UPDATE` INCONDITIONNELS. Elles rendaient
       le journal correct dans le TEMPS (un crash, un rejeu plus tard) et
       inopérant dans l'ESPACE (deux appels au même instant) : N appelants
       passaient tous les deux barrières et exécutaient tous.

       Chacune est désormais un COMPARE-AND-SWAP — `UPDATE … WHERE state = …`.
       PostgreSQL sérialise les écritures sur une même ligne et réévalue la
       condition après le verrou : exactement un appelant transite, les autres
       reçoivent `rowCount = 0`.

       C'est le seul goulot d'étranglement du système, et il est en base — pas
       dans un verrou en mémoire, qui ne survivrait ni à plusieurs processus ni
       à un redémarrage. */
    const committed = await deps.db.query(
      `UPDATE tool_operations
          SET state = 'COMMITTED_TO_EXECUTION', committed_at = now()
        WHERE operation_id = $1 AND state = 'PLANNED'`,
      [call.operationId],
    );
    if (!committed.ok) return committed;
    if ((committed.value.rowCount ?? 0) === 0) return inFlight(call, def.id);

    /* --- 4 bis. Secrets ------------------------------------------------
       Résolus APRÈS l'engagement et AVANT l'appel, et remis à l'outil seul.
       Le modèle n'a jamais vu ni le nom résolu ni la valeur (invariant S3).

       L'ordre importe : un secret manquant laisse l'opération en
       `COMMITTED_TO_EXECUTION`, état qui garantit qu'aucun appel n'est parti.
       Elle reste donc reprenable, au lieu d'être condamnée à `UNKNOWN` pour
       une raison sans rapport avec le monde extérieur. */
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

    const executing = await deps.db.query(
      `UPDATE tool_operations
          SET state = 'EXECUTING', executing_at = now(), attempts = attempts + 1
        WHERE operation_id = $1 AND state = 'COMMITTED_TO_EXECUTION'`,
      [call.operationId],
    );
    if (!executing.ok) return executing;
    if ((executing.value.rowCount ?? 0) === 0) return inFlight(call, def.id);

    /* --- 5. Exécution --------------------------------------------------- */
    const executed = await withTimeout(
      tool.execute(parsed.value, ctx),
      def.timeoutMs,
      def.id,
    );

    if (!executed.ok) {
      /* Un timeout n'est pas un échec constaté : l'outil a peut-être abouti.
         L'état reflète cette différence, parce que la reprise en dépendra.

         CE QUE FOUNDATION 3 A CORRIGÉ ICI
         ---------------------------------
         Seul le timeout donnait `UNKNOWN`. Toute autre erreur donnait `FAILED`
         — c'est-à-dire que Jarvis AFFIRMAIT l'absence d'effet sur la seule
         parole du fournisseur. Le banc a mis en scène le cas qui l'invalide :
         un fournisseur qui produit l'effet, puis répond `500`.

         Croire un `500` sur parole est exactement la faute symétrique de croire
         un `200`. La règle est la même dans les deux sens :

             une réponse de fournisseur est une OBSERVATION, jamais une preuve.

         Pour un effet `LOCAL_TRANSACTIONAL`, `FAILED` reste légitime : l'erreur
         a fait un rollback, et l'absence d'effet est garantie par PostgreSQL —
         pas par la parole de qui que ce soit. */
      const terminal: OperationState =
        executed.error.kind === 'TIMEOUT' || def.effect === 'EXTERNAL'
          ? 'UNKNOWN'
          : 'FAILED';
      // La CAUSE de l'ignorance est écrite au registre : la reprise en aura
      // besoin, et l'audit doit pouvoir distinguer un délai dépassé d'un
      // fournisseur qui a répondu sans trancher.
      const cause: UnknownReason | 'FAILED' =
        terminal === 'FAILED'
          ? 'FAILED'
          : executed.error.kind === 'TIMEOUT'
            ? 'PROVIDER_TIMEOUT'
            : 'EXTERNAL_STATE';

      await deps.db.query(
        `UPDATE tool_operations
            SET state = $2, status = $3, observed_at = now(), recovery_detail = $4
          WHERE operation_id = $1`,
        [
          call.operationId,
          terminal,
          terminal === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
          `${cause} — ${executed.error.message}`.slice(0, 500),
        ],
      );
      await deps.ledger.append({
        actor: call.actor,
        eventType: `${def.auditEvent}_FAILED`,
        tool: def.id,
        policyDecision: 'ALLOW',
        autonomyLevel: policy.effectiveAutonomy,
        // Le journal dit la même chose que le registre : ni plus affirmatif,
        // ni moins. Deux sources qui divergent, c'est une source de moins.
        status: terminal === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
        operationId: call.operationId,
        payloadDigest: digest,
      });
      return executed;
    }

    /* --- 6. Vérification ------------------------------------------------ */
    const verified = await deps.verifier.verify(tool, executed.value, ctx);
    if (!verified.ok) return verified;
    const verification = verified.value;

    /* --- 7. Capture d'état antérieur (ADR-019) --------------------------
       Avant le journal, et seulement si l'exécution a produit une ressource.
       Une capture qui échoue ne fait PAS échouer l'action — l'action a déjà
       eu lieu. Elle rend simplement l'annulation impossible, ce que le
       journal doit refléter. */
    const resource = executed.value.resource;
    let undoCaptured = false;

    if (executed.value.undo !== undefined && resource !== undefined) {
      const undo = executed.value.undo;
      const captured = await snapshots.capture({
        operationId: call.operationId,
        resourceKind: resource.kind,
        resourceId: resource.id,
        undoKind: undo.kind,
        ...(undo.kind === 'INVERSE_OPERATION'
          ? { inverseToolId: undo.inverseToolId, inverseInput: undo.inverseInput }
          : {}),
        ...(undo.kind === 'STATE_RESTORE' ? { priorState: undo.priorState } : {}),
        privacyClass: def.privacyClass,
      });
      undoCaptured = captured.ok;
    }

    /* --- 8. Clôture de l'opération + journal -----------------------------
       La ligne existe déjà — elle a été inscrite AVANT l'appel. On ne
       l'insère plus, on l'OBSERVE : c'est la distinction ACTION /
       OBSERVATION d'ADR-025, portée par les données et non par le discours. */
    const recorded = await deps.db.query(
      `UPDATE tool_operations
          SET state = $2, status = $3, resource_kind = $4, resource_id = $5,
              observed_at = now()
        WHERE operation_id = $1`,
      [
        call.operationId,
        verification.status === 'FAILED' ? 'FAILED'
          : verification.status === 'UNKNOWN' ? 'UNKNOWN'
          : 'SUCCEEDED',
        verification.status,
        resource?.kind ?? null,
        resource?.id ?? null,
      ],
    );
    if (!recorded.ok) return recorded;

    // Le suffixe ne s'applique qu'à une MUTATION restée sans capture. Une
    // lecture n'a rien à annuler : la suffixer polluerait le journal d'audit
    // d'un signal d'alerte permanent et sans objet.
    const undoExpected = resource !== undefined;
    const event = await deps.ledger.append({
      actor: call.actor,
      eventType:
        !undoExpected || undoCaptured
          ? def.auditEvent
          : `${def.auditEvent}_NO_UNDO`,
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
  }
}
