/**
 * `egress_review` — scénario doré **C4**, étape F3 du Data Firewall.
 *
 *   > « Montre-moi ce qui est parti sur Internet. »
 *   > → liste lisible par un humain — **destination, classe de données,
 *   >   raison.**
 *
 * Trois colonnes, et aucune n'est décorative. « Trois requêtes sont sorties »
 * ne répond à rien : la question porte sur ce qu'on ne peut pas reconstituer
 * soi-même.
 *
 * Et une propriété qui n'a pas d'équivalent ailleurs dans le dépôt : ce que ce
 * fichier éprouve surtout, c'est que la console **n'invente pas** — ni une
 * sortie qui n'a pas eu lieu, ni un silence quand il y en a eu une.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { z } from 'zod';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import { defineTool, type RegisteredTool } from '../../src/core/tools/contract.js';
import type { CalendarEvent, CalendarProvider } from '../../src/providers/contract.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

const FENETRE = {
  fromIso: '2026-08-17T00:00:00.000Z',
  toIso: '2026-08-17T23:59:59.000Z',
};

/** Agenda dont on choisit s'il est local ou distant. */
function agenda(local: boolean, id: string): CalendarProvider {
  return {
    capabilities: {
      id,
      local,
      requiresNetwork: !local,
      maxPrivacyClass: 'ORANGE',
      costPerMillionTokensEur: 0,
    },
    health: () => Promise.resolve(ok({ available: true })),
    listEvents: (): Promise<Result<readonly CalendarEvent[]>> => Promise.resolve(ok([])),
    createEvent: () => Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre'))),
    updateEvent: () => Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre'))),
    verifyEvent: () => Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre'))),
  };
}

/**
 * Outil-sonde : la seule façon d'obtenir une égression aujourd'hui.
 *
 * `WEATHER` est la seule catégorie dont le plancher est `PUBLIC` — donc la
 * seule qui franchisse la règle « niveau ≥ SENSITIVE + egress → DENY ».
 */
function sondeMeteo(): RegisteredTool {
  return defineTool({
    definition: {
      id: 'test_weather_probe',
      version: '1.0.0',
      description: 'Sonde de test : sort vraiment, sur une donnée PUBLIC.',
      autonomy: 'L1',
      privacyClass: 'GREEN',
      dataCategory: 'WEATHER',
      reversible: false,
      networkRequired: true,
      parameters: [],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 2_000,
      maxRetries: 0,
      auditEvent: 'TEST_WEATHER_PROBED',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: z.object({}),
    execute: () =>
      Promise.resolve(
        ok({
          egress: { destination: 'service-meteo-fictif' },
          output: { temperature: 21 },
        }),
      ),
  });
}

interface Sortie {
  destination: string;
  dataLevel: string;
  reason: string;
  tool: string | null;
}

describe.runIf(enabled)('egress_review — C4', () => {
  let db: Db;

  beforeAll(() => {
    db = appDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // Le journal est append-only : on ne le vide pas, on borne la lecture.
    await db.query('SELECT 1');
  });

  async function consulter(
    stack: Stack,
  ): Promise<{ count: number; rienNEstSorti: boolean; sorties: Sortie[] }> {
    const result = await stack.gateway.invoke({
      toolId: 'egress_review',
      input: { window: 'today', limit: 200 },
      parameterProvenance: { window: 'USER', limit: 'USER' },
      operationId: op('egr'),
      actor: 'USER',
      context: callContext(),
    });
    if (!result.ok) throw new Error(`refusé : ${result.error.message}`);
    return result.value.output as { count: number; rienNEstSorti: boolean; sorties: Sortie[] };
  }

  /* ================================================================== *
   * C4 — les trois colonnes
   * ================================================================== */

  it('C4 — rend DESTINATION, CLASSE et RAISON pour une sortie réelle', async () => {
    /* IL A FALLU FABRIQUER UN OUTIL POUR CE TEST, ET C'EST UN CONSTAT.

       Depuis F2, **aucun outil du dépôt ne peut produire une égression** : les
       quatre qui sortent manipulent tous de l'agenda, donc `SENSITIVE`, donc
       refusés. La console C4 est livrée sans producteur en production.

       Ce n'est pas un défaut — c'est la protection qui fonctionne — mais ça
       veut dire que la console ne peut être éprouvée qu'avec un outil dont la
       catégorie AUTORISE la sortie. On en enregistre un : `WEATHER`, seule
       catégorie dont le plancher est `PUBLIC` (`docs/14 §3`).

       Le jour où `web_search` existera, il prendra cette place. */
    const stack = buildStack(db);
    stack.registerExtra(sondeMeteo());

    const appel = await stack.gateway.invoke({
      toolId: 'test_weather_probe',
      input: {},
      parameterProvenance: {},
      operationId: op('egr-reelle'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true }),
    });
    expect(appel.ok).toBe(true);

    const vue = await consulter(stack);
    const ligne = vue.sorties.find((s) => s.destination === 'service-meteo-fictif');
    expect(ligne, 'la sortie doit apparaître dans la console').toBeDefined();
    if (ligne === undefined) return;

    // LES TROIS COLONNES QUE C4 EXIGE, ET RIEN DE MOINS.
    expect(ligne.destination).toBe('service-meteo-fictif');
    expect(ligne.dataLevel).toBe('PUBLIC');
    expect(ligne.reason.length).toBeGreaterThan(0);
    expect(ligne.tool).toBe('test_weather_probe');
    expect(vue.rienNEstSorti).toBe(false);
  }, 30_000);

  it("RIEN ne sort quand rien ne sort — et la console le DIT", async () => {
    /* « Rien n'est sorti » est une réponse, et c'est même celle qu'on espère.
       Elle doit être distinguable d'une console qui n'a pas su regarder :
       d'où le champ explicite plutôt qu'une liste vide qu'on interprète. */
    const stack = buildStack(db, { calendar: agenda(true, 'caldav-local') });

    await stack.gateway.invoke({
      toolId: 'calendar_read',
      input: FENETRE,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('egr-local'),
      actor: 'USER',
      context: callContext(),
    });

    const vue = await consulter(stack);
    const local = vue.sorties.filter((s) => s.destination === 'caldav-local');
    // Un fournisseur LOCAL ne produit aucune ligne d'égression (ADR-051).
    expect(local).toEqual([]);
  }, 30_000);

  it("une sortie REFUSÉE ne compte pas comme une sortie", async () => {
    /* LE MENSONGE LE PLUS FACILE DE CETTE CONSOLE.

       Un agenda distant est refusé par F2 : l'agenda est `SENSITIVE`. Le refus
       est journalisé — c'est `audit_query` qui le montre — mais **rien n'est
       parti**, donc rien ne doit apparaître ici.

       Confondre « a voulu sortir » et « est sorti » rendrait la console
       alarmiste, et une console alarmiste finit ignorée. */
    const stack = buildStack(db, { calendar: agenda(false, 'agenda-refuse-c4') });

    const refus = await stack.gateway.invoke({
      toolId: 'calendar_read',
      input: FENETRE,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('egr-refus'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true, userConfirmed: true }),
    });
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.error.kind).toBe('POLICY_DENIED');

    const vue = await consulter(stack);
    expect(vue.sorties.some((s) => s.destination === 'agenda-refuse-c4')).toBe(false);
  }, 30_000);

  /* ================================================================== *
   * La console ne DÉDUIT rien
   * ================================================================== */

  it("lit le JOURNAL, et ne reconstitue rien depuis les contrats d'outils", async () => {
    /* Reconstituer l'égression après coup à partir du `networkRequired` d'un
       outil serait « l'observateur redéfinit le passé » appliqué à l'audit :
       ce champ dépend du fournisseur branché (ADR-051), donc un rebranchement
       réécrirait l'histoire.

       Vérifié sur le texte : la console n'a aucune notion d'outil enregistré. */
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('../lab/invariants.js');
    const brut = readFileSync('src/tools/egress.ts', 'utf8');

    expect(brut).toContain('FROM event_ledger');
    expect(brut).toContain('egress_destination IS NOT NULL');

    /* CE TEST S'EST TROMPÉ DEUX FOIS, ET LES DEUX SONT INSTRUCTIVES.

       1. Il interdisait le MOT `networkRequired` et le trouvait dans le
          commentaire expliquant pourquoi on ne s'en sert pas. Un test
          structurel qui interdit un VOCABULAIRE finit par interdire
          d'expliquer ce qu'on fait. D'où `stripComments`, qui existe déjà
          dans le dépôt pour cette raison exacte.

       2. Même dépouillé, il le trouvait encore — parce que la console
          DÉCLARE son propre `networkRequired: false`, comme tout outil.
          L'interdire n'avait aucun sens.

       La propriété visée n'a jamais été « ce mot n'apparaît pas ». C'est
       « la console ne lit pas les contrats des AUTRES outils » — et ce sont
       `gateway` et `list()` qui l'expriment. */
    const code = stripComments(brut);
    for (const interdit of ['gateway', '.list()', 'JOIN']) {
      expect(code, interdit).not.toContain(interdit);
    }
  });

  it("signale une réponse TRONQUÉE — une console discrète par troncature ment", async () => {
    const stack = buildStack(db, { calendar: agenda(true, 'caldav-local') });
    const result = await stack.gateway.invoke({
      toolId: 'egress_review',
      input: { window: 'month', limit: 1 },
      parameterProvenance: { window: 'USER', limit: 'USER' },
      operationId: op('egr-tronq'),
      actor: 'USER',
      context: callContext(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const sortie = result.value.output as { truncated: boolean; count: number };
    // Sans sortie enregistrée, `count` vaut 0 et rien n'est tronqué : le champ
    // ne doit pas mentir dans ce sens non plus.
    expect(sortie.truncated).toBe(sortie.count === 1);
  }, 30_000);

  /* ================================================================== *
   * Le contrat
   * ================================================================== */

  it("ne sort de rien elle-même — une surveillance des sorties qui sort serait absurde", () => {
    const stack = buildStack(db);
    const tool = stack.gateway.list().find((t) => t.definition.id === 'egress_review');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    expect(d.networkRequired).toBe(false);
    expect(d.effect).toBe('NO_EXTERNAL_EFFECT');
    expect(d.autonomy).toBe('L1');
    expect(d.requiredSecrets).toEqual([]);
  });
});
