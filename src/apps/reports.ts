/**
 * Rapports — audit, inbox, diagnostic.
 *
 * Référence : 05/A9 (« Qu'as-tu fait aujourd'hui ? »), 03 §9.
 *
 * Ces trois réponses viennent du JOURNAL et de l'état réel, jamais d'une
 * reconstruction ni d'un modèle. Elles sont calculées ici, une seule fois, pour
 * que le CLI et le serveur web ne puissent pas diverger sur ce que Jarvis
 * prétend avoir fait.
 *
 * Le module produit des DONNÉES. Le rendu appartient à l'interface.
 */
import type { Runtime } from './runtime.js';
import type { Result } from '../core/types/result.js';
import { ok } from '../core/types/result.js';

export interface AuditEntry {
  readonly type: string;
  readonly status: string;
  readonly count: number;
}

export interface AuditReport {
  readonly day: string;
  readonly events: readonly AuditEntry[];
  readonly chainValid: boolean;
  readonly chainLength: number;
  /** Renseigné uniquement si la chaîne est rompue. */
  readonly brokenAt?: string;
}

/**
 * « Qu'as-tu fait aujourd'hui ? » — et la réponse est COMPLÈTE. ADR-064.
 *
 * ⚠ CE RAPPORT ÉTAIT LE SECOND REGISTRE D'UN FAIT QUI EN AVAIT DÉJÀ UN.
 * L'outil `audit_query` répond à la même question en bornant par
 * `date_trunc('day', clock_timestamp())`. Ce rapport-ci, lui, lisait
 * `recent(200)` puis filtrait sur `new Date()`. Les deux ne pouvaient pas
 * s'accorder — et c'est CELUI-CI que le CLI et la passerelle web affichent.
 * **Le bon était celui que personne ne voyait.**
 *
 * ADR-041 l'avait écrit : *le jour où deux registres du même fait divergent,
 * aucun ne fait autorité.* Il n'y en a plus qu'un.
 */
export async function auditReport(runtime: Runtime): Promise<Result<AuditReport>> {
  const tally = await runtime.ledger.dayTally();
  if (!tally.ok) return tally;

  const chain = await runtime.ledger.verifyChain();
  const events: AuditEntry[] = tally.value.entries.map((e) => ({
    type: e.eventType,
    status: e.status,
    count: e.count,
  }));
  const day = tally.value.day;

  if (!chain.ok) return chain;
  const broken = chain.value.valid ? undefined : (chain.value.brokenAt?.reason ?? 'inconnu');

  return ok({
    day,
    events,
    chainValid: chain.value.valid,
    chainLength: chain.value.checked,
    ...(broken === undefined ? {} : { brokenAt: broken }),
  });
}

export interface InboxEntry {
  readonly content: string;
  readonly memoryType: string;
  readonly sourceType: string;
  readonly confidence: number;
}

export interface InboxReport {
  readonly candidates: readonly InboxEntry[];
  /**
   * COMBIEN il y en a en tout — pas combien cette liste en montre.
   *
   * Tronquer une LISTE est légitime ; ne pas le dire ne l'est pas. Sans ce
   * total, vingt candidats affichés sur cinquante se lisent comme cinquante.
   */
  readonly total: number;
}

export async function inboxReport(runtime: Runtime): Promise<Result<InboxReport>> {
  const pending = await runtime.inbox.pending();
  if (!pending.ok) return pending;
  const total = await runtime.inbox.pendingCount();
  if (!total.ok) return total;
  return ok({
    candidates: pending.value.map((c) => ({
      content: c.content,
      memoryType: c.memoryType,
      sourceType: c.sourceType,
      confidence: c.suggestedConfidence,
    })),
    total: total.value,
  });
}

export interface DiagnosticReport {
  readonly database: 'UP' | 'DOWN';
  readonly tools: number;
  readonly chainValid: boolean;
  readonly chainLength: number;
  readonly pending: number;
  readonly embeddings: boolean;
  readonly cloud: boolean;
  /**
   * LE MODÈLE LOCAL, EN UNE PHRASE — ADR-086.
   *
   * `/diagnostic` ne disait rien du modèle. Un Ollama éteint donnait donc
   * exactement le même diagnostic qu'une absence de modèle : « tout va bien »,
   * alors que la capacité que l'utilisateur venait d'installer ne répondait
   * pas. C'est la question qu'il se pose à ce moment précis.
   */
  readonly modeleLocal: string;
}

/** Rend l'état du modèle local en une phrase lisible — ADR-086. */
async function modeleLocalLisible(runtime: Runtime): Promise<string> {
  const etat = runtime.modeleLocal;
  if (etat.kind === 'DESACTIVE') return 'aucun (Tier 0 seul — c\'est le défaut)';
  if (etat.kind === 'REFUSE') return `REFUSÉ — ${etat.raison}`;

  /* On SONDE. Un booléen retenu au démarrage affirmerait « disponible » d'un
     serveur arrêté depuis : une réponse est une observation, pas une preuve
     durable (`docs/21`). */
  const id = etat.provider.capabilities.id;
  const sante = await etat.provider.health();
  if (!sante.ok) return `${id} — INJOIGNABLE : ${sante.error.message}`;
  if (!sante.value.available) {
    return `${id} — INDISPONIBLE : ${sante.value.detail ?? 'sans détail'}`;
  }
  return `${id} — répond`;
}

export async function diagnosticReport(
  runtime: Runtime,
): Promise<Result<DiagnosticReport>> {
  const chain = await runtime.ledger.verifyChain();
  if (!chain.ok) return chain;
  /* UN DÉCOMPTE, PAS UNE LECTURE PLAFONNÉE. C'était `pending(1000).length` :
     au-delà de mille candidats, le diagnostic aurait répondu « 1000 » sans le
     dire. Un plafond de lecture rendu comme un compte. */
  const pending = await runtime.inbox.pendingCount();
  if (!pending.ok) return pending;

  return ok({
    database: runtime.health().state,
    tools: runtime.gateway.list().length,
    chainValid: chain.value.valid,
    chainLength: chain.value.checked,
    pending: pending.value,
    embeddings: runtime.embeddingsAvailable,
    cloud: runtime.cloudEnabled,
    modeleLocal: await modeleLocalLisible(runtime),
  });
}
