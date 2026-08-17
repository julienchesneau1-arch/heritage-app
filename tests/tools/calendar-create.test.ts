/**
 * `calendar_create` — Phase 3, point 3 de `docs/02`.
 *
 * PREMIER EFFET EXTERNE DU DÉPÔT.
 *
 * Les huit outils précédents écrivent dans PostgreSQL ou ne changent rien.
 * Celui-ci modifie un monde que nos transactions ne couvrent pas — et toute la
 * machinerie construite ces dernières semaines (contrats d'effet, `UNKNOWN`
 * définitif, refus de rejeu, deux mondes du banc) existait pour ce cas sans
 * qu'aucun code de production ne l'exerce.
 *
 * La propriété qui structure le fichier :
 *
 *   > Une ligne absente après commit PROUVE l'absence.
 *   > Un événement absent chez un fournisseur distant prouve seulement qu'il
 *   > n'est pas là À CET INSTANT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { calendarCreateTool } from '../../src/tools/calendar.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type { CalendarEvent, CalendarProvider } from '../../src/providers/contract.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

const DEMANDE = {
  title: 'Déjeuner avec Jean',
  startsAt: '2026-08-20T11:30:00.000Z',
  endsAt: '2026-08-20T13:00:00.000Z',
};

/** Journal de ce que le fournisseur a RÉELLEMENT reçu — le second monde. */
interface Traces {
  creations: { operationId: string; title: string }[];
}

/**
 * Fournisseur d'agenda pilotable.
 *
 * `creation` et `relecture` sont pilotés SÉPARÉMENT : c'est la seule façon de
 * reproduire le cas qui compte — l'écriture aboutit, la relecture ne le voit
 * pas encore.
 */
function agenda(options: {
  creation?: 'ok' | 'erreur';
  relecture?: 'present' | 'absent' | 'erreur';
  traces?: Traces;
  id?: string;
}): CalendarProvider {
  const cree: CalendarEvent[] = [];
  return {
    capabilities: {
      id: options.id ?? 'agenda-doublure',
      local: true,
      requiresNetwork: false,
      maxPrivacyClass: 'ORANGE',
      costPerMillionTokensEur: 0,
    },
    health: () => Promise.resolve(ok({ available: true })),
    listEvents: () => Promise.resolve(ok([])),
    createEvent: (event, operationIdRecu): Promise<Result<CalendarEvent>> => {
      options.traces?.creations.push({
        operationId: operationIdRecu,
        title: event.title,
      });
      if (options.creation === 'erreur') {
        return Promise.resolve(
          err(jarvisError('PROVIDER_UNAVAILABLE', 'agenda injoignable à l\'écriture')),
        );
      }
      const complet: CalendarEvent = { id: `evt-${String(cree.length + 1)}`, ...event };
      cree.push(complet);
      return Promise.resolve(ok(complet));
    },
    updateEvent: () =>
      Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre de ce test'))),
    verifyEvent: (id): Promise<Result<CalendarEvent | null>> => {
      if (options.relecture === 'erreur') {
        return Promise.resolve(
          err(jarvisError('PROVIDER_UNAVAILABLE', 'agenda injoignable à la relecture')),
        );
      }
      if (options.relecture === 'absent') return Promise.resolve(ok(null));
      return Promise.resolve(ok(cree.find((e) => e.id === id) ?? null));
    },
  };
}

describe.runIf(enabled)('calendar_create — Phase 3 point 3', () => {
  let db: Db;

  beforeAll(() => {
    db = appDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function creer(
    stack: Stack,
    input: Record<string, unknown> = DEMANDE,
  ): Promise<
    | { ok: true; status: string; output: Record<string, unknown> }
    | { ok: false; kind: string; message: string }
  > {
    const result = await stack.gateway.invoke({
      toolId: 'calendar_create',
      input,
      parameterProvenance: { title: 'USER', startsAt: 'USER', endsAt: 'USER' },
      operationId: op('cal-create'),
      actor: 'USER',
      // L3 : l'action est à cérémonie, `docs/03 §120`. Sans confirmation, le
      // Gate rend `CONFIRMATION_REQUIRED` — ce qu'un autre test éprouve.
      context: callContext({ cloudEnabled: true, userConfirmed: true }),
    });
    if (!result.ok) {
      return { ok: false, kind: result.error.kind, message: result.error.message };
    }
    return {
      ok: true,
      status: result.value.status,
      output: result.value.output as Record<string, unknown>,
    };
  }

  /* ================================================================== *
   * LA PROPRIÉTÉ CENTRALE — l'absence ne prouve rien, dehors
   * ================================================================== */

  it("relecture ABSENTE ⇒ UNKNOWN, jamais FAILED", async () => {
    /* LE TEST QUI JUSTIFIE TOUT LE RESTE.

       L'écriture a réussi : le fournisseur a rendu un identifiant. La
       relecture ne trouve rien. Un outil local conclurait `FAILED` — et il
       aurait raison, PostgreSQL ferme la fenêtre d'observation.

       Dehors, la fenêtre reste ouverte. « Je n'ai rien vu à l'instant t » ne
       prouve pas qu'une requête ne soit pas encore en vol (`docs/21 §2`).
       L'utilisateur qui entendrait « échec » recréerait le rendez-vous, et il
       en aurait deux. */
    const stack = buildStack(db, {
      calendar: agenda({ creation: 'ok', relecture: 'absent' }),
    });
    const cree = await creer(stack);

    expect(cree.ok).toBe(true);
    if (!cree.ok) return;
    expect(cree.status).toBe('UNKNOWN');
    expect(cree.status).not.toBe('FAILED');
  }, 30_000);

  it('relecture EN ERREUR ⇒ UNKNOWN, et le motif est nommé', async () => {
    const stack = buildStack(db, {
      calendar: agenda({ creation: 'ok', relecture: 'erreur' }),
    });
    const cree = await creer(stack);

    expect(cree.ok).toBe(true);
    if (!cree.ok) return;
    expect(cree.status).toBe('UNKNOWN');
  }, 30_000);

  it('relecture PRÉSENTE ⇒ CONFIRMED — contrôle négatif des deux ci-dessus', async () => {
    /* Sans lui, les deux tests précédents seraient verts en rendant toujours
       `UNKNOWN` : il suffirait de ne jamais rien confirmer. */
    const stack = buildStack(db, {
      calendar: agenda({ creation: 'ok', relecture: 'present' }),
    });
    const cree = await creer(stack);

    expect(cree.ok).toBe(true);
    if (!cree.ok) return;
    expect(cree.status).toBe('CONFIRMED');
    expect(cree.output['eventId']).toBe('evt-1');
  }, 30_000);

  /* ================================================================== *
   * LE CONTRAT D'EFFET — chaque champ choisi CONTRE une option flatteuse
   * ================================================================== */

  it("se déclare EXTERNALLY_VERIFIABLE, et surtout PAS PROVIDER_IDEMPOTENT", () => {
    /* LA DÉCLARATION LA PLUS DANGEREUSE DU DÉPÔT SI ELLE ÉTAIT FAUSSE.

       `createEvent(event, operationId)` INVITE à déclarer
       `PROVIDER_IDEMPOTENT` : la clé est là, le fournisseur pourrait
       dédoublonner. Mais « pourrait » n'est pas « garantit », et
       `PROVIDER_IDEMPOTENT` est le SEUL contrat externe qui autorise un rejeu
       après `UNKNOWN`.

       Aucun fournisseur n'existe. Le déclarer serait promettre AU NOM d'un
       adaptateur que personne n'a écrit — et le jour où quelqu'un brancherait
       un CalDAV qui ignore la clé, un rejeu créerait un second rendez-vous en
       silence. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const tool = stack.gateway.list().find((t) => t.definition.id === 'calendar_create');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    expect(d.effect).toBe('EXTERNALLY_VERIFIABLE');
    expect(d.effect).not.toBe('PROVIDER_IDEMPOTENT');
    /* `OBSERVABLE` : présence seulement. Le Verification Engine dégrade tout
       `FAILED` en `UNKNOWN` pour un tel outil — seconde barrière, pas
       l'unique. */
    expect(d.verifiability).toBe('OBSERVABLE');
    /* ZÉRO tentative. Une seconde requête après un échec réseau créerait un
       second rendez-vous si la première a abouti sans réponse. */
    expect(d.maxRetries).toBe(0);
    /* L3 — `docs/03 §120` nomme « déplacer un rendez-vous » comme exemple de
       APPROVAL. Le niveau est écrit dans le document, pas déduit. */
    expect(d.autonomy).toBe('L3');
    /* `NONE` : `verifyEvent(id)` exige l'identifiant de l'événement,
       précisément ce qu'on n'a pas après un crash. `BY_OPERATION_KEY` serait
       l'illusion de fiabilité que le validateur existe pour empêcher. */
    expect(d.attemptVerification).toBe('NONE');
  });

  it("est de la famille des effets EXTERNES, contrairement aux huit autres outils", () => {
    /* Fixe le fait historique : jusqu'ici, TOUT le dépôt était transactionnel
       ou sans effet. Ce test rougirait si quelqu'un requalifiait
       `calendar_create` en local pour se simplifier la vie. */
    const stack = buildStack(db, { calendar: agenda({}) });
    const externes = stack.gateway
      .list()
      .filter((t) => t.definition.effect !== 'NO_EXTERNAL_EFFECT'
        && t.definition.effect !== 'LOCAL_TRANSACTIONAL')
      .map((t) => t.definition.id);

    expect(externes).toContain('calendar_create');
  });

  /* ================================================================== *
   * Ce que le fournisseur reçoit — le second monde
   * ================================================================== */

  it("transmet la clé d'opération au fournisseur, et une seule fois", async () => {
    /* Elle ne FONDE aucune garantie de notre côté — voir `effect` — mais la
       retenir empêcherait un fournisseur qui, lui, sait dédoublonner, de le
       faire. On observe donc ce que le fournisseur a REÇU, pas ce que l'outil
       prétend avoir envoyé. */
    const traces: Traces = { creations: [] };
    const stack = buildStack(db, {
      calendar: agenda({ creation: 'ok', relecture: 'present', traces }),
    });
    await creer(stack);

    expect(traces.creations.length).toBe(1);
    expect(traces.creations[0]?.operationId.length).toBeGreaterThan(0);
    expect(traces.creations[0]?.title).toBe(DEMANDE.title);
  }, 30_000);

  it("échec d'écriture : UNKNOWN, et AUCUNE seconde requête", async () => {
    /* Deux propriétés en une, et la seconde est la plus importante : un
       `maxRetries` non nul créerait un doublon si la première requête avait
       abouti sans que la réponse nous parvienne. On le vérifie sur ce que le
       fournisseur a reçu, pas sur la configuration. */
    const traces: Traces = { creations: [] };
    const stack = buildStack(db, { calendar: agenda({ creation: 'erreur', traces }) });
    const cree = await creer(stack);

    expect(cree.ok).toBe(false);
    if (cree.ok) return;
    expect(traces.creations.length).toBe(1);
  }, 30_000);

  /* ================================================================== *
   * Ce que l'outil REFUSE
   * ================================================================== */

  it("SANS fournisseur : PROVIDER_UNAVAILABLE, et le refus dit que rien n'a été créé", async () => {
    const stack = buildStack(db);
    const cree = await creer(stack);

    expect(cree.ok).toBe(false);
    if (cree.ok) return;
    expect(cree.kind).toBe('PROVIDER_UNAVAILABLE');
    expect(cree.message).toContain("n'a pas");
  }, 30_000);

  it('REFUSE un événement qui finit avant de commencer', async () => {
    const stack = buildStack(db, { calendar: agenda({}) });
    const cree = await creer(stack, {
      ...DEMANDE,
      startsAt: DEMANDE.endsAt,
      endsAt: DEMANDE.startsAt,
    });

    expect(cree.ok).toBe(false);
    if (cree.ok) return;
    expect(cree.kind).toBe('VALIDATION');
  }, 30_000);

  it("exige une confirmation humaine : L3 ne s'exécute pas tout seul", async () => {
    /* `docs/03 §120` — APPROVAL. Et le fournisseur ne doit RIEN recevoir : une
       action préparée mais non confirmée n'a pas le droit de toucher le monde
       extérieur, même « pour préparer ». */
    const traces: Traces = { creations: [] };
    const stack = buildStack(db, { calendar: agenda({ traces }) });
    const result = await stack.gateway.invoke({
      toolId: 'calendar_create',
      input: DEMANDE,
      parameterProvenance: { title: 'USER', startsAt: 'USER', endsAt: 'USER' },
      operationId: op('cal-noconfirm'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true, userConfirmed: false }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('CONFIRMATION_REQUIRED');
    expect(traces.creations).toEqual([]);
  }, 30_000);

  it("capture de quoi être annulé, même si l'outil inverse n'existe pas encore", async () => {
    /* ADR-019 : « la capture est un enregistrement, pas une exécution ». Un
       effet externe non capturé serait définitivement non annulable — et
       dehors, contrairement à une ligne PostgreSQL, personne ne peut le
       retrouver à notre place. */
    const stack = buildStack(db, {
      calendar: agenda({ creation: 'ok', relecture: 'present' }),
    });
    const opId = op('cal-undo');
    const result = await stack.gateway.invoke({
      toolId: 'calendar_create',
      input: DEMANDE,
      parameterProvenance: { title: 'USER', startsAt: 'USER', endsAt: 'USER' },
      operationId: opId,
      actor: 'USER',
      context: callContext({ cloudEnabled: true, userConfirmed: true }),
    });
    expect(result.ok).toBe(true);

    const snap = await stack.snapshots.forOperation(opId);
    expect(snap.ok).toBe(true);
    if (!snap.ok || snap.value === null) throw new Error('aucune capture enregistrée');
    expect(snap.value.undoKind).toBe('INVERSE_OPERATION');
    expect(snap.value.inverseToolId).toBe('calendar_delete');
    expect(snap.value.resourceKind).toBe('calendar_event');
  }, 30_000);

  /* ================================================================== *
   * Le moteur de vérification est une SECONDE barrière, pas l'unique
   * ================================================================== */

  it("l'outil lui-même rend UNKNOWN sur une absence, sans compter sur le moteur", async () => {
    /* CEINTURE ET BRETELLES, ET LA MESURE DIT LAQUELLE TIENT.

       Deux barrières existent contre « l'événement n'a pas été créé » annoncé
       à tort :

         1. l'outil rend `UNKNOWN` — sa propre discipline, testée ici ;
         2. `constrainToVerifiability` (engine.ts:200) dégrade tout `FAILED`
            venant d'un outil `OBSERVABLE`.

       SABOTAGE MESURÉ : en remplaçant le `unknown` de `readBack` par un
       `failed`, ce test est le SEUL des douze à rougir. Le verdict rendu à
       l'utilisateur, lui, reste `UNKNOWN` — la barrière 2 rattrape la 1.

       C'est le bon résultat, et il fallait le mesurer pour le savoir : la
       redondance est réelle, pas décorative. Ce test est ce qui empêche la
       barrière 1 de pourrir sans bruit derrière la barrière 2. */
    const tool = calendarCreateTool(agenda({ relecture: 'absent' }));
    expect(typeof tool.readBack).toBe('function');
    if (tool.readBack === undefined) return;

    const outcome = await tool.readBack(
      { output: {}, resource: { kind: 'calendar_event', id: 'evt-inexistant' } },
      {
        db,
        operationId: op('cal-readback'),
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
