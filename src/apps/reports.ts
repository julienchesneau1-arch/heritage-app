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

export async function auditReport(runtime: Runtime): Promise<Result<AuditReport>> {
  const recent = await runtime.ledger.recent(200);
  if (!recent.ok) return recent;

  const day = new Date().toISOString().slice(0, 10);
  const today = recent.value.filter((e) => e.occurredAt.startsWith(day));

  const counts = new Map<string, AuditEntry>();
  for (const event of today) {
    const key = `${event.eventType}${event.status}`;
    const existing = counts.get(key);
    counts.set(
      key,
      existing === undefined
        ? { type: event.eventType, status: event.status, count: 1 }
        : { ...existing, count: existing.count + 1 },
    );
  }

  const chain = await runtime.ledger.verifyChain();
  const events = [...counts.values()].sort((a, b) =>
    `${a.type}${a.status}`.localeCompare(`${b.type}${b.status}`),
  );

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
}

export async function inboxReport(runtime: Runtime): Promise<Result<InboxReport>> {
  const pending = await runtime.inbox.pending();
  if (!pending.ok) return pending;
  return ok({
    candidates: pending.value.map((c) => ({
      content: c.content,
      memoryType: c.memoryType,
      sourceType: c.sourceType,
      confidence: c.suggestedConfidence,
    })),
  });
}

export interface DiagnosticReport {
  readonly tools: number;
  readonly chainValid: boolean;
  readonly chainLength: number;
  readonly pending: number;
  readonly embeddings: boolean;
  readonly cloud: boolean;
}

export async function diagnosticReport(
  runtime: Runtime,
): Promise<Result<DiagnosticReport>> {
  const chain = await runtime.ledger.verifyChain();
  if (!chain.ok) return chain;
  const pending = await runtime.inbox.pending(1000);
  if (!pending.ok) return pending;

  return ok({
    tools: runtime.gateway.list().length,
    chainValid: chain.value.valid,
    chainLength: chain.value.checked,
    pending: pending.value.length,
    embeddings: runtime.embeddingsAvailable,
    cloud: runtime.cloudEnabled,
  });
}
