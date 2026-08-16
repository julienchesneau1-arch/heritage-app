/**
 * LES ÉCHÉANCES PERSISTÉES — dérive de l'horloge du processus.
 *
 * Trouvé par le balayage « zones d'ombre », en cherchant une cinquième
 * occurrence du motif qui a déjà frappé quatre fois. Ce n'est pas le même
 * motif — c'est son VOISIN, et il était resté invisible pour cette raison.
 *
 *   ADR-036  l'observateur RECALCULE une échéance qu'il n'a pas fixée
 *   ici      l'échéance est bien fixée une fois — mais par L'HORLOGE DU
 *            PROCESSUS, puis comparée à celle de LA BASE
 *
 * `docs/23 §4` avait établi la propriété pour le bail :
 *
 *   > le verdict de bail est indépendant de l'horloge du processus (I14)
 *
 * Elle ne valait QUE pour le bail. Deux autres tables portent des échéances,
 * et personne n'avait regardé :
 *
 *   action_snapshots.expires_at    la rétention d'un état antérieur
 *   memory_candidates.expires_at   la péremption d'une proposition
 *
 * CE QUE ÇA COÛTE, et pourquoi ce n'est pas cosmétique : `action_snapshots`
 * conserve l'ÉTAT ANTÉRIEUR d'une ressource, classé jusqu'à `ORANGE`. Une
 * échéance trop lointaine est une violation de rétention (`docs/14`), pas une
 * gêne d'exploitation.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { labDb, labKey } from './harness.js';
import { createSnapshotStore } from '../../src/core/undo/snapshots.js';
import { createMemoryInbox } from '../../src/core/memory/inbox.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

/** Décale l'horloge APPLICATIVE, jamais celle de la base. */
function withProcessClockShift<T>(shiftMs: number, run: () => Promise<T>): Promise<T> {
  const real = Date.now.bind(Date);
  Date.now = () => real() + shiftMs;
  return run().finally(() => {
    Date.now = real;
  });
}

const ONE_YEAR_MS = 365 * 24 * 3_600 * 1_000;

describe.runIf(enabled)('échéances persistées — dérive du processus', () => {
  let db: Db;

  beforeAll(() => {
    db = labDb(10);
  });

  afterAll(async () => {
    await db.close();
  });

  afterEach(async () => {
    await db.query("DELETE FROM action_snapshots WHERE operation_id LIKE 'deadline-%'");
    await db.query("DELETE FROM memory_candidates WHERE content LIKE 'sonde d''échéance%'");
  });

  /* ================================================================== *
   * action_snapshots — la rétention d'un état antérieur
   * ================================================================== */

  it(
    "l'échéance d'un instantané est indépendante de l'horloge du processus",
    async () => {
      const snapshots = createSnapshotStore(db);
      const key = `deadline-${String(labKey('snap'))}`;

      /* On décale l'horloge du processus d'un AN vers l'avant. Si l'échéance
         est frappée par le processus, l'instantané survivra un an de trop —
         et un état antérieur classé ORANGE avec lui. */
      const captured = await withProcessClockShift(ONE_YEAR_MS, () =>
        snapshots.capture({
          operationId: key,
          resourceKind: 'note',
          resourceId: 'sonde',
          undoKind: 'STATE_RESTORE',
          priorState: { contenu: 'avant' },
          privacyClass: 'ORANGE',
        }),
      );
      expect(captured.ok).toBe(true);

      /* LA PROPRIÉTÉ : l'échéance est décidée par la base. Un an de dérive
         applicative ne doit pas la déplacer d'un jour. */
      const measured = await db.query<{ jours: number }>(
        `SELECT EXTRACT(DAY FROM (expires_at - clock_timestamp()))::int AS jours
           FROM action_snapshots WHERE operation_id = $1`,
        [key],
      );
      expect(measured.ok).toBe(true);
      if (!measured.ok) return;

      const jours = measured.value.rows[0]?.jours;
      // Le TTL vaut 7 jours. Sans dérive : ~6. Mesuré AVANT correction avec
      // une dérive d'un an : 371.
      expect(jours).toBeGreaterThanOrEqual(5);
      expect(jours).toBeLessThanOrEqual(7);
    },
    30_000,
  );

  it(
    "une horloge de processus EN RETARD ne périme pas un instantané à sa naissance",
    async () => {
      /* L'erreur inverse, et elle est pire dans l'immédiat : l'instantané naît
         déjà expiré, donc l'annulation devient impossible sans que rien ne le
         signale. Un `undo` silencieusement indisponible est exactement le
         genre de défaut qu'on ne découvre qu'au moment où on en a besoin. */
      const snapshots = createSnapshotStore(db);
      const key = `deadline-${String(labKey('snap-retard'))}`;

      const captured = await withProcessClockShift(-ONE_YEAR_MS, () =>
        snapshots.capture({
          operationId: key,
          resourceKind: 'note',
          resourceId: 'sonde',
          undoKind: 'STATE_RESTORE',
          priorState: { contenu: 'avant' },
          privacyClass: 'ORANGE',
        }),
      );
      expect(captured.ok).toBe(true);

      const vivant = await db.query<{ vivant: boolean }>(
        `SELECT expires_at > now() AS vivant
           FROM action_snapshots WHERE operation_id = $1`,
        [key],
      );
      expect(vivant.ok).toBe(true);
      if (!vivant.ok) return;
      expect(vivant.value.rows[0]?.vivant).toBe(true);
    },
    30_000,
  );

  /* ================================================================== *
   * memory_candidates — la péremption d'une proposition
   * ================================================================== */

  it(
    "l'échéance d'un candidat mémoire est indépendante de l'horloge du processus",
    async () => {
      const inbox = createMemoryInbox(db);
      const contenu = `sonde d'échéance ${String(Date.now())}-${String(Math.random())}`;

      const queued = await withProcessClockShift(ONE_YEAR_MS, () =>
        inbox.enqueue({
          content: contenu,
          memoryType: 'SEMANTIC',
          sourceType: 'USER_EXPLICIT',
          source: 'banc',
          provenance: 'USER',
          privacyClass: 'GREEN',
          dataCategory: 'OTHER',
          suggestedConfidence: 0.9,
          subjectEntityId: null,
        }),
      );
      expect(queued.ok).toBe(true);

      const measured = await db.query<{ jours: number }>(
        `SELECT EXTRACT(DAY FROM (expires_at - clock_timestamp()))::int AS jours
           FROM memory_candidates WHERE content = $1`,
        [contenu],
      );
      expect(measured.ok).toBe(true);
      if (!measured.ok) return;

      const jours = measured.value.rows[0]?.jours;
      // TTL de 30 jours. Mesuré AVANT correction avec une dérive d'un an : 394.
      expect(jours).toBeGreaterThanOrEqual(28);
      expect(jours).toBeLessThanOrEqual(30);
    },
    30_000,
  );
});
