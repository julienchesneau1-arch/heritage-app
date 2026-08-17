/**
 * `reminder_create` — Phase 3, point 8 de `docs/02`.
 *
 * L'ARBITRAGE QUE CE FICHIER ÉPROUVE
 * -----------------------------------
 * Mesuré avant d'écrire l'outil : **aucun ordonnanceur, aucune minuterie,
 * aucun canal de notification** dans le dépôt. Rien ne peut faire sonner quoi
 * que ce soit.
 *
 *   > Un « rappel » qui ne sonne pas est un mensonge porté par son nom.
 *
 * C'est la règle 3 appliquée non pas à un effet mais à une PROMESSE — et c'est
 * la forme la plus difficile à repérer : rien n'échoue, rien ne s'affiche en
 * rouge, la déception arrive des heures plus tard.
 *
 * D'où les deux propriétés testées ici : l'outil DIT qu'il ne sonnera pas, et
 * le rappel apparaît réellement là où il a promis d'apparaître.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

const dans = (ms: number): string => new Date(Date.now() + ms).toISOString();

describe.runIf(enabled)('reminder_create — Phase 3 point 8', () => {
  let stack: Stack;
  let db: Db;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.query("DELETE FROM reminders WHERE text LIKE 'rap-%'");
  });

  async function creer(
    input: Record<string, unknown>,
  ): Promise<
    | { ok: true; op: string; status: string; output: Record<string, unknown> }
    | { ok: false; kind: string; message: string }
  > {
    const opId = op('rap');
    const result = await stack.gateway.invoke({
      toolId: 'reminder_create',
      input,
      parameterProvenance: { text: 'USER', remindAt: 'USER' },
      operationId: opId,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
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
   * LA PROMESSE NE MENT PAS
   * ================================================================== */

  it("DÉCLARE qu'il ne sonnera pas, au lieu de laisser croire le contraire", async () => {
    /* LE TEST QUI PORTE L'ARBITRAGE.

       Sans ces champs, l'utilisateur entend « rappel créé » et attend une
       sonnerie qui n'arrivera jamais. L'outil ne peut pas livrer la
       notification — il peut refuser de laisser croire qu'il le fera. */
    const cree = await creer({ text: `rap-${String(Date.now())}`, remindAt: dans(3_600_000) });

    expect(cree.ok).toBe(true);
    if (!cree.ok) return;
    expect(cree.status).toBe('CONFIRMED');
    expect(cree.output['delivery']).toBe('NONE');
    expect(String(cree.output['deliveryDetail'])).toContain('ne sonnera pas');
    expect(cree.output['surfacedIn']).toEqual(['briefing_generate']);
  }, 30_000);

  it("le rappel apparaît RÉELLEMENT là où il a promis d'apparaître", async () => {
    /* LA CONTREPARTIE INDISPENSABLE.

       Déclarer « je serai dans le briefing » et ne pas y être serait le même
       mensonge, déplacé d'un cran. La promesse est donc vérifiée là où elle
       est faite : dans le briefing. */
    /* ⚠ CE TEST NE PASSAIT QUE 23 HEURES SUR 24, ET C'EST LE PRODUIT QUI
         AVAIT RAISON.

       Il plaçait le rappel « dans une heure » et attendait de le voir dans le
       briefing. Or le briefing borne à `date_trunc('day', clock_timestamp())
       + 1 day` : entre 23 h et minuit, « dans une heure » tombe DEMAIN, donc
       hors fenêtre. Un rappel de demain absent du briefing d'aujourd'hui est
       le comportement CORRECT.

       Trouvé par accident à 23 h 11 UTC, pendant un balayage sans rapport.
       Il aurait été classé « flaky » par quiconque l'aurait croisé une fois.

       Le correctif applique la doctrine du dépôt (ADR-036/037) : **la fenêtre
       est calculée par la BASE**, jamais devinée par le processus. On demande
       à la base où finit la journée, et on place le rappel à l'intérieur. */
    const finDuJour = await db.query<{ fin: Date }>(
      `SELECT date_trunc('day', clock_timestamp()) + interval '1 day' AS fin`,
    );
    expect(finDuJour.ok).toBe(true);
    if (!finDuJour.ok) return;
    const fin = finDuJour.value.rows[0]?.fin;
    expect(fin, 'la base doit rendre la fin de journée').toBeDefined();
    if (fin === undefined) return;

    // Une heure plus tard, OU juste avant minuit s'il reste moins d'une heure.
    const dansUneHeure = Date.now() + 3_600_000;
    const avantMinuit = fin.getTime() - 60_000;
    const echeance = new Date(Math.min(dansUneHeure, avantMinuit)).toISOString();

    const texte = `rap-visible-${String(Date.now())}`;
    const cree = await creer({ text: texte, remindAt: echeance });
    expect(cree.ok, cree.ok ? '' : 'création refusée').toBe(true);

    const brief = await stack.gateway.invoke({
      toolId: 'briefing_generate',
      input: { limit: 50 },
      parameterProvenance: { limit: 'USER' },
      operationId: op('rap-brief'),
      actor: 'USER',
      context: callContext({ cloudEnabled: true }),
    });
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;

    const sortie = brief.value.output as {
      rappels: { etat: string; items: { text: string }[] };
    };
    expect(sortie.rappels.etat).toBe('OK');
    expect(sortie.rappels.items.some((r) => r.text === texte)).toBe(true);
  }, 30_000);

  /* ================================================================== *
   * L'horloge de la BASE tranche, pas celle du processus
   * ================================================================== */

  it("REFUSE une échéance déjà passée, plutôt que de créer un rappel inutile", async () => {
    /* Puisque rien ne sonne, un rappel créé dans le passé n'aurait aucune
       chance de servir — et l'accepter donnerait l'impression du contraire. */
    const passe = await creer({ text: `rap-${String(Date.now())}`, remindAt: dans(-3_600_000) });

    expect(passe.ok).toBe(false);
    if (passe.ok) return;
    expect(passe.kind).toBe('VALIDATION');
  }, 30_000);

  it("« déjà passé » est tranché par la BASE, pas par `Date.now()`", async () => {
    /* Leçon d'ADR-037, et elle compte doublement ici : l'échéance sera relue
       par le briefing, qui interroge lui aussi l'horloge de la base. Comparer
       à `Date.now()` créerait deux horloges pour un même fait — un rappel
       accepté comme futur par l'outil et déjà dépassé pour le briefing.

       On décale l'horloge du PROCESSUS d'un an en avant : une échéance à
       +1 heure paraît alors très passée à `Date.now()`, et reste future pour
       la base. L'outil doit accepter. */
    const echeance = dans(3_600_000);
    const real = Date.now.bind(Date);
    Date.now = () => real() + 365 * 24 * 3_600 * 1_000;
    try {
      const cree = await creer({ text: `rap-horloge-${String(real())}`, remindAt: echeance });
      expect(cree.ok).toBe(true);
    } finally {
      Date.now = real;
    }
  }, 30_000);

  /* ================================================================== *
   * Le contrat, et la dette qu'il crée
   * ================================================================== */

  it("capture de quoi être annulé — et l'outil inverse n'existe pas encore", async () => {
    /* ADR-019 l'autorise explicitement : « la capture est un enregistrement,
       pas une exécution ». Mais la dette se compte, et elle grandit :
       `reminder_cancel` est le CINQUIÈME outil inverse déclaré et non écrit,
       après `task_cancel`, `note_delete`, `memory_forget`, `calendar_delete`.
       L'Undo Engine devra les livrer ensemble. */
    const cree = await creer({ text: `rap-undo-${String(Date.now())}`, remindAt: dans(7_200_000) });
    expect(cree.ok).toBe(true);
    if (!cree.ok) return;

    const snap = await stack.snapshots.forOperation(cree.op);
    expect(snap.ok).toBe(true);
    if (!snap.ok || snap.value === null) throw new Error('aucune capture');
    expect(snap.value.undoKind).toBe('INVERSE_OPERATION');
    expect(snap.value.inverseToolId).toBe('reminder_cancel');
    expect(snap.value.resourceKind).toBe('reminder');
  }, 30_000);

  it('déclare un contrat de mutation locale, vérifiable par relecture', () => {
    const tool = stack.gateway.list().find((t) => t.definition.id === 'reminder_create');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    expect(d.autonomy).toBe('L2');
    expect(d.effect).toBe('LOCAL_TRANSACTIONAL');
    expect(d.verification).toBe('READ_BACK');
    // S6 : une mutation exige une clé d'opération.
    expect(d.idempotency).toBe('OPERATION_KEY');
    expect(d.networkRequired).toBe(false);
    /* L'heure d'un rappel dit quelque chose de la journée de l'utilisateur —
       même traitement que `dueAt` sur `task_create`. */
    expect(d.parameters.find((p) => p.name === 'remindAt')?.sensitive).toBe(true);
  });

  it("le même appel rejoué ne crée pas deux rappels", async () => {
    /* La clé d'opération est portée jusqu'en base : la contrainte d'unicité
       est la dernière barrière, après celle du Gateway. */
    const opId = op('rap-idem');
    const texte = `rap-idem-${String(Date.now())}`;
    const appel = {
      toolId: 'reminder_create',
      input: { text: texte, remindAt: dans(3_600_000) },
      parameterProvenance: { text: 'USER' as const, remindAt: 'USER' as const },
      operationId: opId,
      actor: 'USER' as const,
      context: callContext({ userConfirmed: true }),
    };
    const a = await stack.gateway.invoke(appel);
    const b = await stack.gateway.invoke(appel);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const compte = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM reminders WHERE text = $1',
      [texte],
    );
    expect(compte.ok).toBe(true);
    if (!compte.ok) return;
    expect(compte.value.rows[0]?.n).toBe('1');
  }, 30_000);
});
