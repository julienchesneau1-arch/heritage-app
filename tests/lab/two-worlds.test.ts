/**
 * LES DEUX MONDES — couches 04 et 05, `docs/22 §4`, §7, §9.
 *
 * Ce fichier est le premier du dépôt à pouvoir écrire une phrase que ni un
 * test unitaire ni le banc précédent ne savaient exprimer :
 *
 *   > Jarvis avait RAISON de dire `UNKNOWN` alors que l'effet avait
 *   > réellement eu lieu.
 *
 * Elle exige DEUX sources de vérité, et que l'une soit hors d'atteinte :
 *
 *       JARVIS                          LE BANC
 *   ─────────────────           ──────────────────────
 *   requête émise               request_received_at      t1
 *   réponse │ timeout           effect_started_at        t2
 *   HTTP 500 │ 429              effect_committed_at      t3
 *   connexion coupée            response_sent_at         t4 · delivered
 *
 * Jarvis n'a jamais accès à la colonne de droite. Le banc, si — et c'est ce
 * qui lui permet de juger l'HONNÊTETÉ de Jarvis plutôt que sa conformité à un
 * scénario écrit d'avance.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseAvailable } from '../helpers/db.js';
import { buildLabStack, labCall, labDb, labKey } from './harness.js';
import { createHostileProvider, type HostileBehaviour } from './hostile-provider.js';
import { createHostileTool } from './hostile-tool.js';
import {
  commitEffect,
  createWorld,
  externalEffectCount,
  groundTruth,
  providerTimeline,
  resetWorld,
  worldDb,
} from './world.js';
import { mayClaimSuccess } from '../../src/core/verification/engine.js';
import type { Db } from '../../src/core/db/client.js';
import type { EffectContract } from '../../src/core/types/domain.js';

const enabled = databaseAvailable();

/* OUTIL DÉDIÉ À CE FICHIER, et c'est une conséquence directe d'I12.

   La confiance se perd PAR OUTIL et se consigne dans un journal append-only :
   une violation mise en scène ici bloquerait durablement tout autre fichier du
   banc utilisant le même identifiant. Ce n'est pas une gêne de test, c'est la
   propriété qui fonctionne — et la mise en scène doit donc être cantonnée. */
const TOOL = 'lab_two_worlds';

describe.runIf(enabled)('couches 04-05 — les deux mondes', () => {
  let db: Db;
  let world: Db;

  beforeAll(async () => {
    db = labDb(20);
    world = worldDb(15);
    await createWorld(world);
  });

  afterAll(async () => {
    await db.query("DELETE FROM tool_operations WHERE tool_id LIKE 'lab\\_%'");
    await db.close();
    await world.close();
  });

  beforeEach(async () => {
    await resetWorld(world);

    /* RÉTABLISSEMENT EXPLICITE ENTRE SCÉNARIOS — et il fallait bien qu'il
       existe. Le scénario byzantin consigne une rupture de confiance dans un
       journal append-only ; sans acte humain de rétablissement, tous les
       scénarios suivants seraient refusés.

       C'est la propriété I12 qui fonctionne, pas une gêne de test. On l'exerce
       ici plutôt que de la contourner. */
    const admin = stack({ kind: 'NORMAL' });
    await admin.gateway.restoreTrust(
      TOOL,
      'USER',
      'réinitialisation du banc entre deux scénarios',
    );
  });

  /** Monte une pile dont le fournisseur a le comportement demandé. */
  function stack(
    behaviour: HostileBehaviour,
    options: {
      timing?: 'NEVER' | 'BEFORE_RESPONSE' | 'AFTER_RESPONSE';
      contract?: EffectContract;
      reallyIdempotent?: boolean;
      canVerifyAttempt?: boolean;
      timeoutMs?: number;
    } = {},
  ) {
    const provider = createHostileProvider(world, {
      id: 'deux-mondes',
      behaviour,
      timing: options.timing ?? 'BEFORE_RESPONSE',
      latencyMs: 5,
      ...(options.reallyIdempotent === undefined
        ? {}
        : { reallyIdempotent: options.reallyIdempotent }),
    });
    const built = buildLabStack(db);
    built.register(
      createHostileTool({
        id: TOOL,
        provider,
        world,
        timeoutMs: options.timeoutMs ?? 300,
        ...(options.contract === undefined ? {} : { effectContract: options.contract }),
        ...(options.canVerifyAttempt === undefined
          ? {}
          : { canVerifyAttempt: options.canVerifyAttempt }),
      }),
    );
    return { ...built, provider };
  }

  /* ================================================================== *
   * LA PHRASE QUE SEULS DEUX MONDES PERMETTENT
   * ================================================================== */

  it(
    "Jarvis a RAISON de dire UNKNOWN alors que l'effet a réellement eu lieu",
    async () => {
      /* `docs/22 §7`, ligne en gras : effet produit, réponse perdue.
         Depuis Jarvis, c'est indiscernable d'une situation où rien ne s'est
         produit. Le banc, lui, sait. */
      const key = labKey('deux-mondes-perdue');
      const s = stack({ kind: 'LOST_RESPONSE' }, { timing: 'BEFORE_RESPONSE' });

      const result = await s.gateway.invoke(labCall(key, { toolId: TOOL }));
      await s.provider.settle();

      /* ── CE QUE JARVIS SAIT ────────────────────────────────────────── */
      const vu = result.ok ? result.value.status : `erreur:${result.error.kind}`;

      /* ── CE QUE LE BANC SAIT ───────────────────────────────────────── */
      const verite = await groundTruth(world, key);

      // La vérité : le fournisseur a reçu, a produit l'effet, a répondu — et
      // sa réponse n'est jamais arrivée.
      expect(verite.requestsReceived).toBe(1);
      expect(verite.effectsCommitted).toBe(1);
      expect(verite.responsesSent).toBe(1);
      expect(verite.responsesDelivered).toBe(0);
      expect(await externalEffectCount(world, key)).toBe(1);

      /* LA PROPRIÉTÉ. Jarvis n'affirme pas le succès — et il a raison de ne
         pas l'affirmer, puisqu'il ne pouvait pas le savoir. Mais il n'affirme
         pas non plus l'échec, et c'est là que tout se joue : l'effet EXISTE.

         « Ce n'est pas observable » et « cela ne s'est pas produit » sont deux
         choses différentes (`docs/22 §5`). */
      expect(vu).not.toBe('CONFIRMED');
      expect(vu).not.toBe('FAILED');
    },
    30_000,
  );

  it(
    "l'absence d'événement n'est jamais un événement",
    async () => {
      /* `docs/22 §5`, corollaire opérationnel :

           REQUEST_SENT + aucune RESPONSE
               ≠  REQUEST_FAILED
               =  RESPONSE_UNKNOWN

         Deux scénarios que Jarvis voit IDENTIQUES, et que le banc distingue. */
      const jamaisRecue = labKey('deux-mondes-jamais');
      const recueNonTraitee = labKey('deux-mondes-recue');

      // (a) le fournisseur ne reçoit rien du tout : il est injoignable.
      const a = stack({ kind: 'TIMEOUT' }, { timing: 'NEVER', timeoutMs: 150 });
      const ra = await a.gateway.invoke(labCall(jamaisRecue, { toolId: TOOL }));

      // (b) le fournisseur REÇOIT, puis ne fait rien et ne répond pas.
      const b = stack({ kind: 'TIMEOUT' }, { timing: 'NEVER', timeoutMs: 150 });
      const rb = await b.gateway.invoke(labCall(recueNonTraitee, { toolId: TOOL }));

      // Jarvis voit la même chose dans les deux cas.
      const vuA = ra.ok ? ra.value.status : ra.error.kind;
      const vuB = rb.ok ? rb.value.status : rb.error.kind;
      expect(vuA).toBe(vuB);

      // Le banc, lui, les distingue — et c'est tout l'objet du second monde.
      const timelineB = await providerTimeline(world, recueNonTraitee);
      expect(timelineB).toHaveLength(1);
      expect(timelineB[0]?.requestReceivedAt).not.toBeNull();
      // Reçue, mais aucun effet ni réponse : les trois autres instants manquent.
      expect(timelineB[0]?.effectCommittedAt).toBeNull();
      expect(timelineB[0]?.responseSentAt).toBeNull();

      // Et dans les deux cas, aucun effet.
      expect(await externalEffectCount(world, jamaisRecue)).toBe(0);
      expect(await externalEffectCount(world, recueNonTraitee)).toBe(0);
    },
    30_000,
  );

  /* ================================================================== *
   * LA MATRICE DE VÉRITÉ — `docs/22 §7`
   *
   * Chaque ligne : ce qui s'est réellement passé, ce que Jarvis voit, et ce
   * qu'il a le DROIT de conclure. Les trois lignes en gras du document sont
   * celles où l'intuition se trompe.
   * ================================================================== */

  const MATRICE: readonly {
    readonly realite: string;
    readonly behaviour: HostileBehaviour;
    readonly timing: 'NEVER' | 'BEFORE_RESPONSE' | 'AFTER_RESPONSE';
    /** Statuts que Jarvis a le droit de rendre. Tout autre est un défaut. */
    readonly autorises: readonly string[];
    readonly effetAttendu: number;
  }[] = [
    {
      realite: 'aucune requête reçue — timeout',
      behaviour: { kind: 'TIMEOUT' },
      timing: 'NEVER',
      autorises: ['UNKNOWN', 'TIMEOUT'],
      effetAttendu: 0,
    },
    {
      realite: 'effet produit, réponse perdue',
      behaviour: { kind: 'LOST_RESPONSE' },
      timing: 'BEFORE_RESPONSE',
      autorises: ['UNKNOWN', 'PROVIDER_UNAVAILABLE', 'TIMEOUT'],
      effetAttendu: 1,
    },
    {
      realite: 'effet produit, réponse reçue',
      behaviour: { kind: 'NORMAL' },
      timing: 'BEFORE_RESPONSE',
      autorises: ['CONFIRMED'],
      effetAttendu: 1,
    },
    {
      realite: 'effet produit, puis réponse 500',
      behaviour: { kind: 'ERROR_AFTER_EFFECT' },
      timing: 'BEFORE_RESPONSE',
      autorises: ['UNKNOWN', 'PROVIDER_UNAVAILABLE'],
      effetAttendu: 1,
    },
    {
      realite: '429 avant tout traitement',
      behaviour: { kind: 'HTTP', status: 429 },
      timing: 'NEVER',
      autorises: ['UNKNOWN', 'PROVIDER_UNAVAILABLE'],
      effetAttendu: 0,
    },
    {
      realite: '200 sans effet métier',
      behaviour: { kind: 'SUCCESS_WITHOUT_EFFECT' },
      timing: 'NEVER',
      autorises: ['UNKNOWN', 'PROBABLE', 'FAILED'],
      effetAttendu: 0,
    },
  ];

  for (const ligne of MATRICE) {
    it(
      `matrice — ${ligne.realite}`,
      async () => {
        const key = labKey('matrice');
        const s = stack(ligne.behaviour, { timing: ligne.timing, timeoutMs: 200 });

        const result = await s.gateway.invoke(labCall(key, { toolId: TOOL }));
        await s.provider.settle();

        const vu = result.ok ? result.value.status : result.error.kind;
        expect(ligne.autorises).toContain(vu);

        // La réalité, mesurée dans le monde et non déduite de la réponse.
        expect(await externalEffectCount(world, key)).toBe(ligne.effetAttendu);

        /* LA RÈGLE QUI TRAVERSE TOUTE LA MATRICE : un succès ne s'annonce que
           sur preuve positive. Aucune ligne où l'effet est absent ou
           incertain ne doit permettre de dire « c'est fait ». */
        if (ligne.effetAttendu === 0 && result.ok) {
          expect(mayClaimSuccess(result.value.status)).toBe(false);
        }

        /* Et jamais `FAILED` quand un effet EXISTE — le mensonge le plus
           coûteux, et celui que I3 traque globalement. */
        if (ligne.effetAttendu > 0 && result.ok) {
          expect(result.value.status).not.toBe('FAILED');
        }
      },
      30_000,
    );
  }

  /* ================================================================== *
   * LE FOURNISSEUR BYZANTIN — `docs/22 §9`
   * ================================================================== */

  it(
    'BYZANTIN : deux effets sur une identité unique → PROVIDER_CONTRACT_VIOLATION',
    async () => {
      /* Le cas canonique. Un fournisseur DÉCLARÉ idempotent qui ne l'est pas.

         Classification honnête (`docs/22 §9`) :
           classe B  Jarvis ne peut PAS l'empêcher
           classe C  Jarvis peut le VOIR après coup

         Annoncer A quand seul C est possible serait la faute que le document
         interdit nommément. Ce test mesure C, et §10 mesure la limite de D. */
      const key = labKey('byzantin-double');

      // Le fournisseur PRÉTEND dédoublonner — `reallyIdempotent: false` — et
      // l'outil déclare `PROVIDER_IDEMPOTENT` sur la foi de cette promesse.
      const s = stack(
        { kind: 'NORMAL' },
        { contract: 'PROVIDER_IDEMPOTENT', reallyIdempotent: false },
      );

      await s.gateway.invoke(labCall(key, { toolId: TOOL }));

      // Le monde reçoit un SECOND effet pour la même identité et la même
      // cible — exactement ce que le fournisseur jurait impossible.
      await s.provider.send(key, 'doublon byzantin');
      await s.provider.settle();

      expect(await externalEffectCount(world, key)).toBe(2);

      // Une nouvelle observation de la même opération constate la rupture.
      const relu = await s.gateway.invoke(labCall(key, { toolId: TOOL }));
      expect(relu.ok).toBe(true);
      if (!relu.ok) return;

      expect(relu.value.status).toBe('PROVIDER_CONTRACT_VIOLATION');

      /* Ce qu'il ne faut SURTOUT pas rendre ici :
           CONFIRMED — masquerait la violation
           FAILED    — affirmerait l'absence alors que DEUX effets existent */
      expect(mayClaimSuccess(relu.value.status)).toBe(false);
      expect(relu.value.status).not.toBe('FAILED');
      expect(relu.value.verification.detail).toContain('Contrat rompu');
    },
    30_000,
  );

  it(
    'BYZANTIN — la violation est JOURNALISÉE comme rupture de confiance (I11)',
    async () => {
      const key = labKey('byzantin-journal');
      const s = stack(
        { kind: 'NORMAL' },
        { contract: 'PROVIDER_IDEMPOTENT', reallyIdempotent: false },
      );

      await s.gateway.invoke(labCall(key, { toolId: TOOL }));
      await s.provider.send(key, 'doublon byzantin');
      await s.provider.settle();
      await s.gateway.invoke(labCall(key, { toolId: TOOL }));

      const events = await db.query<{ status: string }>(
        'SELECT status FROM event_ledger WHERE operation_id = $1',
        [key],
      );
      expect(events.ok).toBe(true);
      if (!events.ok) return;

      /* La violation doit exister dans le JOURNAL, pas seulement dans le
         registre. Le journal est append-only et chaîné : c'est la seule trace
         qu'un audit ne peut pas voir disparaître. */
      expect(
        events.value.rows.some((r) => r.status === 'PROVIDER_CONTRACT_VIOLATION'),
      ).toBe(true);
    },
    30_000,
  );

  it(
    "BYZANTIN — LIMITE DE CLASSE D : deux cibles différentes sont indétectables",
    async () => {
      /* `docs/22 §9`, contre-exemple cherché et TROUVÉ :

           « deux effets sur deux cibles DIFFÉRENTES — indiscernables d'un
             succès partiel légitime »

         La détection n'est possible QUE si l'ensemble des cibles attendues est
         connu d'avance. Il ne l'est pas ici : le Gateway n'a aucune notion de
         cible (`docs/26 §4.1`).

         Ce test ne demande pas de correction. Il MESURE la limite, pour
         qu'elle ne soit jamais présentée comme une garantie. */
      const key = labKey('byzantin-classe-d');
      const s = stack({ kind: 'NORMAL' }, { contract: 'PROVIDER_IDEMPOTENT' });

      await s.gateway.invoke(labCall(key, { toolId: TOOL }));

      /* Un effet supplémentaire sur une cible DIFFÉRENTE, injecté par le banc.
         `provider.send` réutiliserait la cible par défaut — donc la même — et
         produirait une violation de classe C au lieu du cas cherché. Ce
         détail m'a d'abord échappé, et le test l'a signalé. */
      await commitEffect(world, {
        operationKey: key,
        providerId: 'deux-mondes',
        target: 'une-autre-cible',
        payload: 'effet byzantin sur une seconde cible',
      });
      await s.provider.settle();

      // DEUX effets, une seule fois par cible : rien ne les distingue d'un
      // envoi légitime à deux destinataires.
      expect(await externalEffectCount(world, key)).toBe(2);

      const relu = await s.gateway.invoke(labCall(key, { toolId: TOOL }));
      expect(relu.ok).toBe(true);
      if (!relu.ok) return;

      /* AUCUNE violation n'est détectée, et c'est CORRECT — rien ne distingue
         cette situation d'un envoi légitime à deux destinataires.

         C'est la classe D : non détectable. L'écrire est la seule chose à
         faire ; prétendre le contraire serait promettre une garantie qui
         n'existe pas. */
      expect(relu.value.status).not.toBe('PROVIDER_CONTRACT_VIOLATION');
      // Mais Jarvis n'annonce pas non plus un succès : il dit son ignorance.
      expect(mayClaimSuccess(relu.value.status)).toBe(false);
    },
    30_000,
  );

  /* ================================================================== *
   * LES TROIS PROPRIÉTÉS GLOBALES — `docs/22 §8`
   * ================================================================== */

  it(
    'propriété globale : un double effet ne vient JAMAIS d\'un rejeu que Jarvis croyait sûr',
    async () => {
      /* La première propriété mérite d'être lue deux fois : elle n'interdit
         pas le double effet — c'est impossible face à un fournisseur byzantin.
         Elle interdit que JARVIS EN SOIT LA CAUSE en se croyant sûr. */
      const key = labKey('propriete-globale');
      const s = stack(
        { kind: 'NORMAL' },
        { contract: 'PROVIDER_IDEMPOTENT', reallyIdempotent: false },
      );

      await s.gateway.invoke(labCall(key, { toolId: TOOL }));
      await s.provider.send(key, 'doublon imposé par le banc');
      await s.provider.settle();
      expect(await externalEffectCount(world, key)).toBe(2);

      // Le second effet vient du BANC, pas de Jarvis. La preuve : le compteur
      // de tentatives de Jarvis n'a pas bougé.
      const row = await db.query<{ attempts: number }>(
        'SELECT attempts FROM tool_operations WHERE operation_id = $1',
        [key],
      );
      expect(row.ok).toBe(true);
      if (!row.ok) return;
      expect(row.value.rows[0]?.attempts).toBe(1);

      /* Et le second monde le confirme indépendamment : deux requêtes reçues,
         mais une seule provenait d'une exécution de Jarvis. */
      const verite = await groundTruth(world, key);
      expect(verite.effectsCommitted).toBe(2);
    },
    30_000,
  );
});

/* -------------------------------------------------------------------------- */
