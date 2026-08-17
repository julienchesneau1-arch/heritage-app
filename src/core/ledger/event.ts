/**
 * Schéma d'un événement du journal.
 *
 * Le journal ne porte jamais le contenu métier, seulement son empreinte. C'est
 * ce qui permet à `03 §12` d'exiger qu'une suppression de mémoire laisse une
 * trace d'audit sans conserver la donnée supprimée.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Actor, AutonomyLevel, DataLevel, VerificationStatus } from '../types/domain.js';

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
  /**
   * CE QUI EST PARTI DE LA MACHINE — `docs/05 §C4`, ADR-052.
   *
   * Absent quand rien n'est sorti, ce qui est le cas ordinaire. Présent, il
   * porte les trois faits que C4 exige : **destination, classe, raison**.
   */
  egress: z
    .object({
      /** Identifiant du fournisseur. Jamais une URL (`docs/03 §12`). */
      destination: z.string().min(1),
      /** Le niveau `docs/14` AU MOMENT de la décision, pas recalculé après. */
      dataLevel: DataLevel,
      /** Ce que le Policy Gate a répondu, en clair. */
      reason: z.string().min(1),
    })
    .nullable()
    .default(null),
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
  event: Omit<NewEvent, 'egress'> &
    Partial<Pick<NewEvent, 'egress'>> & { eventId: string; occurredAt: string },
  prevHash: string,
): string {
  const fields: string[] = [
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

  /* L'ÉGRESSION EST AJOUTÉE EN QUEUE, ET SEULEMENT SI ELLE EXISTE.

     Insérer trois positions dans la liste changerait le hachage de TOUTES les
     lignes déjà écrites : leur vérification échouerait, et le seul mécanisme
     de preuve du dépôt deviendrait faux au moment précis où on en ajoute un.

     En queue et conditionnel, une ligne sans égression produit une liste
     byte-identique à l'ancienne — donc le même hachage, donc une chaîne
     intacte. Une ligne avec égression étend la liste, donc les trois faits
     sont couverts comme le reste.

     Le prix est que la POSITION cesse d'être fixe. C'est acceptable ici parce
     que `JSON.stringify` d'un tableau reste non ambigu : deux listes de
     longueurs différentes ne peuvent pas produire la même sérialisation. */
  if (event.egress !== null && event.egress !== undefined) {
    fields.push(
      event.egress.destination,
      event.egress.dataLevel,
      event.egress.reason,
    );
  }

  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function newEventId(): string {
  return randomUUID();
}
