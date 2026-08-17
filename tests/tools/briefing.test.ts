/**
 * `briefing_generate` — Phase 3 point 7, scénario doré **A7**.
 *
 *   > **Attendu :** agenda + tâches urgentes + points en attente, résumé.
 *   > **Aucune modification.**
 *
 * La difficulté n'est pas d'agréger trois sources. Elle est que chacune peut
 * manquer indépendamment :
 *
 *   > Un briefing qui présente deux tiers de la journée comme si c'était la
 *   > journée entière ne se contente pas d'omettre — il COMPOSE une image
 *   > cohérente et fausse.
 *
 * C'est le mensonge d'ADR-043 élevé au cube, et il est plus difficile à
 * repérer : rien ne manque visiblement.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type { CalendarEvent, CalendarProvider } from '../../src/providers/contract.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

const RDV: CalendarEvent = {
  id: 'evt-brief',
  title: 'Comité de pilotage',
  startsAt: '2026-08-17T09:00:00.000Z',
  endsAt: '2026-08-17T10:00:00.000Z',
};

function agenda(options: { panne?: boolean; events?: readonly CalendarEvent[] }): CalendarProvider {
  return {
    capabilities: {
      id: 'agenda-doublure',
      local: true,
      requiresNetwork: false,
      maxPrivacyClass: 'ORANGE',
      costPerMillionTokensEur: 0,
    },
    health: () => Promise.resolve(ok({ available: options.panne !== true })),
    listEvents: (): Promise<Result<readonly CalendarEvent[]>> =>
      Promise.resolve(
        options.panne === true
          ? err(jarvisError('PROVIDER_UNAVAILABLE', 'agenda injoignable'))
          : ok(options.events ?? [RDV]),
      ),
    createEvent: () => Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre'))),
    updateEvent: () => Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre'))),
    verifyEvent: () => Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre'))),
  };
}

interface Sortie {
  jour: string;
  agenda: { etat: string; motif?: string; items: unknown[] };
  taches: { etat: string; items: { title: string }[] };
  enAttente: { etat: string; items: unknown[] };
  complet: boolean;
  manquantes: number;
}

describe.runIf(enabled)('briefing_generate — A7', () => {
  let db: Db;

  beforeAll(() => {
    db = appDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM tasks WHERE title LIKE 'brief-%'");
  });

  async function preparer(
    stack: Stack,
  ): Promise<
    | { ok: true; sortie: Sortie }
    | { ok: false; kind: string }
  > {
    const result = await stack.gateway.invoke({
      toolId: 'briefing_generate',
      input: { limit: 10 },
      parameterProvenance: { limit: 'USER' },
      operationId: op('brief'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true }),
    });
    if (!result.ok) return { ok: false, kind: result.error.kind };
    return { ok: true, sortie: result.value.output as Sortie };
  }

  /* ================================================================== *
   * LA PROPRIÉTÉ CENTRALE — un briefing partiel se déclare partiel
   * ================================================================== */

  it("SANS agenda : les autres sections sont rendues, et le manque est DÉCLARÉ", async () => {
    /* LE TEST QUI JUSTIFIE L'OUTIL.

       Contrairement à `calendar_read`, échouer serait excessif : les tâches et
       les points en attente sont connus, et une réponse partielle vaut mieux
       qu'aucune réponse. À CONDITION qu'elle dise qu'elle est partielle. */
    const stack = buildStack(db); // aucun agenda : l'état réel du dépôt
    const brief = await preparer(stack);

    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.sortie.agenda.etat).toBe('INDISPONIBLE');
    expect(brief.sortie.agenda.motif).toContain('fournisseur');
    expect(brief.sortie.agenda.items).toEqual([]);
    // Les deux autres sections, elles, ont bien répondu.
    expect(brief.sortie.taches.etat).toBe('OK');
    expect(brief.sortie.enAttente.etat).toBe('OK');
    // Et le drapeau qui se lit en un coup d'œil.
    expect(brief.sortie.complet).toBe(false);
    expect(brief.sortie.manquantes).toBe(1);
  }, 30_000);

  it('agenda EN PANNE : même traitement, motif différent', async () => {
    const stack = buildStack(db, { calendar: agenda({ panne: true }) });
    const brief = await preparer(stack);

    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.sortie.agenda.etat).toBe('INDISPONIBLE');
    expect(brief.sortie.agenda.motif).toContain('injoignable');
    expect(brief.sortie.complet).toBe(false);
  }, 30_000);

  it('les TROIS sources disponibles ⇒ `complet: true` — contrôle négatif', async () => {
    /* Sans lui, les deux tests précédents seraient verts en déclarant TOUJOURS
       le briefing incomplet : il suffirait de ne jamais rien réussir. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const brief = await preparer(stack);

    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.sortie.agenda.etat).toBe('OK');
    expect(brief.sortie.complet).toBe(true);
    expect(brief.sortie.manquantes).toBe(0);
  }, 30_000);

  it("un agenda VRAIMENT vide n'est pas un agenda indisponible", async () => {
    /* La distinction d'ADR-043, portée jusque dans le briefing : « rien de
       prévu » et « je ne sais pas ce qui est prévu » sont deux journées
       différentes. */
    const stack = buildStack(db, { calendar: agenda({ events: [] }) });
    const brief = await preparer(stack);

    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.sortie.agenda.etat).toBe('OK');
    expect(brief.sortie.agenda.items).toEqual([]);
    expect(brief.sortie.complet).toBe(true);
  }, 30_000);

  /* ================================================================== *
   * A7 — les trois sources
   * ================================================================== */

  it("A7 — rend l'agenda, les tâches ouvertes et les points en attente", async () => {
    const stack = buildStack(db, { calendar: agenda({}) });

    /* Échéance dans l'heure : la tâche entre dans le groupe URGENT, en tête
       du tri. Sans cela le test dépendait du nombre de tâches ouvertes créées
       par le reste de la suite — vert seul, rouge en suite complète. Et c'est
       ce qui a fait découvrir que l'ordre du groupe sans échéance n'était pas
       déterministe. */
    const créée = await stack.gateway.invoke({
      toolId: 'task_create',
      input: {
        title: `brief-${String(Date.now())}`,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      parameterProvenance: { title: 'USER' },
      operationId: op('brief-task'),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    expect(créée.ok).toBe(true);

    const brief = await preparer(stack);
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;

    expect(brief.sortie.agenda.items.length).toBe(1);
    expect(brief.sortie.taches.items.some((t) => t.title.startsWith('brief-'))).toBe(true);
    expect(brief.sortie.enAttente.etat).toBe('OK');
  }, 30_000);

  it('« aujourd\'hui » est borné par la BASE, pas par le processus', async () => {
    /* Leçon d'ADR-037 : un processus dont l'horloge dérive préparerait la
       mauvaise journée — avec l'aplomb de celui qui a tout regardé. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const real = Date.now.bind(Date);
    Date.now = () => real() + 60 * 24 * 3_600 * 1_000; // deux mois plus tard
    try {
      const brief = await preparer(stack);
      expect(brief.ok).toBe(true);
      if (!brief.ok) return;
      const jour = new Date(brief.sortie.jour).getTime();
      // Le jour reste celui de la base : à moins d'un jour de l'heure réelle.
      expect(Math.abs(jour - real())).toBeLessThan(48 * 3_600 * 1_000);
    } finally {
      Date.now = real;
    }
  }, 30_000);

  /* ================================================================== *
   * « Aucune modification » — vérifié sur le TEXTE
   * ================================================================== */

  it("A7 — NE MODIFIE RIEN, et c'est une impossibilité de construction", async () => {
    /* « Interdit : créer, déplacer ou modifier quoi que ce soit. »

       Une garantie comportementale resterait verte le jour où quelqu'un ajoute
       un `UPDATE` « pour marquer le briefing comme lu ». Vérifié sur la source :
       la prochaine écriture ajoutée fait rougir ce test. */
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/tools/briefing.ts', 'utf8');

    for (const interdit of [
      'INSERT ',
      'UPDATE ',
      'DELETE ',
      'createEvent',
      'updateEvent',
    ]) {
      expect(source, interdit).not.toContain(interdit);
    }
  });

  it("N'APPELLE PAS le Tool Gateway — la composition d'outils reste non éprouvée", async () => {
    /* Aucun outil du dépôt n'invoque le Gateway. Le faire ici créerait des
       opérations imbriquées, avec baux et journaux imbriqués — un terrain non
       éprouvé qu'on n'inaugure pas dans un outil de confort.

       Le jour où la composition sera un chantier assumé, ce test sera le
       premier à retirer, sciemment. */
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/tools/briefing.ts', 'utf8');
    expect(source).not.toContain('gateway');
    expect(source).not.toContain('.invoke(');
  });

  it('déclare le contrat que A7 impose', () => {
    const stack = buildStack(db, { calendar: agenda({}) });
    const tool = stack.gateway.list().find((t) => t.definition.id === 'briefing_generate');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    // « Aucune modification » : la seule déclaration honnête.
    expect(d.effect).toBe('NO_EXTERNAL_EFFECT');
    expect(d.autonomy).toBe('L1');
    expect(d.reversible).toBe(false);
    expect(d.rollback).toBeNull();
    /* Il hérite du fournisseur d'agenda (ADR-051). Ici il n'y en a pas :
       rien ne sort de la machine, et le briefing rend sa section agenda
       `INDISPONIBLE` — ce qui est la bonne réponse, pas un contournement. */
    expect(d.networkRequired).toBe(false);
    /* Un ensemble hérite du niveau MAXIMUM de ses éléments (`docs/14 §3`) :
       agenda + tâches + rappels, donc CALENDAR, donc SENSITIVE. */
    expect(d.dataCategory).toBe('CALENDAR');
    expect(d.requiredSecrets).toEqual([]);
  });
});
