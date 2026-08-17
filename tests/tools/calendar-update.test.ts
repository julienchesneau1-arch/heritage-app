/**
 * `calendar_update` — Phase 3, point 4 de `docs/02`.
 *
 * ADR-042 APPLIQUÉ LÀ OÙ L'ÉTAT ANTÉRIEUR VIT CHEZ QUELQU'UN D'AUTRE.
 *
 * `task_complete` a établi qu'une modification ne se défait qu'en restaurant
 * l'état OBSERVÉ, et l'a obtenu en fusionnant mutation et capture dans une
 * seule instruction SQL. Ici cette fusion est impossible : entre une lecture
 * chez le fournisseur et l'écriture qui suit, l'événement peut changer — le
 * téléphone de l'utilisateur écrit dans le même agenda.
 *
 * On ne peut pas fermer la fenêtre. On déplace l'obligation :
 *
 *   > Le fournisseur — seule partie à avoir réellement effectué l'échange —
 *   > déclare CE QU'IL A REMPLACÉ.
 *
 * Et on ne le croit pas sur parole : ce qu'il déclare est vérifié.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type {
  CalendarEvent,
  CalendarProvider,
  CalendarUpdate,
} from '../../src/providers/contract.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

const INITIAL: CalendarEvent = {
  id: 'evt-42',
  title: 'Point hebdomadaire',
  startsAt: '2026-08-20T09:00:00.000Z',
  endsAt: '2026-08-20T10:00:00.000Z',
};

interface Traces {
  updates: { id: string; operationId: string }[];
}

/**
 * Agenda pilotable.
 *
 * `menteur` fait rendre au fournisseur un `previous` portant l'identifiant
 * d'un AUTRE événement — le seul mensonge qui rendrait l'annulation
 * destructrice plutôt qu'absente.
 */
function agenda(options: {
  courant?: CalendarEvent;
  ecriture?: 'ok' | 'erreur';
  relecture?: 'suit' | 'absent' | 'erreur';
  menteur?: 'previous' | 'updated';
  traces?: Traces;
  id?: string;
}): CalendarProvider {
  let courant: CalendarEvent = options.courant ?? INITIAL;
  return {
    capabilities: {
      id: options.id ?? 'agenda-doublure',
      local: true,
      requiresNetwork: false,
      maxPrivacyClass: 'ORANGE',
      costPerMillionTokensEur: 0,
    },
    health: () => Promise.resolve(ok({ available: true })),
    listEvents: () => Promise.resolve(ok([courant])),
    createEvent: () =>
      Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre de ce test'))),
    updateEvent: (id, changes, operationIdRecu): Promise<Result<CalendarUpdate>> => {
      options.traces?.updates.push({ id, operationId: operationIdRecu });
      if (options.ecriture === 'erreur') {
        return Promise.resolve(
          err(jarvisError('PROVIDER_UNAVAILABLE', 'agenda injoignable à l\'écriture')),
        );
      }
      const previous = courant;
      courant = { ...courant, ...changes };
      return Promise.resolve(
        ok({
          previous:
            options.menteur === 'previous' ? { ...previous, id: 'evt-QUELQUUN-DAUTRE' } : previous,
          updated:
            options.menteur === 'updated' ? { ...courant, id: 'evt-AUTRE-ENCORE' } : courant,
        }),
      );
    },
    verifyEvent: (): Promise<Result<CalendarEvent | null>> => {
      if (options.relecture === 'erreur') {
        return Promise.resolve(
          err(jarvisError('PROVIDER_UNAVAILABLE', 'agenda injoignable à la relecture')),
        );
      }
      if (options.relecture === 'absent') return Promise.resolve(ok(null));
      return Promise.resolve(ok(courant));
    },
  };
}

describe.runIf(enabled)('calendar_update — Phase 3 point 4', () => {
  let db: Db;

  beforeAll(() => {
    db = appDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function modifier(
    stack: Stack,
    input: Record<string, unknown> = { eventId: INITIAL.id, startsAt: '2026-08-20T15:00:00.000Z' },
    opId = op('cal-upd'),
  ): Promise<
    | { ok: true; op: string; status: string; output: Record<string, unknown> }
    | { ok: false; kind: string; message: string }
  > {
    const result = await stack.gateway.invoke({
      toolId: 'calendar_update',
      input,
      parameterProvenance: {
        eventId: 'USER',
        title: 'USER',
        startsAt: 'USER',
        endsAt: 'USER',
      },
      operationId: opId,
      actor: 'USER',
      context: callContext({ cloudEnabled: true, userConfirmed: true }),
    });
    if (!result.ok) {
      return { ok: false, kind: result.error.kind, message: result.error.message };
    }
    return {
      ok: true,
      op: opId,
      status: result.value.status,
      output: result.value.output as Record<string, unknown>,
    };
  }

  /* ================================================================== *
   * LA PROPRIÉTÉ CENTRALE — l'état antérieur vient de celui qui a échangé
   * ================================================================== */

  it("capture l'état antérieur DÉCLARÉ PAR LE FOURNISSEUR, pas un état supposé", async () => {
    /* LE TEST QUI PORTE ADR-045.

       L'outil ne lit jamais l'événement avant d'écrire. Il ne le pourrait pas
       utilement : entre sa lecture et son écriture, le téléphone de
       l'utilisateur peut modifier le même agenda, et la capture décrirait un
       passé qui n'était déjà plus vrai.

       C'est donc `updateEvent` qui rend `previous`, et c'est ce `previous` —
       et rien d'autre — qui part dans la capture d'annulation. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const modifie = await modifier(stack);

    expect(modifie.ok).toBe(true);
    if (!modifie.ok) return;

    const snap = await stack.snapshots.forOperation(modifie.op);
    expect(snap.ok).toBe(true);
    if (!snap.ok || snap.value === null) throw new Error('aucune capture enregistrée');

    expect(snap.value.undoKind).toBe('STATE_RESTORE');
    expect(snap.value.priorState).toEqual({
      eventId: INITIAL.id,
      title: INITIAL.title,
      startsAt: INITIAL.startsAt, // 09:00 — l'AVANT, pas le 15:00 demandé
      endsAt: INITIAL.endsAt,
    });
  }, 30_000);

  it("l'état antérieur capturé n'est PAS l'état écrit", async () => {
    /* Le test qui discrimine : un outil qui capturerait ce qu'il vient
       d'écrire passerait le précédent si `previous` et `updated` se
       ressemblaient. Ici ils diffèrent sur `startsAt`, et l'écart est la
       preuve. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const modifie = await modifier(stack, {
      eventId: INITIAL.id,
      startsAt: '2026-08-20T15:00:00.000Z',
    });
    expect(modifie.ok).toBe(true);
    if (!modifie.ok) return;

    expect(modifie.output['startsAt']).toBe('2026-08-20T15:00:00.000Z');

    const snap = await stack.snapshots.forOperation(modifie.op);
    if (!snap.ok || snap.value === null) throw new Error('aucune capture');
    const prior = snap.value.priorState as { startsAt: string };
    expect(prior.startsAt).toBe(INITIAL.startsAt);
    expect(prior.startsAt).not.toBe(modifie.output['startsAt']);
  }, 30_000);

  /* ================================================================== *
   * LE FOURNISSEUR EST VÉRIFIÉ, PAS CRU SUR PAROLE
   * ================================================================== */

  it("REFUSE un `previous` portant l'identifiant d'un AUTRE événement", async () => {
    /* LE MENSONGE QUI COMPTE, ET IL EST PIRE QUE L'ABSENCE D'ANNULATION.

       Si le fournisseur rend l'état antérieur d'un autre rendez-vous, la
       capture est syntaxiquement parfaite. Le jour de l'annulation, Jarvis
       écraserait un TIERS avec cet état — il détruirait un rendez-vous que
       personne n'a demandé de toucher.

       Une capture inutilisable vaut mieux qu'une capture destructrice : on
       refuse. */
    const stack = buildStack(db, { calendar: agenda({ menteur: 'previous' }) });
    const modifie = await modifier(stack);

    expect(modifie.ok).toBe(false);
    if (modifie.ok) return;
    expect(modifie.kind).toBe('INTEGRITY');
    expect(modifie.message).toContain('annulable');
  }, 30_000);

  it("REFUSE un `updated` portant un autre identifiant", async () => {
    const stack = buildStack(db, { calendar: agenda({ menteur: 'updated' }) });
    const modifie = await modifier(stack);

    expect(modifie.ok).toBe(false);
    if (modifie.ok) return;
    expect(modifie.kind).toBe('INTEGRITY');
  }, 30_000);

  it('un fournisseur HONNÊTE passe — contrôle négatif des deux refus', async () => {
    /* Sans lui, les deux tests ci-dessus seraient verts en refusant toujours. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const modifie = await modifier(stack);
    expect(modifie.ok).toBe(true);
  }, 30_000);

  /* ================================================================== *
   * Dehors, l'absence ne prouve toujours rien
   * ================================================================== */

  it('relecture ABSENTE ⇒ UNKNOWN, jamais FAILED', async () => {
    /* Et ici le motif est encore plus net que pour la création : un événement
       disparu après notre modification peut avoir été SUPPRIMÉ PAR UN TIERS
       après une modification parfaitement réussie. */
    const stack = buildStack(db, { calendar: agenda({ relecture: 'absent' }) });
    const modifie = await modifier(stack);

    expect(modifie.ok).toBe(true);
    if (!modifie.ok) return;
    expect(modifie.status).toBe('UNKNOWN');
  }, 30_000);

  it('relecture qui SUIT la modification ⇒ CONFIRMED', async () => {
    const stack = buildStack(db, { calendar: agenda({ relecture: 'suit' }) });
    const modifie = await modifier(stack);

    expect(modifie.ok).toBe(true);
    if (!modifie.ok) return;
    expect(modifie.status).toBe('CONFIRMED');
  }, 30_000);

  /* ================================================================== *
   * Ce que l'outil REFUSE
   * ================================================================== */

  it("REFUSE une demande VIDE plutôt que d'annoncer une modification", async () => {
    /* Accepter ferait écrire au journal « rendez-vous modifié » sans qu'aucun
       champ ait bougé — et la capture enregistrerait un état antérieur
       identique au courant, ce qui n'annule rien. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const modifie = await modifier(stack, { eventId: INITIAL.id });

    expect(modifie.ok).toBe(false);
    if (modifie.ok) return;
    expect(modifie.kind).toBe('VALIDATION');
  }, 30_000);

  it('REFUSE un créneau qui finit avant de commencer', async () => {
    const stack = buildStack(db, { calendar: agenda({}) });
    const modifie = await modifier(stack, {
      eventId: INITIAL.id,
      startsAt: '2026-08-20T18:00:00.000Z',
      endsAt: '2026-08-20T17:00:00.000Z',
    });

    expect(modifie.ok).toBe(false);
    if (modifie.ok) return;
    expect(modifie.kind).toBe('VALIDATION');
  }, 30_000);

  it("SANS fournisseur : PROVIDER_UNAVAILABLE, jamais un succès silencieux", async () => {
    const stack = buildStack(db);
    const modifie = await modifier(stack);

    expect(modifie.ok).toBe(false);
    if (modifie.ok) return;
    expect(modifie.kind).toBe('PROVIDER_UNAVAILABLE');
  }, 30_000);

  it("échec d'écriture : AUCUNE seconde requête", async () => {
    /* `maxRetries: 0`, et la raison est pire que pour la création : un second
       `update` rejoué écraserait la capture du premier avec l'état qu'il vient
       lui-même d'écrire. Rien, dehors, ne nous dirait que c'est arrivé.
       Vérifié sur ce que le fournisseur a REÇU. */
    const traces: Traces = { updates: [] };
    const stack = buildStack(db, { calendar: agenda({ ecriture: 'erreur', traces }) });
    const modifie = await modifier(stack);

    expect(modifie.ok).toBe(false);
    expect(traces.updates.length).toBe(1);
  }, 30_000);

  /* ================================================================== *
   * Le contrat déclaré
   * ================================================================== */

  it("exige une confirmation humaine, et le fournisseur ne reçoit RIEN sans elle", async () => {
    /* `docs/03 §120` nomme littéralement « déplacer un rendez-vous » comme
       exemple d'APPROVAL : c'est CET outil que le document décrit. */
    const traces: Traces = { updates: [] };
    const stack = buildStack(db, { calendar: agenda({ traces }) });
    const result = await stack.gateway.invoke({
      toolId: 'calendar_update',
      input: { eventId: INITIAL.id, startsAt: '2026-08-20T15:00:00.000Z' },
      parameterProvenance: { eventId: 'USER', startsAt: 'USER' },
      operationId: op('cal-upd-noconfirm'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true, userConfirmed: false }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('CONFIRMATION_REQUIRED');
    expect(traces.updates).toEqual([]);
  }, 30_000);

  it('déclare le contrat que sa nature impose', () => {
    const stack = buildStack(db, { calendar: agenda({}) });
    const tool = stack.gateway.list().find((t) => t.definition.id === 'calendar_update');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    expect(d.autonomy).toBe('L3');
    expect(d.effect).toBe('EXTERNALLY_VERIFIABLE');
    expect(d.verifiability).toBe('OBSERVABLE');
    expect(d.maxRetries).toBe(0);
    expect(d.reversible).toBe(true);
    expect(d.rollback).not.toBeNull();
    // S6 : une mutation exige une clé d'opération. La leçon d'ADR-042.
    expect(d.idempotency).toBe('OPERATION_KEY');
  });

  it("l'interface FOURNISSEUR porte l'obligation, pas seulement l'outil", async () => {
    /* La propriété structurelle d'ADR-045, vérifiée sur le texte du contrat :
       un fournisseur qui ne saurait rendre que `updated` ne peut pas
       satisfaire `CalendarProvider`. L'obligation est dans la signature, donc
       elle survit au prochain adaptateur écrit par quelqu'un de pressé. */
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/providers/contract.ts', 'utf8');

    expect(source).toContain('interface CalendarUpdate');
    expect(source).toContain('readonly previous: CalendarEvent');
    expect(source).toContain('Promise<Result<CalendarUpdate>>');
  });

  it("l'outil lui-même rend UNKNOWN sur une absence, sans compter sur le moteur", async () => {
    /* CE TEST EXISTE PARCE QUE SON ABSENCE A ÉTÉ MESURÉE.

       Premier passage de sabotage : en remplaçant le `unknown` de `readBack`
       par un `failed`, **aucun des treize autres tests ne rougissait.**
       `constrainToVerifiability` (engine.ts:200) dégrade tout `FAILED` venant
       d'un outil `OBSERVABLE`, donc le verdict rendu à l'utilisateur restait
       correct — et la discipline propre de l'outil pouvait pourrir sans bruit
       derrière celle du moteur.

       C'est exactement ce que le fichier jumeau (`calendar-create.test.ts`)
       avait nommé, et que j'avais omis d'appliquer ici. La redondance ne se
       teste pas toute seule : chaque barrière a besoin de son propre test,
       sinon seule la dernière est réellement éprouvée. */
    const { calendarUpdateTool } = await import('../../src/tools/calendar.js');
    const tool = calendarUpdateTool(agenda({ relecture: 'absent' }));
    expect(typeof tool.readBack).toBe('function');
    if (tool.readBack === undefined) return;

    const outcome = await tool.readBack(
      { output: {}, resource: { kind: 'calendar_event', id: INITIAL.id } },
      {
        db,
        operationId: op('cal-upd-readback'),
        actor: 'USER',
        secrets: new Map<string, string>(),
      },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.status).toBe('UNKNOWN');
    expect(outcome.value.unknownReason).toBe('EXTERNAL_STATE');
  });
});
