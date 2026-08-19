/**
 * Résolution de référents et détection d'ambiguïté.
 *
 * Porte de sortie Phase 1 : « Face à trois "Pierre" connus, Jarvis demande —
 * il ne choisit pas. »
 *
 * C'est le scénario 05/A3. Le test vérifie les deux moitiés de la règle :
 * qu'il demande quand il doit, et qu'il ne demande PAS quand le contexte
 * tranche réellement — une question inutile est aussi un défaut (PRD §137).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEntityResolver,
  disambiguationQuestion,
  type EntityResolver,
} from '../../src/core/context/resolver.js';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';

const skip = !databaseAvailable();

describe('formulation de la question', () => {
  it('pose UNE question, pas cinq', () => {
    const question = disambiguationQuestion('Pierre', [
      { id: '1', kind: 'PERSON', displayName: 'Pierre Dupont', viaConfirmedAlias: false, privacyClass: 'ORANGE' },
      { id: '2', kind: 'PERSON', displayName: 'Pierre Martin', viaConfirmedAlias: false, privacyClass: 'ORANGE' },
      { id: '3', kind: 'PERSON', displayName: 'Pierre du domaine', viaConfirmedAlias: false, privacyClass: 'ORANGE' },
    ]);
    expect(question).toBe('Pierre Dupont, Pierre Martin ou Pierre du domaine ?');
    expect(question.split('?').length - 1).toBe(1);
  });

  it('formule naturellement pour deux candidats', () => {
    expect(
      disambiguationQuestion('Paul', [
        { id: '1', kind: 'PERSON', displayName: 'Paul Riva', viaConfirmedAlias: false, privacyClass: 'ORANGE' },
        { id: '2', kind: 'PERSON', displayName: 'Paul Ngo', viaConfirmedAlias: false, privacyClass: 'ORANGE' },
      ]),
    ).toBe('Paul Riva ou Paul Ngo ?');
  });
});

describe.skipIf(skip)('EntityResolver', () => {
  let db: Db;
  let resolver: EntityResolver;
  const ids: Record<string, string> = {};
  let sessionId = '';

  beforeAll(async () => {
    db = appDb();
    resolver = createEntityResolver(db);

    for (const name of ['Pierre Dupont', 'Pierre Martin', 'Pierre du domaine', 'Jean Casta']) {
      const row = await db.query<{ id: string }>(
        `INSERT INTO entities (kind, display_name) VALUES ('PERSON', $1) RETURNING id`,
        [name],
      );
      if (!row.ok) throw new Error(row.error.message);
      ids[name] = row.value.rows[0]?.id ?? '';
    }

    const project = await db.query<{ id: string }>(
      `INSERT INTO entities (kind, display_name) VALUES ('PROJECT', 'Rénovation salon')
       RETURNING id`,
    );
    if (!project.ok) throw new Error(project.error.message);
    ids['Rénovation salon'] = project.value.rows[0]?.id ?? '';

    // Un alias confirmé par l'utilisateur.
    await db.query(
      `INSERT INTO entity_aliases (entity_id, alias, confirmed_by_user)
       VALUES ($1, 'le salon', true)`,
      [ids['Rénovation salon']],
    );

    const session = await db.query<{ id: string }>(
      `INSERT INTO sessions (mode) VALUES ('NORMAL') RETURNING id`,
    );
    if (!session.ok) throw new Error(session.error.message);
    sessionId = session.value.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await db.close();
  });

  /* ---------------------------------------------------------------------- */
  /* 05/A3 — l'ambiguïté                                                    */
  /* ---------------------------------------------------------------------- */

  it('face à trois Pierre, demande au lieu de choisir', async () => {
    const result = await resolver.resolveMention('Pierre');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe('AMBIGUOUS');
    if (result.value.kind !== 'AMBIGUOUS') return;
    expect(result.value.candidates.length).toBe(3);
    expect(result.value.question).toContain('Pierre Dupont');
    expect(result.value.question).toContain('?');
  });

  it('résout sans question quand un seul candidat existe', async () => {
    const result = await resolver.resolveMention('Jean');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('RESOLVED');
    if (result.value.kind !== 'RESOLVED') return;
    expect(result.value.entity.displayName).toBe('Jean Casta');
  });

  it('résout un alias confirmé par l\'utilisateur', async () => {
    const result = await resolver.resolveMention('le salon');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('RESOLVED');
    if (result.value.kind !== 'RESOLVED') return;
    expect(result.value.entity.displayName).toBe('Rénovation salon');
    expect(result.value.confidence).toBe(1);
  });

  it('signale une mention inconnue au lieu d\'inventer', async () => {
    const result = await resolver.resolveMention('Bartholomé');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('NOT_FOUND');
  });

  /* ---------------------------------------------------------------------- */
  /* PRD §86 — « do the obvious », mais seulement sur preuve                */
  /* ---------------------------------------------------------------------- */

  it('tranche quand un seul des homonymes a été évoqué dans la session', async () => {
    await db.query(
      `INSERT INTO session_turns (session_id, turn_index, speaker, content, mentioned_entity_ids)
       VALUES ($1, 0, 'USER', 'J''ai vu Pierre Martin hier', ARRAY[$2]::uuid[])`,
      [sessionId, ids['Pierre Martin']],
    );

    const result = await resolver.resolveMention('Pierre', sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe('RESOLVED');
    if (result.value.kind !== 'RESOLVED') return;
    expect(result.value.entity.displayName).toBe('Pierre Martin');
    // Confiance inférieure au cas non ambigu : la résolution vient du
    // contexte, pas du nom.
    expect(result.value.confidence).toBeLessThan(0.9);
    expect(result.value.reason).toContain('conversation');
  });

  it('redemande si DEUX homonymes ont été évoqués', async () => {
    await db.query(
      `INSERT INTO session_turns (session_id, turn_index, speaker, content, mentioned_entity_ids)
       VALUES ($1, 1, 'USER', 'Pierre Dupont aussi', ARRAY[$2]::uuid[])`,
      [sessionId, ids['Pierre Dupont']],
    );

    const result = await resolver.resolveMention('Pierre', sessionId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('AMBIGUOUS');
  });

  /* ---------------------------------------------------------------------- */
  /* Anaphore — « celui-ci »                                                */
  /* ---------------------------------------------------------------------- */

  it('résout « celui-ci » vers la dernière entité évoquée', async () => {
    const session = await db.query<{ id: string }>(
      `INSERT INTO sessions (mode) VALUES ('NORMAL') RETURNING id`,
    );
    if (!session.ok) throw new Error(session.error.message);
    const fresh = session.value.rows[0]?.id ?? '';

    await db.query(
      `INSERT INTO session_turns (session_id, turn_index, speaker, content, mentioned_entity_ids)
       VALUES ($1, 0, 'USER', 'Parlons du salon', ARRAY[$2]::uuid[])`,
      [fresh, ids['Rénovation salon']],
    );

    const result = await resolver.resolveAnaphora(fresh);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('RESOLVED');
    if (result.value.kind !== 'RESOLVED') return;
    expect(result.value.entity.displayName).toBe('Rénovation salon');
  });

  it('demande si deux entités ont été évoquées au même tour', async () => {
    const session = await db.query<{ id: string }>(
      `INSERT INTO sessions (mode) VALUES ('NORMAL') RETURNING id`,
    );
    if (!session.ok) throw new Error(session.error.message);
    const fresh = session.value.rows[0]?.id ?? '';

    await db.query(
      `INSERT INTO session_turns (session_id, turn_index, speaker, content, mentioned_entity_ids)
       VALUES ($1, 0, 'USER', 'Jean et le salon', ARRAY[$2, $3]::uuid[])`,
      [fresh, ids['Jean Casta'], ids['Rénovation salon']],
    );

    const result = await resolver.resolveAnaphora(fresh);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('AMBIGUOUS');
  });

  it('ne devine pas dans une session vide', async () => {
    const session = await db.query<{ id: string }>(
      `INSERT INTO sessions (mode) VALUES ('NORMAL') RETURNING id`,
    );
    if (!session.ok) throw new Error(session.error.message);

    const result = await resolver.resolveAnaphora(session.value.rows[0]?.id ?? '');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('NOT_FOUND');
  });
});
