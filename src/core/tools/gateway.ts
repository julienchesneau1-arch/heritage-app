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
import { isExternalEffect, mayReplayAfterUnknown } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import { createSnapshotStore } from '../undo/snapshots.js';
import { floorFor } from '../privacy/classify.js';
import { sealExternal } from '../quarantine/processor.js';
import { createEmergencyHalt } from '../safety/halt.js';
import { confirmableKey, renderConfirmable } from './confirmation.js';
import type { OperationIdentity } from './identity.js';
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
  /**
   * Identité de l'INTENTION, pas de la tentative — ADR-030.
   *
   * Type marqué : une chaîne ordinaire n'y est pas assignable. Un repli sur un
   * autre fournisseur doit donc réutiliser l'identité existante
   * (`sameOperation`), et frapper une clé neuve devient un acte délibéré et
   * visible plutôt qu'un réflexe.
   */
  readonly operationId: OperationIdentity;
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

  /**
   * LA RESSOURCE TOUCHÉE — ADR-072.
   *
   * L'appelant ne savait pas ce qu'un outil venait d'affecter. Il lui restait à
   * fouiller `output`, dont la forme appartient à chaque outil : l'Assistant
   * aurait dû connaître `entityId` pour `entity_create`, `noteId` pour
   * `note_create`… c'est-à-dire porter la connaissance de chaque outil, ce que
   * le contrat existe précisément pour éviter.
   *
   * `null` PLUTÔT QU'OPTIONNEL, et ce n'est pas un détail : une lecture ne
   * touche aucune ressource, et cette absence est un FAIT, pas un oubli. Un
   * champ optionnel est un champ qu'on oublie (ADR-055).
   */
  readonly resource: { readonly kind: string; readonly id: string } | null;

  /**
   * CE QUE VAUT `output` — ADR-055.
   *
   * Toujours renseignée, et c'est délibéré : un champ optionnel serait un
   * champ oublié. Un appelant qui reçoit `EXTERNAL_UNTRUSTED` tient du contenu
   * écrit par un tiers, qui ne peut jamais devenir une instruction.
   *
   * Recopiée du CONTRAT de l'outil, jamais de son exécution : sinon la valeur
   * potentiellement hostile choisirait sa propre étiquette.
   */
  readonly provenance: Provenance;

  /**
   * Le contenu externe semblait-il porter une tentative d'instruction ?
   *
   * **Indicatif, jamais une barrière** — même discipline que
   * `QuarantineReading`. Une injection non détectée reste inoffensive :
   * l'étiquette, elle, n'est pas conditionnelle. Vaut toujours `false` pour un
   * outil dont la sortie est `TOOL_OUTPUT` : il n'y a rien à soupçonner dans
   * notre propre code.
   */
  readonly suspectedInjection: boolean;
}

export interface ToolGateway {
  register(tool: RegisteredTool): Result<void>;
  list(): readonly RegisteredTool[];
  invoke(call: ToolCall): Promise<Result<GatewayResult>>;
  /**
   * RÉTABLIT LA CONFIANCE DANS UN OUTIL — `docs/22 §9`, invariant I12.
   *
   * Sans ce chemin, une seule violation condamnerait l'outil définitivement :
   * un bogue de fournisseur, corrigé le lendemain, laisserait Jarvis muet pour
   * toujours. Ce serait un déni de service offert au premier service qui a un
   * défaut — et le document demande de DÉGRADER la confiance, pas de la
   * détruire.
   *
   * Réservé à `USER`. Jarvis ne peut pas se rendre à lui-même une confiance
   * qu'un constat lui a retirée : ce serait exactement « le modèle décide »,
   * là où la constitution du projet pose que le modèle propose et que le
   * système — ici l'humain — décide.
   *
   * L'acte est JOURNALISÉ. Personne ne doit pouvoir rétablir une confiance en
   * silence.
   */
  restoreTrust(
    toolId: string,
    actor: Actor,
    reason: string,
  ): Promise<Result<void>>;
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
  lease_generation: number;
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

/**
 * Marge ajoutée au bail d'exécution — ADR-032.
 *
 * Le Gateway impose `withTimeout(def.timeoutMs)` : passé ce délai, un exécutant
 * vivant a forcément écrit un état terminal. La marge couvre ce qui sépare
 * l'expiration du minuteur de l'écriture effective — un aller-retour en base,
 * une pause du ramasse-miettes, une horloge qui n'avance pas au même rythme.
 *
 * Se tromper d'un côté coûte une attente ; se tromper de l'autre coûte un
 * second virement. La marge est donc large à dessein.
 */
const LEASE_MARGIN_MS = 5_000;

/**
 * CE QU'EST UN BAIL JARVIS — ADR-035.
 *
 * Une seule phrase, et surtout PAS une autre :
 *
 *   > Jusqu'à cet instant, cet exécutant possède le DROIT LOGIQUE d'écrire
 *   > dans l'état de cette opération.
 *
 * Ce qu'un bail n'est jamais :
 *
 *   ✗ une mesure de la vie d'un processus        (`docs/21`)
 *   ✗ une preuve d'absence d'effet externe       (ADR-033)
 *   ✗ une annulation de requête                  (rien ne l'offre)
 *
 * Le droit d'écrire est porté par la GÉNÉRATION, pas par le temps. L'échéance
 * ne sert qu'à décider quand un autre exécutant a le droit de PRENDRE la
 * relève — jamais à conclure quoi que ce soit sur le monde.
 */
export interface LeaseHolder {
  readonly operationId: OperationIdentity;
  /** Le jeton de cloisonnement. Frappé atomiquement, jamais réutilisé. */
  readonly generation: number;
}

/**
 * Identité du processus, à titre DIAGNOSTIC uniquement.
 *
 * Ne participe à aucune décision de sûreté : la génération suffit, puisqu'elle
 * est frappée dans le même compare-and-swap que la prise de bail. Sert à
 * répondre à « quel processus a lancé cet appel ? ».
 */
const EXECUTOR_ID = `pid-${String(process.pid)}`;

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

/**
 * Réponse à un exécutant dont l'autorité a EXPIRÉ — ADR-035.
 *
 * Catégorie distincte d'`OPERATION_IN_FLIGHT` : celui-là n'avait jamais obtenu
 * l'autorité ; celui-ci l'a EUE et l'a PERDUE. Entre les deux, il a peut-être
 * lancé un appel, et cet appel a peut-être eu un effet.
 *
 * On ne lui rend donc PAS un état terminal — il n'a plus l'autorité d'en
 * décider un, et il n'a aucune information neuve sur le monde. On lui dit
 * exactement ce qu'il est : périmé, et sans opinion recevable.
 */
function staleExecutor(
  call: ToolCall,
  toolId: string,
  lease: LeaseHolder,
): Result<never> {
  return err(
    jarvisError(
      'STALE_EXECUTOR',
      `Le bail de cette exécution (génération ${String(lease.generation)}) a été ` +
        "repris par un autre exécutant. Je n'ai plus l'autorité d'écrire le " +
        "résultat de cette opération, et je n'affirme rien sur son issue.",
      { tool: toolId, operation: call.operationId },
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
  /* CONSTRUIT ICI, PAS INJECTÉ — et c'est une décision de sûreté.

     Un `EmergencyHalt` passé en dépendance serait remplaçable par une doublure
     qui répond toujours « pas arrêté », et la protection ne serait plus jamais
     éprouvée dans les tests de bout en bout. `stack.ts` pose la règle :
     « aucun composant simulé côté sécurité — un test adossé à un Policy Engine
     factice ne prouverait que notre intention ». Même raisonnement, même
     traitement que `snapshots`. */
  const haltState = createEmergencyHalt(deps.db);

  /* ══════════════════════════════════════════════════════════════════════
     LA PRIMITIVE UNIQUE D'ÉCRITURE AUTORITAIRE — ADR-035.

     TOUTE écriture d'un détenteur de bail passe par ici, et par nulle part
     ailleurs. Elle couvre l'intégralité de ce que le mandat énumère :

       état terminal · verdict de vérification · provenance de la ressource
       estampille d'observation · métadonnées de reprise · échéance de bail

     La garde est la MÊME pour toutes — une seule clause, un seul endroit. Un
     cloisonnement écrit colonne par colonne aurait exactement la faiblesse
     qu'il prétend corriger : il suffirait d'un `SET` oublié pour rouvrir le
     passage, et rien ne le signalerait.

     L'invariant I17 (`tests/lab/invariants.ts`) vérifie MÉCANIQUEMENT que tout
     `UPDATE tool_operations` de `src/` est soit cloisonné par
     `lease_generation`, soit cantonné à un état d'où aucun effet n'est
     possible. Corriger le défaut principal en laissant une porte latérale
     serait pire que de ne rien corriger : on croirait le trou fermé.

     Rend `false` quand le jeton est périmé — jamais une erreur : être périmé
     n'est pas une panne, c'est une perte d'autorité, et l'appelant doit
     pouvoir la traiter comme telle.
     ══════════════════════════════════════════════════════════════════════ */
  async function writeAuthoritative(
    lease: LeaseHolder,
    setClause: string,
    params: readonly unknown[],
    /** Garde supplémentaire, jamais substitutive. Peut réutiliser `params`. */
    extraGuard?: string,
  ): Promise<Result<boolean>> {
    const fence = `$${String(params.length + 2)}`;
    const written = await deps.db.query(
      `UPDATE tool_operations SET ${setClause}
        WHERE operation_id = $1
          AND lease_generation = ${fence}
          ${extraGuard === undefined ? '' : `AND ${extraGuard}`}`,
      [lease.operationId, ...params, lease.generation],
    );
    if (!written.ok) return written;
    return ok((written.value.rowCount ?? 0) === 1);
  }

  /**
   * PREND le bail pour une REPRISE, sans toucher à l'état.
   *
   * Concurrence optimiste : la garde porte sur la génération LUE par le
   * repreneur. Deux repreneurs simultanés lisent la même valeur, un seul
   * l'incrémente — l'autre apprend qu'il est arrivé trop tard au lieu
   * d'écraser silencieusement le verdict du premier.
   */
  async function claimForRecovery(
    operationId: OperationIdentity,
    expectedGeneration: number,
  ): Promise<Result<LeaseHolder | null>> {
    const taken = await deps.db.query<{ lease_generation: number }>(
      `UPDATE tool_operations
          SET lease_generation = lease_generation + 1, lease_owner = $3
        WHERE operation_id = $1 AND lease_generation = $2
      RETURNING lease_generation`,
      [operationId, expectedGeneration, EXECUTOR_ID],
    );
    if (!taken.ok) return taken;
    const row = taken.value.rows[0];
    if (row === undefined) return ok(null);
    return ok({ operationId, generation: row.lease_generation });
  }

  /**
   * PREND le bail et frappe une génération neuve.
   *
   * Le compare-and-swap et l'incrément de génération sont la MÊME instruction :
   * deux exécutants ne peuvent donc jamais obtenir la même génération.
   *
   * `clock_timestamp()` et non `now()` : `now()` rend l'heure de début de
   * transaction, et une échéance née vieille ferait expirer le bail trop tôt —
   * donc une reprise prématurée (`docs/23 §3.2`). Défense en profondeur : le
   * Gateway n'est de toute façon jamais dans la transaction d'un appelant.
   */
  async function acquireLease(
    operationId: OperationIdentity,
    leaseMs: number,
  ): Promise<Result<LeaseHolder | null>> {
    const taken = await deps.db.query<{ lease_generation: number }>(
      /* L'état de départ est un LITTÉRAL, pas un paramètre. Un bail ne se
         frappe qu'à un seul endroit du cycle de vie, et le lecteur — humain ou
         invariant structurel — doit pouvoir le constater sans suivre les
         appelants. */
      `UPDATE tool_operations
          SET state = 'EXECUTING',
              executing_at = clock_timestamp(),
              attempts = attempts + 1,
              lease_generation = lease_generation + 1,
              lease_owner = $2,
              lease_expires_at = clock_timestamp() + ($3 || ' milliseconds')::interval
        WHERE operation_id = $1 AND state = 'COMMITTED_TO_EXECUTION'
      RETURNING lease_generation`,
      [operationId, EXECUTOR_ID, String(leaseMs)],
    );
    if (!taken.ok) return taken;

    const row = taken.value.rows[0];
    if (row === undefined) return ok(null);
    return ok({ operationId, generation: row.lease_generation });
  }

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

    async restoreTrust(
      toolId: string,
      actor: Actor,
      reason: string,
    ): Promise<Result<void>> {
      const tool = tools.get(toolId);
      if (tool === undefined) {
        return err(jarvisError('NOT_FOUND', `Outil inconnu : ${toolId}`));
      }
      if (actor !== 'USER') {
        /* LA GARDE QUI DONNE SON SENS AU MÉCANISME. Si Jarvis pouvait se
           rendre sa propre confiance, la rupture ne coûterait rien et le
           constat n'aurait aucune conséquence. */
        return err(
          jarvisError(
            'POLICY_DENIED',
            'Seul un humain peut rétablir la confiance dans un service. ' +
              'Jarvis ne se rend pas à lui-même une confiance qu\'un constat ' +
              'lui a retirée.',
            { tool: toolId, actor },
          ),
        );
      }
      if (reason.trim().length === 0) {
        // Un rétablissement sans motif ne serait pas auditable.
        return err(
          jarvisError('VALIDATION', 'Un rétablissement de confiance exige un motif.', {
            tool: toolId,
          }),
        );
      }

      const event = await deps.ledger.append({
        actor,
        eventType: `${tool.definition.auditEvent}_TRUST_RESTORED`,
        tool: toolId,
        policyDecision: 'ALLOW',
        autonomyLevel: 'L0',
        // Rien n'est affirmé sur les opérations passées : elles gardent leur
        // verdict. Seule la question « puis-je agir de nouveau ? » change.
        status: 'NOT_ATTEMPTED',
        operationId: null,
        payloadDigest: digestPayload({ tool: toolId, reason }),
      });
      if (!event.ok) return event;
      return ok(undefined);
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
    recoveryLease: LeaseHolder,
  ): Promise<Result<GatewayResult>> {
    const def = tool.definition;

    const settle = async (
      state: OperationState,
      verification: VerificationOutcome,
      detail: string,
    ): Promise<Result<GatewayResult>> => {
      /* Le repreneur écrit sous SON bail (ADR-035). S'il l'a perdu entre-temps,
         `writeAuthoritative` rend `false` et rien n'est écrit — la garde d'état
         d'ADR-029 ne suffisait pas : deux repreneurs concurrents la
         satisfaisaient tous les deux. */
      const settled = await writeAuthoritative(
        recoveryLease,
        `state = $2, status = $3, observed_at = clock_timestamp(),
         recovery_detail = $4, lease_expires_at = NULL`,
        [state, verification.status, detail.slice(0, 500)],
      );
      if (!settled.ok) return settled;
      if (!settled.value) return staleExecutor(call, def.id, recoveryLease);
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
        /* RIEN N'A ÉTÉ RÉEXÉCUTÉ, donc rien n'a été observé : on ne recompose
           pas une ressource depuis un verdict déjà écrit. `null` dit « je ne
           l'ai pas vue », pas « il n'y en a pas ». */
        resource: null,
        /* La provenance reste celle du CONTRAT, même sans sortie : elle décrit
           ce que cet outil produit, pas ce qu'on vient d'obtenir. */
        provenance: def.outputProvenance,
        // Rien n'a été rapporté, donc rien n'a été balayé. Annoncer `false`
        // sur du contenu inexistant est exact ; l'annoncer sur du contenu non
        // regardé ne le serait pas.
        suspectedInjection: false,
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
        /* ══ LA GARDE QU'IL MANQUAIT — ADR-033 ══════════════════════════════
           `NO_EFFECT` est une observation à un INSTANT. Elle ne dit rien d'une
           requête encore en vol chez le fournisseur.

           Le contre-exemple mesuré (`docs/21 §2`) :

             A envoie sa requête, puis gèle ou meurt
             le bail expire — mais la requête, elle, vit toujours
             B vérifie : le monde est encore vide → NO_EFFECT
             B exécute                            → EFFET B
             la requête de A aboutit enfin        → EFFET A

           Aucune observation ne pouvait sauver B : au moment où il regarde,
           il n'y a rien À VOIR. Ce n'est donc pas un défaut de vérification,
           c'est une limite de l'observation elle-même.

           Seule une garantie du FOURNISSEUR ferme le trou : s'il dédoublonne
           sur notre identité d'opération, rejouer est sûr même si la requête
           de A aboutit ensuite. */
        if (!mayReplayAfterUnknown(def.effect)) {
          return settle(
            'UNKNOWN',
            verificationOutcome.unknown(
              `${def.id} n'a constaté aucun effet, mais son contrat (${def.effect}) ` +
                "ne garantit pas qu'une requête antérieure ne soit pas encore en " +
                'vol. Je ne rejoue pas : une absence observée n\'est pas une ' +
                'absence garantie.',
              // Le fournisseur a répondu, son état ne tranche pas sur l'avenir.
              'EXTERNAL_STATE',
            ),
            `Reprise refusée : contrat ${def.effect} — aucune garantie d'idempotence.`,
          );
        }

        /* Le seul chemin qui autorise une nouvelle exécution — et il exige une
           affirmation POSITIVE du fournisseur, jamais une absence de preuve.

           LE CHEMIN PARALLÈLE QUE L'AUDIT DE F5.1 A TROUVÉ ICI
           ---------------------------------------------------
           Ce rembobinage était gardé par `attempts`, tenu depuis Foundation 3
           pour un numéro de version suffisant. Il ne l'est pas, et c'est
           mesurable :

             B reprend            → génération 5, `attempts` INCHANGÉ
             B interroge le monde → NO_EFFECT (l'appel prend du temps)
             C reprend            → génération 6 ; B est désormais périmé
             B rembobine          → `attempts` n'a pas bougé : ÇA PASSE

           Un exécutant sans autorité rouvrait donc l'exécution d'une opération
           qu'un autre était en train de trancher. `claimForRecovery` ne touche
           pas à `attempts` — seule l'exécution l'incrémente — si bien que le
           compteur ne voyait tout simplement pas passer les reprises.

           La garde est maintenant la génération, comme partout ailleurs. Le
           filtre d'état reste, en défense supplémentaire et jamais en
           remplacement : il dit ce qu'on croyait rembobiner. */
        const rewound = await writeAuthoritative(
          recoveryLease,
          /* `observed_at` et `status` doivent être effacés en même temps :
             la contrainte `terminal_states_are_observed` interdit un état non
             terminal qui porterait encore une observation.

             Sans cela, le rembobinage depuis `UNKNOWN` levait une exception —
             et le chemin de reprise n'a JAMAIS fonctionné depuis Foundation 3.
             Le défaut était masqué par `guarded()`, qui transformait le
             plantage en `INTERNAL` : les tests passaient, pour la pire des
             raisons (`docs/21 §3`). */
          `state = 'PLANNED', recovery_detail = $2,
           observed_at = NULL, status = NULL, lease_expires_at = NULL`,
          [`Reprise : ${verdict.value.detail}`],
          `state IN ('EXECUTING', 'UNKNOWN')`,
        );
        if (!rewound.ok) return rewound;
        if (!rewound.value) {
          // Une autre reprise a pris la main entre notre lecture et notre
          // écriture. On ne rejoue pas derrière elle, et on ne prétend pas
          // savoir ce qu'elle a conclu.
          return staleExecutor(call, def.id, recoveryLease);
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
        /* DÉRIVÉ, jamais déclaré. Un outil annonce DE QUOI il parle ; le
           système en déduit le niveau (`docs/14 §3`). S'il déclarait son
           niveau, il suffirait d'écrire `PUBLIC` pour contourner la
           classification — et ce serait tentant le jour où un outil légitime
           se ferait refuser. */
        dataLevel: floorFor(def.dataCategory),
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
            /* CLÉ PRÉFIXÉE, et troncature DÉCLARÉE — ADR-063.

               Avant : la clé était le nom nu du paramètre, et le `.slice(0, 200)`
               coupait en silence. Un paramètre nommé `tool` aurait écrasé la
               métadonnée puis disparu du tri des consommateurs ; et une requête
               de 256 caractères perdait les cinquante-six derniers sans un mot. */
            sensitiveValues[confirmableKey(spec.name)] = renderConfirmable(value);
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

      /* --- 3c. L'opération a pu avoir un effet : on NE REJOUE PAS -------
         BAIL D'EXÉCUTION — ADR-032.

         Le chaos runner de Foundation 4 a trouvé ici un double effet que ni
         les tests de crash ni ceux de concurrence n'avaient vu. Le
         contre-exemple minimal tient en trois appels simultanés :

           A gagne le CAS, part exécuter (60 ms de latence)
           B trouve EXECUTING, appelle verifyAttempt
             → le monde est encore VIDE : A n'a pas fini d'écrire
             → verdict NO_EFFECT
           B rembobine, gagne le CAS, exécute
             → DEUX EFFETS

         La correction de Foundation 3 utilisait `attempts` comme numéro de
         version, sur ce raisonnement écrit noir sur blanc : « l'état seul ne
         suffit pas, il ne dit pas si le EXECUTING observé est celui d'un
         processus mort ou d'un appelant vivant ; le compteur, lui, les
         distingue. »

         C'ÉTAIT FAUX. Un exécutant VIVANT porte `EXECUTING, attempts = 1` —
         exactement ce que lit un repreneur qui croit succéder à un mort. Le
         raisonnement ne tenait que pour un crash, où plus personne ne bouge.

         Ce qui distingue réellement les deux : LE TEMPS. Le Gateway impose
         lui-même `withTimeout(def.timeoutMs)` à toute exécution. Passé
         `executing_at + timeoutMs`, un exécutant vivant a donc forcément écrit
         un état terminal. Si l'opération est TOUJOURS en `EXECUTING` au-delà,
         c'est qu'il est mort.

         Avant l'expiration du bail, la seule réponse honnête est « je n'ai
         rien tenté » : on ne peut ni vérifier ni conclure pendant qu'un autre
         appel est en vol. */
      if (EFFECT_POSSIBLE.has(prior.state)) {
        if (prior.state === 'EXECUTING') {
          /* L'ÉCHÉANCE EST LUE, JAMAIS RECALCULÉE — ADR-036.

             Ce contrôle recalculait `executing_at + def.timeoutMs + marge`
             avec le `timeoutMs` que LE REPRENEUR connaît. Or l'échéance est
             une propriété de l'ACQUISITION : c'est l'exécutant parti qui l'a
             fixée, avec le délai qu'il appliquait vraiment.

               A part avec timeoutMs = 30 000   →  échéance réelle : +35 s
               le contrat change, redéploiement →  timeoutMs = 2 000
               B reprend et RECALCULE           →  croit l'échéance à +7 s
                                                   ⟹ reprise PRÉMATURÉE

             Quatrième occurrence du même motif : l'observateur redéfinit le
             passé. `attempts` l'avait fait pour l'autorité (trois fois), le
             recalcul le faisait pour l'échéance.

             `COALESCE(…, 'infinity')` est du FAIL CLOSED : une échéance nulle
             sur un `EXECUTING` est impossible par contrainte, et si elle
             survenait, bloquer une reprise coûte une attente là où la
             permettre coûterait un second effet.

             Évalué PAR LA BASE : comparer avec l'horloge du processus
             introduirait une dérive entre machines, et le bail deviendrait
             faux là où il compte le plus. `now()` figé ne peut ici que
             SUR-estimer le bail, donc bloquer — la direction qui protège
             (`docs/23 §3.1`). */
          const lease = await deps.db.query<{ live: boolean }>(
            `SELECT COALESCE(lease_expires_at, 'infinity'::timestamptz) > now() AS live
               FROM tool_operations WHERE operation_id = $1`,
            [call.operationId],
          );
          if (!lease.ok) return lease;
          if (lease.value.rows[0]?.live === true) return inFlight(call, def.id);
        }
        /* Le repreneur doit d'abord PRENDRE le bail (ADR-035). Deux repreneurs
           simultanés lisent la même génération ; un seul l'incrémente. Le
           perdant apprend qu'il est arrivé trop tard, au lieu d'écraser le
           verdict du premier. */
        const claimed = await claimForRecovery(call.operationId, prior.lease_generation);
        if (!claimed.ok) return claimed;
        if (claimed.value === null) return inFlight(call, def.id);

        return await resumeUncertain(
          call, tool, prior, digest, policy, replayContext, claimed.value,
        );
      }

      /* --- 3d. Aucun appel n'a jamais été lancé : on peut tenter -------- */
      if (NEVER_CALLED.has(prior.state)) {
        if (prior.state === 'COMMITTED_TO_EXECUTION') {
          /* ÉCRITURE PRÉ-BAIL — la seconde des deux, et la classification
             compte autant que le code.

             Arrêt entre les deux barrières : la décision était durable, l'appel
             n'est jamais parti. On ramène à `PLANNED` par compare-and-swap.

             Pourquoi le cloisonnement ne s'applique PAS ici : à cet instant
             aucun bail n'a jamais été frappé pour cette opération, donc aucune
             génération ne peut faire autorité. Ce qui tient lieu de garde est
             le LITTÉRAL `state = 'COMMITTED_TO_EXECUTION'` — un état d'où, par
             construction (§4), aucun effet externe n'est possible.

             Un exécutant périmé ne peut donc pas emprunter ce chemin : son
             opération est en `EXECUTING` ou au-delà, et la clause l'exclut.
             I17 vérifie mécaniquement que ce littéral ne disparaît pas. */
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
          // Même raison qu'au-dessus : rejeu, donc aucune observation neuve.
          resource: null,
          provenance: def.outputProvenance,
          suspectedInjection: false,
        });
      }
    }

    /* --- 3e-bis. L'ARRÊT D'URGENCE — `docs/05 §C2`, ADR-057 ---------------
       PLACÉ ICI POUR LA RAISON EXACTE DE 3f, CI-DESSOUS : tout ce qui précède
       est de l'OBSERVATION — relire une opération, constater une reprise,
       rendre un verdict déjà écrit. Après un arrêt d'urgence on a PLUS besoin
       de comprendre, pas moins. Bloquer plus haut rendrait l'arrêt
       indiagnosticable.

       CE QUE L'ARRÊT BLOQUE — et l'arbitrage est plus large que la lettre.
       `docs/05` dit « actions **externes** bloquées ». S'en tenir là
       laisserait Jarvis écrire dans la mémoire de l'utilisateur après qu'il a
       dit « stop », ce qui contredit l'intention de la phrase. On bloque donc
       tout ce qui n'est pas une **lecture locale** : `L1` ET `networkRequired
       === false`. `audit_query`, `system_status` et `egress_review` restent
       disponibles — ce sont précisément les outils dont on a besoin après
       avoir appuyé sur le bouton.

       LE VERROU EST LU, JAMAIS REÇU. Comme `egress` (ADR-052), l'état d'arrêt
       est établi ici par une lecture de la base, pas fourni dans
       `call.context` : sinon il suffirait de mentir sur un champ pour
       traverser l'arrêt d'urgence. */
    const lectureLocale = def.autonomy === 'L1' && !def.networkRequired;
    if (!lectureLocale) {
      const halt = await haltState.state();
      /* AUCUN REPLI SUR « PAS ARRÊTÉ ». Si la base ne répond pas, on ignore
         s'il y a un arrêt actif — et une panne de lecture ne peut pas valoir
         autorisation d'agir. La sécurité gagne (CLAUDE.md). */
      if (!halt.ok) {
        return err(
          jarvisError(
            'POLICY_DENIED',
            'État d’arrêt d’urgence illisible : aucune action engagée tant ' +
              `qu’on ne sait pas si Jarvis est arrêté (${halt.error.message}).`,
            { tool: def.id },
          ),
        );
      }
      if (halt.value.halted) {
        await deps.ledger.append({
          actor: call.actor,
          eventType: `${def.auditEvent}_HALTED`,
          tool: def.id,
          policyDecision: 'DENY',
          autonomyLevel: def.autonomy,
          status: 'FAILED',
          operationId: call.operationId,
          payloadDigest: digest,
        });
        return err(
          jarvisError(
            'POLICY_DENIED',
            `Arrêt d’urgence actif depuis ${halt.value.since ?? 'un instant inconnu'} ` +
              `(${halt.value.reason ?? 'motif non enregistré'}). Aucune action ` +
              'nouvelle. Les lectures locales restent disponibles.',
            { tool: def.id },
          ),
        );
      }
    }

    /* --- 3f. LA CONFIANCE DANS LA SOURCE — `docs/22 §9`, invariant I12 ---
       « N'engager aucune action nouvelle sur une information compromise. »

       PLACÉ ICI, ET NULLE PART AILLEURS. Tout ce qui précède est de
       l'OBSERVATION — relire l'état d'une opération existante, constater une
       reprise, rendre un verdict déjà écrit. Bloquer là-haut empêcherait de
       LIRE ce qui s'est passé, ce qui est exactement l'inverse du but : après
       une rupture de confiance, on a plus besoin de comprendre, pas moins.

       Ce qui commence à la ligne suivante, en revanche, est une ACTION
       NOUVELLE. C'est elle qu'on refuse.

       Ce que ce refus N'EST PAS : une punition du fournisseur, ni une
       affirmation sur l'action refusée. Rien n'a été tenté, et on le dit.

       L'INTENTION RESTE INSCRITE, en `PLANNED`, `attempts = 0`, sans verdict.
       C'est délibéré : elle a bien existé, et si la confiance est un jour
       rétablie, l'opération repart de là plutôt que d'être perdue. L'état
       porte la preuve qu'aucune barrière de durabilité n'a été franchie. */
    /* LA QUESTION SE POSE AU JOURNAL, PAS AU REGISTRE — et c'est un test qui
       me l'a appris. Le registre ne garde que le DERNIER état d'une
       opération ; or une violation est constatée lors d'une RELECTURE, et le
       chemin de rejeu ne réécrit pas `tool_operations` (ADR-025 : action et
       observation ne se confondent pas).

       Le journal, lui, est append-only et chaîné. C'est là qu'une rupture de
       confiance est inscrite, et c'est donc là qu'il faut la chercher — une
       garde qui interroge une source effaçable n'est pas une garde. */
    const trust = await deps.db.query<{
      operation_id: string | null;
      event_type: string;
      status: string;
    }>(
      /* LE DERNIER MOT SUR LA CONFIANCE, quel qu'il soit. On ne cherche pas
         « existe-t-il une violation ? » mais « où en est-on ? » — sinon un
         rétablissement légitime resterait sans effet et la rupture serait
         définitive. */
      `SELECT operation_id, event_type, status FROM event_ledger
        WHERE tool = $1
          AND (status = 'PROVIDER_CONTRACT_VIOLATION'
               OR event_type LIKE '%\\_TRUST\\_RESTORED')
        ORDER BY seq DESC LIMIT 1`,
      [def.id],
    );
    if (!trust.ok) return trust;
    const dernier = trust.value.rows[0];
    const breach =
      dernier !== undefined && dernier.status === 'PROVIDER_CONTRACT_VIOLATION'
        ? dernier
        : undefined;
    if (breach !== undefined) {
      await deps.ledger.append({
        actor: call.actor,
        eventType: `${def.auditEvent}_TRUST_BLOCKED`,
        tool: def.id,
        policyDecision: 'ALLOW',
        autonomyLevel: policy.effectiveAutonomy,
        // Rien n'a été tenté : ce n'est ni un échec ni une ignorance sur le
        // monde, c'est une abstention délibérée.
        status: 'NOT_ATTEMPTED',
        operationId: call.operationId,
        payloadDigest: digest,
      });
      return err(
        jarvisError(
          'PROVIDER_TRUST_REVOKED',
          `${def.id} a rompu son contrat lors d'une opération antérieure ` +
            `(${breach.operation_id ?? 'clé inconnue'}). Je n'engage plus rien par ce service : ` +
            "il a répondu autre chose que ce qu'il annonce, et je ne peux plus " +
            "interpréter ses réponses. Rien n'a été tenté.",
          { tool: def.id, operation: call.operationId },
        ),
      );
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
       à un redémarrage.

       ÉCRITURE PRÉ-BAIL — la première des deux (ADR-035).
       Aucune génération ne peut la garder : c'est justement l'écriture qui
       rend la frappe du bail possible. Le littéral `state = 'PLANNED'` en tient
       lieu, et il est de la même famille que l'autre : un état d'où aucun effet
       externe n'est possible. */
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

    /* PRISE DE BAIL — ADR-035.
       Le passage à `EXECUTING` frappe la génération qui autorisera, plus tard,
       l'écriture du résultat. Un exécutant qui perdrait le bail pendant son
       appel se verra refuser cette écriture plutôt que d'écraser celle du
       repreneur. */
    const acquired = await acquireLease(
      call.operationId,
      def.timeoutMs + LEASE_MARGIN_MS,
    );
    if (!acquired.ok) return acquired;
    if (acquired.value === null) return inFlight(call, def.id);
    const lease = acquired.value;

    /* --- 4 ter. LA REQUÊTE ELLE-MÊME EST JOURNALISÉE — `docs/22 §10` ----
       L'invariant I13 exige une chaîne de provenance complète :

         T0 INTENTION · T1 OPERATION_PLANNED · T2 REQUEST_CREATED
         T3 REQUEST_SENT · T4..T6 · T7 OUTCOME

       Le document relevait le trou nommément : « le Gateway ne journalise pas
       l'appel lui-même ». Le registre savait qu'une opération était passée en
       `EXECUTING` ; le JOURNAL, lui, ne portait aucune trace entre la décision
       et son issue.

       La différence n'est pas cosmétique. Le registre est mutable et ne garde
       que le dernier état ; le journal est append-only et chaîné. Sans cet
       événement, à la question « pourquoi refuses-tu de recommencer ? », la
       seule réponse lisible était un état terminal — jamais le fait qu'un
       appel soit RÉELLEMENT PARTI, ni sous quelle génération de bail.

       Émis APRÈS la prise de bail et AVANT l'appel : c'est le seul instant où
       « la requête part maintenant » est vrai. */
    const requestEvent = await deps.ledger.append({
      actor: call.actor,
      eventType: `${def.auditEvent}_REQUEST_SENT`,
      tool: def.id,
      policyDecision: 'ALLOW',
      autonomyLevel: policy.effectiveAutonomy,
      /* Rien n'est encore observé. `NOT_ATTEMPTED` serait faux — l'appel PART.
         `UNKNOWN` est exact : à cet instant, l'issue est inconnue, et c'est
         précisément l'information que cet événement conserve. */
      status: 'UNKNOWN',
      operationId: call.operationId,
      payloadDigest: digest,
    });
    if (!requestEvent.ok) return requestEvent;

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
        executed.error.kind === 'TIMEOUT' || isExternalEffect(def.effect)
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

      const wroteFailure = await writeAuthoritative(
        lease,
        `state = $2, status = $3, observed_at = clock_timestamp(),
         recovery_detail = $4, lease_expires_at = NULL`,
        [
          terminal,
          terminal === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
          `${cause} — ${executed.error.message}`.slice(0, 500),
        ],
      );
      /* LE SECOND CHEMIN PARALLÈLE TROUVÉ PAR L'AUDIT DE F5.1.
         Le registre était cloisonné, le JOURNAL ne l'était pas : un exécutant
         périmé y inscrivait tout de même `…_FAILED`, et `/audit` lisait une
         histoire contradictoire avec l'état.

         On n'efface pas l'événement pour autant — l'appel de A a bel et bien
         eu lieu, et c'est peut-être la seule trace qu'une requête est partie
         vers le monde. On le MARQUE, et son statut retombe à `UNKNOWN` :
         périmé, A n'a plus d'opinion recevable sur l'issue. */
      const staleFailure = wroteFailure.ok && !wroteFailure.value;
      await deps.ledger.append({
        actor: call.actor,
        eventType: `${def.auditEvent}${staleFailure ? '_STALE' : '_FAILED'}`,
        tool: def.id,
        policyDecision: 'ALLOW',
        autonomyLevel: policy.effectiveAutonomy,
        // Le journal dit la même chose que le registre : ni plus affirmatif,
        // ni moins. Deux sources qui divergent, c'est une source de moins.
        status:
          staleFailure || terminal === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED',
        operationId: call.operationId,
        payloadDigest: digest,
      });
      if (staleFailure) return staleExecutor(call, def.id, lease);
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
    const recorded = await writeAuthoritative(
      lease,
      `state = $2, status = $3, resource_kind = $4, resource_id = $5,
       observed_at = clock_timestamp(), lease_expires_at = NULL`,
      [
        verification.status === 'FAILED' ? 'FAILED'
          : verification.status === 'UNKNOWN' ? 'UNKNOWN'
          : 'SUCCEEDED',
        verification.status,
        resource?.kind ?? null,
        resource?.id ?? null,
      ],
    );
    if (!recorded.ok) return recorded;
    if (!recorded.value) {
      /* A a exécuté, obtenu un reçu, et peut-être produit un effet dans le
         monde. Son VERDICT n'a plus d'autorité — mais faire disparaître son
         exécution du journal serait la pire des deux options : ce serait
         effacer la seule trace qu'une requête est partie.

         Statut `UNKNOWN`, jamais celui que A avait vérifié : sa vérification
         portait sur un monde dont un autre exécutant a peut-être depuis
         changé la lecture. */
      await deps.ledger.append({
        actor: call.actor,
        eventType: `${def.auditEvent}_STALE`,
        tool: def.id,
        policyDecision: 'ALLOW',
        autonomyLevel: policy.effectiveAutonomy,
        status: 'UNKNOWN',
        operationId: call.operationId,
        payloadDigest: digest,
      });
      return staleExecutor(call, def.id, lease);
    }

    /* --- 7-bis. SCELLEMENT DU CONTENU EXTERNE — ADR-004, ADR-055 ---------
       Le point où la séparation Privileged/Quarantined cesse d'être hors
       circuit. `docs/26 §4.1` recensait `quarantine/processor.ts` comme
       « implémenté, testé, JAMAIS APPELÉ ». Il est appelé ici.

       L'étiquetage vient du CONTRAT, pas de l'exécution : une valeur
       potentiellement hostile ne choisit pas sa propre étiquette. Un outil
       qui rend du contenu de tiers l'a déclaré à l'enregistrement, et le
       validateur lui interdit par ailleurs de muter (contract.ts). */
    const sealed =
      def.outputProvenance === 'EXTERNAL_UNTRUSTED'
        ? sealExternal(executed.value.output, def.id)
        : null;

    /* Une tentative d'instruction dans du contenu rapporté est un FAIT à
       journaliser, pas une alarme à lever : l'étiquette protège déjà. Sans
       cette ligne, `audit_query` ne pourrait jamais répondre à « quelqu'un
       a-t-il essayé ? » — et c'est la question que B1 et B3 posent. */
    if (sealed?.suspectedInjection === true) {
      await deps.ledger.append({
        actor: call.actor,
        eventType: `${def.auditEvent}_INJECTION_SUSPECTED`,
        tool: def.id,
        policyDecision: 'ALLOW',
        autonomyLevel: policy.effectiveAutonomy,
        status: verification.status,
        operationId: call.operationId,
        payloadDigest: digest,
      });
    }

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
      /* CE QUI EST PARTI — enregistré au moment où ça part, jamais déduit
         après coup.

         Déduire l'égression d'un `networkRequired` relu plus tard serait le
         motif « l'observateur redéfinit le passé » appliqué à l'audit :
         ce champ dépend désormais du fournisseur branché (ADR-051), donc un
         rebranchement réécrirait l'histoire.

         La destination vient de l'OUTIL, seul à connaître son fournisseur ;
         le niveau et la raison viennent de la décision qui vient d'être
         prise. */
      egress:
        def.networkRequired && executed.value.egress !== undefined
          ? {
              destination: executed.value.egress.destination,
              dataLevel: floorFor(def.dataCategory),
              reason: policy.reasons.join(' ') || 'sortie autorisée par la politique',
            }
          : null,
    });
    if (!event.ok) return event;

    return ok({
      status: verification.status,
      output: executed.value.output,
      verification,
      policy,
      eventId: event.value.eventId,
      replayed: false,
      resource: executed.value.resource ?? null,
      provenance: def.outputProvenance,
      suspectedInjection: sealed?.suspectedInjection ?? false,
    });
  }
}
