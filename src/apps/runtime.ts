/**
 * Runtime applicatif — l'assemblage commun à toutes les interfaces.
 *
 * Référence : 02 Étape C, ADR-023.
 *
 * POURQUOI CE MODULE EXISTE
 * -------------------------
 * Le CLI et le serveur web doivent charger **exactement** le même noyau : mêmes
 * politiques, même Policy Gate, même Memory Guard, même journal. Dupliquer cet
 * assemblage, c'est accepter qu'un jour l'une des deux interfaces oublie une
 * pièce — et une pièce oubliée ici est une barrière de sécurité en moins.
 *
 * Une interface n'assemble rien. Elle reçoit un runtime et l'affiche.
 */
import { join } from 'node:path';
import { loadConfig } from '../core/config/load.js';
import { createDb, type Db, type DbHealth } from '../core/db/client.js';
import { createLedger, type Ledger } from '../core/ledger/ledger.js';
import { digestPayload } from '../core/ledger/event.js';
import { createPolicyGate } from '../core/policy/gate.js';
import { createMemoryGuard } from '../core/memory/guard.js';
import { createMemoryInbox, type MemoryInbox } from '../core/memory/inbox.js';
import { createMemoryStore } from '../core/memory/store.js';
import { createHybridSearch } from '../core/memory/search.js';
import { createSessionStore, type SessionStore } from '../core/session/session.js';
import { createEntityResolver } from '../core/context/resolver.js';
import { createResolveurTemporel } from '../core/temps/resolution.js';
import { createIntentEngine, type IntentEngine } from '../core/intent/engine.js';
import { createEnvSecretVault } from '../core/secrets/vault.js';
import { createOllama } from '../providers/ollama/model.js';
import { createTier1, type Tier1 } from '../core/intent/tier1.js';
import {
  createGoogleAgenda,
  googleAgendaConfigure,
} from '../providers/google/calendar.js';
import { createToolGateway, type ToolGateway } from '../core/tools/gateway.js';
import { createVerificationEngine } from '../core/verification/engine.js';
import { createUndoEngine, type UndoEngine } from '../core/undo/engine.js';
import { createSnapshotStore } from '../core/undo/snapshots.js';
import { createAssistant, type Assistant } from '../core/assistant.js';
import { createCedarEvaluator, loadPolicySource } from '../providers/policy/cedar.js';
import { registerCoreTools } from '../tools/index.js';
import { err, ok, jarvisError, type Result } from '../core/types/result.js';

export interface Runtime {
  readonly db: Db;
  /** État courant de la base. Affiché par `/diagnostic` (CRIT-1). */
  health(): DbHealth;
  readonly gateway: ToolGateway;
  readonly ledger: Ledger;
  readonly inbox: MemoryInbox;
  readonly sessions: SessionStore;
  readonly intent: IntentEngine;
  readonly assistant: Assistant;
  /**
   * « Annule la dernière action. » — `docs/09 §2.1`, ADR-066.
   *
   * Exposé au runtime plutôt que gardé dans le noyau : un moteur d'annulation
   * qu'aucune surface n'atteint est un module hors circuit, c'est-à-dire
   * exactement la dette que ce commit vient de payer ailleurs.
   */
  readonly undo: UndoEngine;
  /** Aucun fournisseur d'embeddings n'est câblé aujourd'hui — dit, pas masqué. */
  readonly embeddingsAvailable: boolean;
  readonly cloudEnabled: boolean;
  setUserConfirmed(value: boolean): void;
  close(): Promise<void>;
}

export function buildRuntime(
  db: Db,
  options: {
    policyDir?: string;
    /**
     * L'INTERRUPTEUR CLOUD DE L'UTILISATEUR — S13, ADR-069.
     *
     * Défaut `false`, comme `config/default.json`. Ce qui change avec ADR-069
     * n'est pas le défaut : c'est que la clé de configuration soit désormais
     * LUE. Elle ne l'était pas — la protection tenait par un littéral.
     */
    cloudEnabled?: boolean;
    /**
     * LE MODÈLE LOCAL — ADR-082.
     *
     * Absent = pas de `Tier 1`, et c'est le défaut. La compréhension étendue
     * est une OPTION ; Jarvis fonctionne sans (I1, I2).
     */
    localModel?: { enabled: boolean; url: string; model: string };
  } = {},
): Result<Runtime> {
  const source = loadPolicySource(options.policyDir ?? join(process.cwd(), 'policies'));
  if (!source.ok) return source;

  const store = createMemoryStore(db);
  const inbox = createMemoryInbox(db);
  const ledger = createLedger(db);

  const vault = createEnvSecretVault();

  const gateway = createToolGateway({
    db,
    gate: createPolicyGate(createCedarEvaluator(source.value)),
    vault,
    ledger,
    verifier: createVerificationEngine(),
  });

  // La confirmation utilisateur est une propriété de la CONVERSATION : elle est
  // pilotée par la boucle, jamais devinée par un outil.
  let userConfirmed = false;
  const setUserConfirmed = (value: boolean): void => {
    userConfirmed = value;
  };

  const registered = registerCoreTools(gateway, {
    guard: createMemoryGuard(store, inbox),
    store,
    // Aucun fournisseur d'embeddings : la voie sémantique est indisponible, les
    // deux autres fonctionnent. C'est exactement le chemin « réseau coupé ».
    search: createHybridSearch(db, null),
    ledger,
    isUserConfirmed: () => userConfirmed,
    /* L'AGENDA NE S'ACTIVE QUE SI LE COFFRE PORTE DE QUOI SE CONNECTER — ADR-078.

       `null` est un état NORMAL et déclaré, pas une panne : les outils
       s'enregistrent quand même et rendent `PROVIDER_UNAVAILABLE`, ce qui est
       une réponse. L'alternative — les retirer du catalogue — ferait dire à
       Jarvis qu'il ne SAIT PAS accéder à un agenda, alors qu'il ne fait que ne
       pas en avoir un connecté. ADR-075 a montré ce que coûte cette confusion.

       Le fournisseur n'est donc PAS construit sans secrets : il ne ferait que
       découvrir leur absence à chaque appel. */
    calendar: googleAgendaConfigure(vault)
      ? createGoogleAgenda({ vault })
      : null,
  });
  if (!registered.ok) return registered;

  return ok({
    db,
    health: () => db.health(),
    gateway,
    ledger,
    inbox,
    sessions: createSessionStore(db),
    intent: createIntentEngine(),
    assistant: createAssistant({
      intent: createIntentEngine(),
      gateway,
      setGuardConfirmed: setUserConfirmed,
      cloudEnabled: options.cloudEnabled ?? false,
      // ADR-073 : la résolution de référents vit dans l'Assistant, pas dans le
      // moteur d'intention — `propose()` reste une fonction pure du texte.
      resolver: createEntityResolver(db),
      // ADR-077 : les dates sont calculées PAR LA BASE, jamais par le processus.
      temps: createResolveurTemporel(db),
      /* LE `TIER 1`, SI ET SEULEMENT SI UN MODÈLE LOCAL EST CONFIGURÉ — ADR-082.

         `null` reste un état NORMAL, et le défaut : `localModel.enabled` vaut
         `false` dans `config/default.json`. Jarvis fonctionne entièrement sans
         modèle (I1, I2) — il comprend moins de formulations, et le dit.

         ⚠ UN FOURNISSEUR QUI REFUSE DE SE CONSTRUIRE NE FAIT PAS ÉCHOUER LE
         DÉMARRAGE. Une adresse non locale est refusée par `createOllama`, et on
         retombe alors sur `null` : Jarvis démarre en `Tier 0`. Le contraire —
         un refus de démarrer — punirait l'utilisateur d'une option qu'il peut
         corriger, et le laisserait sans assistant du tout. */
      tier1: tier1Configure(options.localModel, gateway),
    }),
    undo: createUndoEngine({ snapshots: createSnapshotStore(db), gateway }),
    embeddingsAvailable: false,
    cloudEnabled: options.cloudEnabled ?? false,
    setUserConfirmed,
    close: () => db.close(),
  });
}

/** Charge la configuration, ouvre la base, assemble le noyau. */
export function openRuntime(
  options: { onHealthChange?: (health: DbHealth) => void } = {},
): Result<Runtime> {
  const config = loadConfig();
  if (!config.ok) return config;

  // Le journal n'existe pas encore quand la base est ouverte : on retient donc
  // l'écouteur dans un porteur mutable, et on le branche une fois le noyau
  // assemblé.
  const sink: { notify?: (health: DbHealth) => void } = {};

  const db = createDb({
    host: config.value.public.database.host,
    port: config.value.public.database.port,
    database: config.value.public.database.name,
    user: config.value.public.database.user,
    password: config.value.secret.databasePassword,
    poolMax: config.value.public.database.poolMax,
    statementTimeoutMs: config.value.public.database.statementTimeoutMs,
    onHealthChange: (health: DbHealth) => {
      options.onHealthChange?.(health);
      sink.notify?.(health);
    },
  });

  /* LA CLÉ DE CONFIGURATION EST ENFIN LUE — S13, ADR-069.
     `loadConfig()` était appelé pour la base et la politique ; `cloud.enabled`
     n'en sortait jamais. Une clé déclarée que rien ne consulte est la famille
     de défaut que `docs/26 §2` recense huit fois. */
  const runtime = buildRuntime(db, {
    cloudEnabled: config.value.public.cloud.enabled,
    localModel: config.value.public.localModel,
  });
  if (!runtime.ok) {
    void db.close();
    return err(
      jarvisError('CONFIGURATION', runtime.error.message, undefined, runtime.error),
    );
  }

  /* Le retour à la normale est un ÉVÉNEMENT, pas un silence.
     On ne peut évidemment rien écrire pendant la panne — la base est
     injoignable. Mais dès qu'elle revient, l'incident doit laisser une trace :
     sans elle, `/audit` présenterait un trou inexplicable dans la journée. */
  const ledger = runtime.value.ledger;
  sink.notify = (health: DbHealth) => {
    if (health.state !== 'UP') return;
    void ledger
      .append({
        actor: 'SYSTEM',
        eventType: 'DATABASE_RECOVERED',
        status: 'CONFIRMED',
        payloadDigest: digestPayload({ recoveredAt: health.since }),
      })
      .catch(() => undefined);
  };

  return runtime;
}

/**
 * Construit le `Tier 1` si la configuration le demande, `null` sinon.
 *
 * Le refus est SILENCIEUX côté démarrage mais pas invisible : `system_status`
 * interroge la santé des fournisseurs, et `createOllama` explique pourquoi il
 * a refusé. Un démarrage qui échoue sur une option de compréhension serait
 * disproportionné ; un refus muet serait malhonnête. On prend la troisième
 * voie : démarrer sans, et pouvoir le dire.
 */
function tier1Configure(
  localModel: { enabled: boolean; url: string; model: string } | undefined,
  gateway: ToolGateway,
): Tier1 | null {
  if (localModel === undefined || !localModel.enabled) return null;
  const modele = createOllama({ url: localModel.url, model: localModel.model });
  if (!modele.ok) return null;
  /* Le catalogue est passé en FONCTION, relu à chaque appel : un outil retiré
     pour perte de confiance (I12) cesse aussitôt d'être proposable. */
  return createTier1({ model: modele.value, outils: () => gateway.list() });
}
