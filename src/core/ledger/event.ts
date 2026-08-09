/**
 * Schéma d'un événement du journal.
 *
 * Le journal ne porte jamais le contenu métier, seulement son empreinte. C'est
 * ce qui permet à `03 §12` d'exiger qu'une suppression de mémoire laisse une
 * trace d'audit sans conserver la donnée supprimée.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Actor, AutonomyLevel, VerificationStatus } from '../types/domain.js';

export const GENESIS_HASH = '0'.repeat(64);

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 attendue');

export const PolicyDecision = z.enum(['ALLOW', 'DENY', 'CONFIRM']);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/** Ce que l'appelant fournit. Le chaînage est ajouté par le journal lui-même. */
export const NewEvent = z.object({
  actor: Actor,
  eventType: z.string().min(1),
  intent: z.string().nullable().default(null),
  tool: z.string().nullable().default(null),
  policyDecision: PolicyDecision.nullable().default(null),
  autonomyLevel: AutonomyLevel.nullable().default(null),
  status: VerificationStatus,
  proof: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  costEur: z.number().min(0).default(0),
  operationId: z.string().nullable().default(null),
  payloadDigest: Sha256Hex,
});
export type NewEvent = z.infer<typeof NewEvent>;

/** Un événement scellé, tel qu'il est écrit puis relu. */
export const SealedEvent = NewEvent.extend({
  eventId: z.uuid(),
  occurredAt: z.string(),
  prevHash: Sha256Hex,
  hash: Sha256Hex,
});
export type SealedEvent = z.infer<typeof SealedEvent>;

/**
 * Empreinte d'une charge utile.
 *
 * À utiliser systématiquement au lieu de stocker la charge : le journal doit
 * pouvoir prouver qu'un contenu était celui-là sans le conserver.
 */
export function digestPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload) ?? 'null').digest('hex');
}

/**
 * Calcul du hash de chaînage.
 *
 * L'encodage passe par `JSON.stringify` d'un tableau de chaînes : l'échappement
 * JSON rend la sérialisation non ambiguë, y compris si un champ contient le
 * séparateur. Un encodage naïf par concaténation permettrait de forger deux
 * événements distincts partageant le même hash.
 *
 * `seq` est volontairement exclu : il est attribué par la base à l'insertion,
 * alors que le hash doit être calculable avant. L'ordre de la chaîne est porté
 * par `prevHash`, pas par le numéro de séquence.
 */
export function computeHash(
  event: NewEvent & { eventId: string; occurredAt: string },
  prevHash: string,
): string {
  const fields: readonly string[] = [
    event.eventId,
    event.occurredAt,
    event.actor,
    event.eventType,
    event.intent ?? '',
    event.tool ?? '',
    event.policyDecision ?? '',
    event.autonomyLevel ?? '',
    event.status,
    event.proof ?? '',
    event.model ?? '',
    event.costEur.toFixed(6),
    event.operationId ?? '',
    event.payloadDigest,
    prevHash,
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function newEventId(): string {
  return randomUUID();
}
