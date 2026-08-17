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

  it("déclare `networkRequired` même avec un fournisseur LOCAL — pire cas assumé", async () => {
    /* `egress` est dérivé de `networkRequired` (gateway.ts:801). L'outil ne
       PEUT PAS savoir si l'appel quitte la machine : cela dépend du
       fournisseur branché, connu seulement à l'exécution.

       Un contrat statique devant une inconnue déclare le PIRE CAS. Le refus
       en mode privé avec un agenda local est un refus faux, et c'est le bon
       sens du compromis : l'erreur inverse laisserait un agenda partir sans
       que le Gate le voie. */
    const stack = buildStack(db, { calendar: fauxAgenda({ local: true }) });
    const tool = stack.gateway.list().find((t) => t.definition.id === 'calendar_read');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    expect(tool.definition.networkRequired).toBe(true);
    /* Et l'outil rapporte quand même la vérité observée à l'exécution : le
       contrat est pessimiste, le rapport est exact. Les deux coexistent. */
    const lu = await lire(stack);
    expect(lu.ok).toBe(true);
    if (!lu.ok) return;
    expect(lu.output['local']).toBe(true);
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
    expect(d.networkRequired).toBe(true);
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

  it("est REFUSÉ par défaut : hors autorisation d'égression, l'agenda ne se lit pas", async () => {
    /* La posture par défaut du système est « pas de sortie » : `callContext()`
       rend `cloudEnabled: false`, et la politique dure interdit
       `egress == true && cloudEnabled == false`.

       C'est fail-closed, et c'est bien. On le fixe par un test pour que
       personne ne desserre la vis sans s'en apercevoir. */
    const stack = buildStack(db, { calendar: fauxAgenda({ events: [EVENEMENT] }) });
    const result = await stack.gateway.invoke({
      toolId: 'calendar_read',
      input: FENETRE,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('cal-defaut'),
      actor: 'USER',
      context: callContext(), // posture par défaut : aucune sortie autorisée
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('POLICY_DENIED');
  }, 30_000);

  it("DÉFAUT DE MODÉLISATION : un agenda LOCAL exige quand même `cloudEnabled`", async () => {
    /* LE RÉSULTAT LE PLUS INTÉRESSANT DE CE FICHIER, ET IL N'EST PAS
       RÉPARABLE DANS L'OUTIL.

       Le fournisseur ci-dessous est LOCAL : `capabilities.local === true`,
       aucune donnée ne quitte la machine. Et pourtant il faut activer le
       cloud pour le lire.

       La cause : le modèle a UN booléen là où il y a DEUX questions.

         `networkRequired`  — l'appel quitte-t-il le PROCESSUS ?
         (manquant)         — la destination est-elle hors de la MACHINE ?

       `egress` est dérivé du premier (`gateway.ts:801`) et confronté à un
       interrupteur nommé `cloudEnabled`. Un CalDAV sur 127.0.0.1 sort du
       processus sans sortir de la machine : le modèle ne sait pas le dire.

       Les deux issues sont mauvaises et c'est ce qui rend le défaut
       structurel :
         — déclarer `networkRequired: false` ferait sortir un agenda CLOUD
           sans que le Gate le voie ;
         — déclarer `true` force l'utilisateur à laisser `cloudEnabled` armé
           pour un usage quotidien — et un interrupteur de sûreté qu'il faut
           désarmer pour se servir de la machine cesse d'être un interrupteur
           de sûreté.

       `ProviderCapabilities.local` porte déjà la réponse. Ce qui manque est
       le composant qui croise les deux : le Data Firewall de `docs/02`
       Phase 4 (« classification, redaction, DÉCISION D'ÉGRESSION »).

       Ce test ne demande pas de correction — il DATE le constat et échouera
       le jour où le Data Firewall le rendra faux. C'est exactement ce qu'on
       veut d'une zone d'ombre : qu'elle se signale quand elle disparaît. */
    const agendaLocal = fauxAgenda({ local: true, events: [EVENEMENT] });
    expect(agendaLocal.capabilities.local).toBe(true);

    const stack = buildStack(db, { calendar: agendaLocal });

    const sansCloud = await stack.gateway.invoke({
      toolId: 'calendar_read',
      input: FENETRE,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('cal-local-sans'),
      actor: 'USER',
      context: callContext({ cloudEnabled: false }),
    });
    expect(sansCloud.ok).toBe(false);

    const avecCloud = await stack.gateway.invoke({
      toolId: 'calendar_read',
      input: FENETRE,
      parameterProvenance: { fromIso: 'USER', toIso: 'USER' },
      operationId: op('cal-local-avec'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true }),
    });
    expect(avecCloud.ok).toBe(true);
  }, 30_000);
});
