/**
 * I12 ET I13 — LA CONFIANCE ET LA PROVENANCE.
 *
 * `docs/22 §9` et §10, les deux derniers invariants candidats du mandat
 * Foundation 5.
 *
 *   I12  aucune action nouvelle après une violation détectée
 *   I13  tout état terminal possède une chaîne de provenance complète
 *
 * LES DEUX QUESTIONS AUXQUELLES JARVIS DOIT SAVOIR RÉPONDRE
 * ---------------------------------------------------------
 *   « Pourquoi affirmes-tu que c'est fait ? »
 *   « Pourquoi refuses-tu de recommencer ? »
 *
 * La seconde est celle qu'on oublie, et c'est celle qui exige que l'APPEL
 * lui-même soit journalisé — pas seulement son issue.
 *
 * Et ceci doit rester IMPOSSIBLE À PRODUIRE :
 *
 *   REQUEST → TIMEOUT → « probablement fait » → CONFIRMED
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { createHostileProvider } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import { createWorld, effectsFor, resetWorld, worldDb } from './world.js';
import type { Db } from '../../src/core/db/client.js';
import type { EffectContract } from '../../src/core/types/domain.js';

const enabled = databaseAvailable();

describe.runIf(enabled)('I12 · I13 — confiance et provenance', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(20);
    world = worldDb(10);
    await createWorld(world);
  });

  afterAll(async () => {
    await db.query("DELETE FROM tool_operations WHERE tool_id LIKE 'lab\\_%'");
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);
    // Chaque scénario part d'une confiance intacte : I12 est GLOBAL par outil,
    // et un résidu de test ferait échouer le suivant pour une mauvaise raison.
    await db.query("DELETE FROM tool_operations WHERE tool_id LIKE 'lab\\_%'");
  });

  function stack(options: { id: string; contract?: EffectContract; reallyIdempotent?: boolean }) {
    const provider = createHostileProvider(world, {
      id: `prov-${options.id}`,
      behaviour: { kind: 'NORMAL' },
      timing: 'BEFORE_RESPONSE',
      latencyMs: 5,
      ...(options.reallyIdempotent === undefined
        ? {}
        : { reallyIdempotent: options.reallyIdempotent }),
    });
    const built = buildLabStack(db);
    built.register(
      createHostileTool({
        id: options.id,
        provider,
        world,
        timeoutMs: 300,
        ...(options.contract === undefined ? {} : { effectContract: options.contract }),
      }),
    );
    return { ...built, provider };
  }

  /* ================================================================== *
   * I12 — aucune action nouvelle sur une information compromise
   * ================================================================== */

  it(
    "I12 — après une rupture de contrat, plus AUCUNE action nouvelle par ce service",
    async () => {
      const outil = 'lab_i12_bloque';
      const s = stack({
        id: outil,
        contract: 'PROVIDER_IDEMPOTENT',
        reallyIdempotent: false,
      });

      // (1) une opération normale.
      const premiere = labKey('i12-premiere');
      const avant = await s.gateway.invoke(labCall(premiere, { toolId: outil }));
      expect(avant.ok).toBe(true);

      // (2) le fournisseur double, et la violation est constatée.
      await s.provider.send(premiere, 'doublon byzantin');
      await s.provider.settle();
      const constat = await s.gateway.invoke(labCall(premiere, { toolId: outil }));
      expect(constat.ok).toBe(true);
      if (!constat.ok) return;
      expect(constat.value.status).toBe('PROVIDER_CONTRACT_VIOLATION');

      // (3) UNE ACTION NOUVELLE, sur une clé neuve : elle doit être refusée.
      const suivante = labKey('i12-suivante');
      const apres = await s.gateway.invoke(labCall(suivante, { toolId: outil }));

      expect(apres.ok).toBe(false);
      if (apres.ok) return;
      expect(apres.error.kind).toBe('PROVIDER_TRUST_REVOKED');
      expect(apres.error.message).toContain("Rien n'a été tenté");

      /* LA PREUVE QUE RIEN N'A ÉTÉ TENTÉ — et j'avais d'abord écrit la
         mauvaise. J'exigeais qu'AUCUNE ligne n'existe. La mesure a montré
         qu'une ligne `PLANNED` subsiste, l'inscription d'intention précédant
         la garde.

         En y regardant, c'est mieux ainsi, et l'assertion juste est plus
         forte que celle que je cherchais : l'intention EST enregistrée — elle
         a bien existé — et l'état prouve que rien n'a suivi.

           state    = PLANNED   aucune barrière de durabilité franchie
           attempts = 0         aucun appel n'est jamais parti
           status   = NULL      aucun verdict prononcé

         Et la conséquence est désirable : si la confiance est un jour
         rétablie, l'opération repart de son intention intacte plutôt que
         d'être perdue. */
      const effets = await effectsFor(world, suivante);
      expect(effets).toHaveLength(0);

      const trace = await db.query<{
        state: string;
        attempts: number;
        status: string | null;
      }>(
        'SELECT state, attempts, status FROM tool_operations WHERE operation_id = $1',
        [suivante],
      );
      expect(trace.ok).toBe(true);
      if (!trace.ok) return;
      const ligne = trace.value.rows[0];
      expect(ligne?.state).toBe('PLANNED');
      expect(ligne?.attempts).toBe(0);
      expect(ligne?.status).toBeNull();
    },
    30_000,
  );

  it(
    "I12 — le refus est JOURNALISÉ, et il n'affirme rien sur l'action",
    async () => {
      const outil = 'lab_i12_journal';
      const s = stack({
        id: outil,
        contract: 'PROVIDER_IDEMPOTENT',
        reallyIdempotent: false,
      });

      const premiere = labKey('i12j-premiere');
      await s.gateway.invoke(labCall(premiere, { toolId: outil }));
      await s.provider.send(premiere, 'doublon');
      await s.provider.settle();
      await s.gateway.invoke(labCall(premiere, { toolId: outil }));

      const suivante = labKey('i12j-suivante');
      await s.gateway.invoke(labCall(suivante, { toolId: outil }));

      const events = await db.query<{ event_type: string; status: string }>(
        'SELECT event_type, status FROM event_ledger WHERE operation_id = $1',
        [suivante],
      );
      expect(events.ok).toBe(true);
      if (!events.ok) return;

      const bloque = events.value.rows.filter((r) =>
        r.event_type.endsWith('_TRUST_BLOCKED'),
      );
      expect(bloque).toHaveLength(1);

      /* `NOT_ATTEMPTED`, et surtout pas `FAILED`. On n'a pas essayé et raté :
         on a délibérément renoncé. Confondre les deux ferait croire à un
         problème de l'action alors que le problème est celui qui la
         rapporte. */
      expect(bloque[0]?.status).toBe('NOT_ATTEMPTED');
    },
    30_000,
  );

  it(
    "I12 — mais l'OBSERVATION reste possible : on a plus besoin de comprendre, pas moins",
    async () => {
      /* Le contre-exemple que j'ai cherché contre ma propre correction : si le
         refus était posé trop haut dans le Gateway, il bloquerait aussi la
         RELECTURE d'une opération existante.

         Ce serait une faute grave et discrète — après une rupture de
         confiance, l'opérateur a besoin de lire ce qui s'est passé. Un
         système qui se ferme au moment où il faut l'auditer est pire qu'un
         système qui n'a pas de garde du tout. */
      const outil = 'lab_i12_lecture';
      const s = stack({
        id: outil,
        contract: 'PROVIDER_IDEMPOTENT',
        reallyIdempotent: false,
      });

      const key = labKey('i12-lecture');
      await s.gateway.invoke(labCall(key, { toolId: outil }));
      await s.provider.send(key, 'doublon');
      await s.provider.settle();
      await s.gateway.invoke(labCall(key, { toolId: outil }));

      // Relire la MÊME opération : autorisé, et le verdict est toujours lisible.
      const relecture = await s.gateway.invoke(labCall(key, { toolId: outil }));
      expect(relecture.ok).toBe(true);
      if (!relecture.ok) return;
      expect(relecture.value.status).toBe('PROVIDER_CONTRACT_VIOLATION');
      expect(relecture.value.replayed).toBe(true);
    },
    30_000,
  );

  it(
    "I12 — la rupture est cantonnée à l'outil fautif, pas à tout le système",
    async () => {
      /* Une garde qui bloquerait TOUT après une seule violation serait un
         déni de service offert au premier fournisseur qui a un bogue. La
         confiance se perd par SOURCE. */
      const fautif = 'lab_i12_fautif';
      const sain = 'lab_i12_sain';

      const a = stack({ id: fautif, contract: 'PROVIDER_IDEMPOTENT', reallyIdempotent: false });
      const key = labKey('i12-portee');
      await a.gateway.invoke(labCall(key, { toolId: fautif }));
      await a.provider.send(key, 'doublon');
      await a.provider.settle();
      await a.gateway.invoke(labCall(key, { toolId: fautif }));

      // L'autre outil, dont le fournisseur n'a rien fait de mal, continue.
      const b = stack({ id: sain });
      const autre = await b.gateway.invoke(labCall(labKey('i12-sain'), { toolId: sain }));
      expect(autre.ok).toBe(true);
    },
    30_000,
  );

  it(
    "I12 — la confiance se RÉTABLIT, mais seulement par un acte HUMAIN",
    async () => {
      /* Sans ce chemin, une seule violation condamnerait l'outil pour
         toujours : un bogue de fournisseur, corrigé le lendemain, laisserait
         Jarvis muet définitivement. Le mandat demande de DÉGRADER la
         confiance, pas de la détruire.

         Et la garde qui donne son sens au mécanisme : Jarvis ne peut pas se
         rendre à lui-même une confiance qu'un constat lui a retirée. */
      const outil = 'lab_i12_retablir';
      const s = stack({
        id: outil,
        contract: 'PROVIDER_IDEMPOTENT',
        reallyIdempotent: false,
      });

      const premiere = labKey('i12r-premiere');
      await s.gateway.invoke(labCall(premiere, { toolId: outil }));
      await s.provider.send(premiere, 'doublon');
      await s.provider.settle();
      await s.gateway.invoke(labCall(premiere, { toolId: outil }));

      // Bloqué, comme attendu.
      const bloque = await s.gateway.invoke(
        labCall(labKey('i12r-bloquee'), { toolId: outil }),
      );
      expect(bloque.ok).toBe(false);

      /* JARVIS NE PEUT PAS SE RÉTABLIR LUI-MÊME. */
      const parJarvis = await s.gateway.restoreTrust(outil, 'JARVIS', 'je me pardonne');
      expect(parJarvis.ok).toBe(false);
      if (!parJarvis.ok) expect(parJarvis.error.kind).toBe('POLICY_DENIED');

      // Et un rétablissement sans motif n'est pas auditable : refusé aussi.
      const sansMotif = await s.gateway.restoreTrust(outil, 'USER', '   ');
      expect(sansMotif.ok).toBe(false);

      /* L'ACTE HUMAIN, MOTIVÉ. */
      const parHumain = await s.gateway.restoreTrust(
        outil,
        'USER',
        'fournisseur corrigé en version 2.1, idempotence vérifiée',
      );
      expect(parHumain.ok).toBe(true);

      const apres = await s.gateway.invoke(
        labCall(labKey('i12r-apres'), { toolId: outil }),
      );
      expect(apres.ok).toBe(true);

      /* ET LE RÉTABLISSEMENT EST JOURNALISÉ. Personne ne doit pouvoir rendre
         une confiance en silence — c'est la décision la plus lourde du
         mécanisme, et l'audit doit pouvoir la retrouver. */
      const events = await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM event_ledger
          WHERE tool = $1 AND event_type LIKE '%\\_TRUST\\_RESTORED'`,
        [outil],
      );
      expect(events.ok).toBe(true);
      if (events.ok) expect(Number(events.value.rows[0]?.n ?? '0')).toBe(1);
    },
    30_000,
  );

  /* ================================================================== *
   * I13 — remonter du monde extérieur jusqu'à l'intention
   * ================================================================== */

  it(
    "I13 — depuis un effet du MONDE, la chaîne remonte jusqu'à l'intention",
    async () => {
      /* Le test que `docs/22 §10` demande, littéralement : partir d'une ligne
         de `lab_world_effects` et reconstruire la chaîne complète — puis
         vérifier qu'aucun maillon n'est DÉDUIT plutôt que LU. */
      const outil = 'lab_i13_chaine';
      const s = stack({ id: outil });
      const key = labKey('i13-chaine');

      await s.gateway.invoke(labCall(key, { toolId: outil }));
      await s.provider.settle();

      /* ── Maillon 1 : LE MONDE. On part d'ici, et de rien d'autre. ────── */
      const effets = await effectsFor(world, key);
      expect(effets).toHaveLength(1);
      const clef = key; // l'effet porte lui-même la clé d'opération

      /* ── Maillon 2 : L'OPÉRATION, lue au registre ────────────────────── */
      const operation = await db.query<{
        operation_id: string;
        tool_id: string;
        state: string;
        status: string;
        attempts: number;
        lease_generation: number;
        actor: string;
      }>(
        `SELECT operation_id, tool_id, state, status, attempts,
                lease_generation, actor
           FROM tool_operations WHERE operation_id = $1`,
        [clef],
      );
      expect(operation.ok).toBe(true);
      if (!operation.ok) return;
      const op = operation.value.rows[0];
      expect(op).toBeDefined();
      if (op === undefined) return;

      /* ── Maillon 3 : LE JOURNAL, append-only et chaîné ───────────────── */
      const events = await db.query<{ event_type: string; status: string; actor: string }>(
        'SELECT event_type, status, actor FROM event_ledger WHERE operation_id = $1 ORDER BY seq',
        [clef],
      );
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      const types = events.value.rows.map((r) => r.event_type);

      /* LA PROPRIÉTÉ. Deux instants doivent être LISIBLES et distincts :

           T3  la requête est PARTIE      → …_REQUEST_SENT
           T7  l'issue est CONNUE         → …_SEND

         Sans T3, « pourquoi refuses-tu de recommencer ? » n'a pour réponse
         qu'un état terminal, et rien ne dit qu'un appel a réellement quitté
         le processus. C'est le trou que `docs/22 §10` nommait. */
      expect(types.some((t) => t.endsWith('_REQUEST_SENT'))).toBe(true);
      expect(types.length).toBeGreaterThanOrEqual(2);

      // Et l'ORDRE est lu, pas supposé : la requête précède l'issue.
      const iRequest = types.findIndex((t) => t.endsWith('_REQUEST_SENT'));
      const iOutcome = types.length - 1;
      expect(iRequest).toBeLessThan(iOutcome);

      /* ── Maillon 4 : L'INTENTION — acteur et outil, lus au registre ──── */
      expect(op.actor).toBe('USER');
      expect(op.tool_id).toBe(outil);

      /* AUCUN MAILLON N'EST DÉDUIT. Chacun a été LU dans une table :
           le monde        → lab_world_effects
           l'opération     → tool_operations
           l'appel         → event_ledger (…_REQUEST_SENT)
           l'autorité      → tool_operations.lease_generation
           l'intention     → tool_operations.actor */
      expect(op.lease_generation).toBeGreaterThanOrEqual(1);
      expect(op.attempts).toBe(1);
    },
    30_000,
  );

  it(
    'I13 — « REQUEST → TIMEOUT → probablement fait → CONFIRMED » reste IMPOSSIBLE',
    async () => {
      /* La séquence que `docs/22 §10` déclare impossible à produire. Elle est
         éprouvée ici de bout en bout plutôt qu'affirmée. */
      const outil = 'lab_i13_timeout';
      const provider = createHostileProvider(world, {
        id: 'prov-i13-timeout',
        behaviour: { kind: 'TIMEOUT' },
        timing: 'NEVER',
        latencyMs: 5,
      });
      const built = buildLabStack(db);
      built.register(
        createHostileTool({ id: outil, provider, world, timeoutMs: 150 }),
      );

      const key = labKey('i13-timeout');
      const result = await built.gateway.invoke(labCall(key, { toolId: outil }));
      await provider.settle();

      // Jamais CONFIRMED. Et le registre le confirme indépendamment du retour.
      if (result.ok) expect(result.value.status).not.toBe('CONFIRMED');

      const row = await db.query<{ status: string | null; state: string }>(
        'SELECT status, state FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (!row.ok) return;
      expect(row.value.rows[0]?.status).not.toBe('CONFIRMED');

      /* Et le JOURNAL non plus — c'est là que la fraude serait indétectable
         si elle passait, puisque c'est lui que lit l'audit. */
      const events = await db.query<{ status: string }>(
        'SELECT status FROM event_ledger WHERE operation_id = $1',
        [key],
      );
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.value.rows.some((r) => r.status === 'CONFIRMED')).toBe(false);
    },
    30_000,
  );

  it(
    'I13 — LIMITE : une chaîne complète peut reposer sur une observation FAUSSE',
    async () => {
      /* `docs/22 §10`, contre-exemple cherché et assumé :

           « une chaîne complète et cohérente bâtie sur une observation
             elle-même erronée »

         La provenance prouve LE RAISONNEMENT, jamais LE MONDE. Un fournisseur
         qui ment produit une chaîne parfaitement valide menant à un verdict
         faux, et aucune quantité de traçabilité n'y change quoi que ce soit.

         Ce test ne demande pas de correction — il MESURE la limite pour
         qu'elle ne soit jamais présentée comme une garantie. */
      const outil = 'lab_i13_limite';
      const provider = createHostileProvider(world, {
        id: 'prov-i13-limite',
        behaviour: { kind: 'SUCCESS_WITHOUT_EFFECT' },
        timing: 'NEVER',
        latencyMs: 5,
      });
      const built = buildLabStack(db);
      built.register(
        createHostileTool({ id: outil, provider, world, timeoutMs: 300 }),
      );

      const key = labKey('i13-limite');
      await built.gateway.invoke(labCall(key, { toolId: outil }));
      await provider.settle();

      // La chaîne est COMPLÈTE : requête journalisée, issue journalisée.
      const events = await db.query<{ event_type: string }>(
        'SELECT event_type FROM event_ledger WHERE operation_id = $1 ORDER BY seq',
        [key],
      );
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(
        events.value.rows.some((r) => r.event_type.endsWith('_REQUEST_SENT')),
      ).toBe(true);

      /* Et pourtant le monde est VIDE. Le fournisseur a répondu `200` sans
         rien faire. La chaîne raconte fidèlement ce que Jarvis a fait et cru
         — elle ne dit rien de ce qui s'est réellement produit.

         Ce qui SAUVE ici n'est pas la provenance : c'est la relecture
         indépendante du monde, qui refuse de promouvoir le statut. */
      const effets = await effectsFor(world, key);
      expect(effets).toHaveLength(0);

      const row = await db.query<{ status: string | null }>(
        'SELECT status FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (row.ok) expect(row.value.rows[0]?.status).not.toBe('CONFIRMED');
    },
    30_000,
  );
});
