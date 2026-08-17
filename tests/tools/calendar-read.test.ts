/**
 * `calendar_read` — Phase 3, point 2 de `docs/02`.
 *
 * Premier outil du dépôt qui dépend d'un système que nous ne possédons pas.
 * Tout ce fichier tient dans une phrase :
 *
 *   > Un agenda vide et un agenda inaccessible se ressemblent, et se
 *   > racontent différemment.
 *
 * « Tu n'as rien aujourd'hui » quand le fournisseur est injoignable est un
 * énoncé FAUX sur le monde — sans exception levée, sans erreur visible, sans
 * rien qui alerte. C'est la règle 3 dans sa forme la plus discrète.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { err, ok, jarvisError, type Result } from '../../src/core/types/result.js';
import type { CalendarEvent, CalendarProvider } from '../../src/providers/contract.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

/**
 * Doublure d'agenda. Elle N'EST PAS un adaptateur : aucun backend n'est
 * choisi (`docs/04` — une dépendance se justifie avant d'exister). Elle sert
 * à éprouver le CONTRAT `CalendarProvider`, qui est ce que l'outil connaît.
 */
function fauxAgenda(options: {
  events?: readonly CalendarEvent[];
  panne?: boolean;
  local?: boolean;
  id?: string;
}): CalendarProvider {
  return {
    capabilities: {
      id: options.id ?? 'agenda-doublure',
      local: options.local ?? true,
      requiresNetwork: !(options.local ?? true),
      maxPrivacyClass: 'ORANGE',
      costPerMillionTokensEur: 0,
    },
    health: () => Promise.resolve(ok({ available: options.panne !== true })),
    listEvents: (): Promise<Result<readonly CalendarEvent[]>> =>
      Promise.resolve(
        options.panne === true
          ? err(jarvisError('PROVIDER_UNAVAILABLE', 'agenda injoignable'))
          : ok(options.events ?? []),
      ),
    createEvent: () =>
      Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre de ce test'))),
    updateEvent: () =>
      Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre de ce test'))),
    verifyEvent: () =>
      Promise.resolve(err(jarvisError('INTERNAL', 'hors périmètre de ce test'))),
  };
}

const FENETRE = {
  fromIso: '2026-08-16T00:00:00.000Z',
  toIso: '2026-08-16T23:59:59.000Z',
};

const EVENEMENT: CalendarEvent = {
  id: 'evt-1',
  title: 'Point hebdomadaire',
  startsAt: '2026-08-16T09:00:00.000Z',
  endsAt: '2026-08-16T10:00:00.000Z',
};

describe.runIf(enabled)('calendar_read — Phase 3 point 2', () => {
  let db: Db;

  beforeAll(() => {
    db = appDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function lire(
    stack: Stack,
    input: Record<string, unknown> = FENETRE,
  ): Promise<
    | { ok: true; output: Record<string, unknown> }
    | { ok: false; kind: string; message: string }
  > {
    const result = await stack.gateway.invoke({
      toolId: 'calendar_read',
      input,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('cal-read'),
      actor: 'USER',
      /* `cloudEnabled: true` — ET C'EST LE DÉFAUT DE MODÉLISATION QUE CE
         FICHIER A MIS AU JOUR. Voir le dernier test : lire un agenda LOCAL
         exige aujourd'hui d'activer le cloud. */
      context: callContext({ cloudEnabled: true }),
    });
    if (!result.ok) {
      return { ok: false, kind: result.error.kind, message: result.error.message };
    }
    return { ok: true, output: result.value.output as Record<string, unknown> };
  }

  /* ================================================================== *
   * LA PROPRIÉTÉ CENTRALE
   * ================================================================== */

  it("SANS fournisseur : échoue par PROVIDER_UNAVAILABLE, et ne rend PAS un agenda vide", async () => {
    /* LE TEST QUI JUSTIFIE L'OUTIL.

       Rendre `{ events: [] }` serait syntaxiquement correct, ne lèverait
       aucune exception, et affirmerait « tu n'as rien » sur une journée dont
       on ne sait rien. Un mensonge sans erreur — et le seul mode de panne
       qu'aucun test de type ne peut attraper. */
    const stack = buildStack(db); // aucun agenda : l'état RÉEL du dépôt
    const lu = await lire(stack);

    expect(lu.ok).toBe(false);
    if (lu.ok) return;
    expect(lu.kind).toBe('PROVIDER_UNAVAILABLE');
    // Et le refus NOMME la distinction, parce que c'est elle qui compte.
    expect(lu.message).toContain('vide');
  }, 30_000);

  it("fournisseur EN PANNE : l'erreur remonte, elle n'est pas convertie en agenda vide", async () => {
    /* Le même défaut une couche plus bas — et cette fois avec un fournisseur
       configuré, donc sans le moindre indice pour l'utilisateur. */
    const stack = buildStack(db, { calendar: fauxAgenda({ panne: true }) });
    const lu = await lire(stack);

    expect(lu.ok).toBe(false);
    if (lu.ok) return;
    expect(lu.kind).toBe('PROVIDER_UNAVAILABLE');
  }, 30_000);

  it('un agenda RÉELLEMENT vide se distingue des deux cas précédents', async () => {
    /* Le contrôle négatif indispensable : si l'outil échouait aussi ici, les
       deux tests ci-dessus seraient verts pour une mauvaise raison — il
       suffirait de toujours échouer. */
    const stack = buildStack(db, { calendar: fauxAgenda({ events: [] }) });
    const lu = await lire(stack);

    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    expect(lu.output['count']).toBe(0);
    expect(lu.output['events']).toEqual([]);
  }, 30_000);

  /* ================================================================== *
   * Ce que l'outil rapporte
   * ================================================================== */

  it("rend les événements du fournisseur, sans les reformuler", async () => {
    const stack = buildStack(db, { calendar: fauxAgenda({ events: [EVENEMENT] }) });
    const lu = await lire(stack);

    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    expect(lu.output['count']).toBe(1);
    expect(lu.output['events']).toEqual([
      {
        id: EVENEMENT.id,
        title: EVENEMENT.title,
        startsAt: EVENEMENT.startsAt,
        endsAt: EVENEMENT.endsAt,
      },
    ]);
  }, 30_000);

  it('NOMME la source : deux agendas ne répondent pas la même chose', async () => {
    /* Sans ce champ, « tu as trois rendez-vous » ne dit pas de quel agenda —
       et le jour où deux fournisseurs coexistent, la réponse devient
       ininterprétable rétroactivement, y compris dans le journal. */
    const stack = buildStack(db, {
      calendar: fauxAgenda({ id: 'caldav-maison', local: true, events: [EVENEMENT] }),
    });
    const lu = await lire(stack);

    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    expect(lu.output['source']).toBe('caldav-maison');
    expect(lu.output['local']).toBe(true);
  }, 30_000);

  it('REFUSE une fenêtre inversée plutôt que de rendre un vide trompeur', async () => {
    const stack = buildStack(db, { calendar: fauxAgenda({ events: [EVENEMENT] }) });
    const lu = await lire(stack, { fromIso: FENETRE.toIso, toIso: FENETRE.fromIso });

    expect(lu.ok).toBe(false);
    if (lu.ok) return;
    expect(lu.kind).toBe('VALIDATION');
  }, 30_000);

  /* ================================================================== *
   * Le contrat déclaré, et le pessimisme assumé sur `egress`
   * ================================================================== */

  it("un fournisseur LOCAL ne déclare AUCUNE égression ; un fournisseur cloud si", () => {
    /* CE TEST A CHANGÉ DE SENS, ET C'EST LE RÉSULTAT DE F2.

       Il affirmait le contraire : « déclare `networkRequired` même avec un
       fournisseur LOCAL — pire cas assumé ». Le contrat était statique, il ne
       pouvait pas savoir où va l'appel, il déclarait le pire.

       Ce pessimisme est devenu intenable quand le Data Firewall a appliqué
       `docs/14 §5` : agenda = `SENSITIVE`, donc `egress` interdit, donc
       l'outil définitivement refusé même sur un CalDAV local.

       La décision est prise au BRANCHEMENT, seul endroit où l'information
       existe (ADR-051). */
    const local = buildStack(db, { calendar: fauxAgenda({ local: true }) });
    const localTool = local.gateway.list().find((t) => t.definition.id === 'calendar_read');
    expect(localTool?.definition.networkRequired).toBe(false);

    const cloud = buildStack(db, { calendar: fauxAgenda({ local: false }) });
    const cloudTool = cloud.gateway.list().find((t) => t.definition.id === 'calendar_read');
    expect(cloudTool?.definition.networkRequired).toBe(true);
  }, 30_000);

  it("se déclare sans effet externe : une lecture ne change rien, y compris chez le fournisseur", () => {
    const stack = buildStack(db, { calendar: fauxAgenda({}) });

    const tool = stack.gateway.list().find((t) => t.definition.id === 'calendar_read');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    /* `NO_EXTERNAL_EFFECT` décrit l'EFFET, `networkRequired` décrit le TRAJET.
       Les confondre ferait d'un outil réseau un outil mutant, ou l'inverse. */
    expect(d.effect).toBe('NO_EXTERNAL_EFFECT');
    /* `NO_EXTERNAL_EFFECT` décrit l'EFFET, `networkRequired` le TRAJET — et le
       trajet dépend désormais du fournisseur branché (ADR-051). Ici il est
       local, donc rien ne sort. */
    expect(d.networkRequired).toBe(false);
    /* La CATÉGORIE, elle, ne dépend d'aucun branchement : un agenda est un
       agenda. `docs/14 §2` la classe SENSITIVE, et c'est ce qui interdit sa
       sortie quand il y en a une. */
    expect(d.dataCategory).toBe('CALENDAR');
    // `docs/03 §118` place « consulter l'agenda » en L1. Ce n'est pas déduit.
    expect(d.autonomy).toBe('L1');
    expect(d.reversible).toBe(false);
    expect(d.requiredSecrets).toEqual([]);
  });

  it("l'outil EXISTE même sans fournisseur — une capacité absente se DIT", () => {
    /* Ne pas l'enregistrer serait une autre façon de mentir : l'utilisateur
       demanderait son agenda et Jarvis répondrait qu'il ne sait pas faire,
       alors qu'il sait faire et qu'il lui manque un branchement. La
       distinction est celle du dépôt depuis le début — « CAPACITÉ ABSENTE
       (dit) ». */
    const stack = buildStack(db);
    const ids = stack.gateway.list().map((t) => t.definition.id);
    expect(ids).toContain('calendar_read');
  });

  /* ================================================================== *
   * CE QUE LA MESURE A RÉVÉLÉ — et qui n'est pas réparable ici
   * ================================================================== */

  it("un agenda LOCAL se lit SANS activer le cloud — la zone d'ombre est fermée", async () => {
    /* `docs/26 §4.5` DISPARAÎT ICI, et le test qui la portait avait annoncé sa
       propre fin :

         « Ce test ne demande pas de correction — il DATE le constat et
           échouera le jour où le Data Firewall le rendra faux. C'est
           exactement ce qu'on veut d'une zone d'ombre : qu'elle se signale
           quand elle disparaît. »

       Il a échoué. Le voici retourné en preuve : un fournisseur dont
       `capabilities.local === true` ne déclare aucune égression, donc la
       politique dure `egress && !cloudEnabled` ne s'applique pas, donc
       l'agenda se lit dans la posture par DÉFAUT. */
    const stack = buildStack(db, { calendar: fauxAgenda({ local: true, events: [EVENEMENT] }) });
    const result = await stack.gateway.invoke({
      toolId: 'calendar_read',
      input: FENETRE,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('cal-local-defaut'),
      actor: 'USER',
      context: callContext({ cloudEnabled: false }), // posture par défaut
    });
    expect(result.ok).toBe(true);
  }, 30_000);

  it("§6.4 — un agenda CLOUD est refusé, MÊME cloud activé", async () => {
    /* LE TEST QUE `docs/14 §6` DÉSIGNE COMME LE PLUS IMPORTANT :

         « une donnée SENSITIVE n'atteint aucun palier cloud, MÊME SI tous les
           paliers locaux sont indisponibles — c'est celui qui prouve que le
           coût ne décide pas de la confidentialité. »

       Il n'était pas atteignable à F1, faute d'appelant. Il l'est maintenant.

       `cloudEnabled: true` ne suffit pas : l'agenda est `CALENDAR`, donc
       `SENSITIVE`, et `niveau ≥ SENSITIVE + egress → DENY` s'applique
       AVANT toute considération d'autorisation ou de disponibilité. */
    const stack = buildStack(db, { calendar: fauxAgenda({ local: false, events: [EVENEMENT] }) });
    const result = await stack.gateway.invoke({
      toolId: 'calendar_read',
      input: FENETRE,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('cal-cloud-refuse'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true, userConfirmed: true }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('POLICY_DENIED');
    expect(JSON.stringify(result.error)).toContain('SENSITIVE');
  }, 30_000);
});
