/**
 * RED TEAM — `FAIL CLOSED`.
 *
 * Référence : `docs/13 §6`, mandat Foundation 2.2.
 *
 * Ce fichier ne vérifie pas que Jarvis fait ce qu'on attend. Il vérifie qu'il
 * **REFUSE DE FAIRE CE QU'IL NE DOIT JAMAIS FAIRE** — la moitié du travail que
 * les suites de tests ordinaires oublient.
 *
 * La règle éprouvée ici, et c'est probablement la plus importante du projet :
 *
 *     Devant l'argent, les données personnelles, une communication externe,
 *     une suppression, une permission ou un changement de politique —
 *     si Jarvis ne sait pas, il NE FAIT RIEN.
 *
 *     Pas « probablement ». Pas « je pense que ». Pas « le modèle a estimé ».
 *     UNKNOWN → STOP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../../src/core/db/client.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import { defineTool } from '../../src/core/tools/contract.js';
import { err, ok, jarvisError } from '../../src/core/types/result.js';
import { mayClaimSuccess, UnknownReason } from '../../src/core/verification/engine.js';
import { VerificationStatus, isUntrusted, Provenance } from '../../src/core/types/domain.js';

const skip = !databaseAvailable();
const ROOT = process.cwd();

function listTs(root: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/* ==================================================================== */
/* A. Propriétés structurelles — vraies sans exécuter quoi que ce soit   */
/* ==================================================================== */

describe('FAIL CLOSED — propriétés structurelles', () => {
  it('un seul statut autorise Jarvis à annoncer un succès', () => {
    // Propriété exhaustive : on énumère TOUS les statuts, pas seulement ceux
    // auxquels on pense. Ajouter `PARTIAL` demain fera échouer ce test tant
    // que sa place dans la règle n'aura pas été décidée — c'est voulu.
    for (const status of VerificationStatus.options) {
      expect(mayClaimSuccess(status), status).toBe(status === 'CONFIRMED');
    }
  });

  it('les provenances non fiables sont exhaustivement connues', () => {
    // Une provenance ajoutée sans décider de sa fiabilité tomberait
    // silencieusement du côté « fiable ». Ce test l'interdit.
    const decided: Record<Provenance, boolean> = {
      USER: false,
      SYSTEM: false,
      MEMORY: false,
      TOOL_OUTPUT: false,
      MODEL_OUTPUT: true,
      EXTERNAL_UNTRUSTED: true,
    };
    for (const provenance of Provenance.options) {
      expect(isUntrusted(provenance), provenance).toBe(decided[provenance]);
    }
  });

  it('`maxRetries` est DÉCLARÉ par les contrats et LU par personne', () => {
    // La distinction est le point : les outils ont le droit de déclarer un
    // nombre de tentatives, personne n'a le droit de s'en servir. Tant que la
    // sémantique d'UNKNOWN n'est pas éprouvée en usage réel, un rejeu
    // automatique serait le plus court chemin vers le double virement.
    //
    // ⚠ Un champ déclaré et jamais lu est un piège : quelqu'un finira par
    // l'honorer en croyant réparer un oubli. `docs/16 §4` recommande de le
    // RETIRER du contrat plutôt que de le laisser dormir.
    const consumers: string[] = [];
    for (const file of listTs(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      // Une LECTURE ressemble à `def.maxRetries` ou `definition.maxRetries`.
      // Une DÉCLARATION ressemble à `maxRetries: 2,`.
      if (/\.\s*maxRetries/.test(text)) consumers.push(file);
      expect(/setTimeout\([^)]*retry/i.test(text), file).toBe(false);
      expect(/while\s*\([^)]*attempt/i.test(text), file).toBe(false);
    }
    expect(consumers).toEqual([]);
  });

  it('aucun module ne convertit un UNKNOWN en succès', () => {
    // Le motif recherché : une comparaison qui traiterait UNKNOWN comme
    // acceptable, ou une valeur par défaut qui le remplacerait.
    for (const file of listTs(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      expect(/UNKNOWN['"]\s*\?\s*['"]CONFIRMED/.test(text), file).toBe(false);
      expect(/status\s*!==\s*['"]UNKNOWN['"]\s*\|\|/.test(text), file).toBe(false);
    }
  });

  it('toute raison d\'ignorance est nommée, aucune n\'est un fourre-tout', () => {
    // Six raisons, dont une explicitement inatteignable aujourd'hui. Aucune
    // ne s'appelle « OTHER » ou « UNSPECIFIED » : un fourre-tout finit
    // toujours par absorber les cas qu'on n'a pas voulu regarder.
    expect(UnknownReason.options).toHaveLength(6);
    for (const reason of UnknownReason.options) {
      expect(reason).not.toMatch(/OTHER|UNSPECIFIED|MISC|GENERIC/);
    }
  });
});

/* ==================================================================== */
/* B. Refus effectifs — ce que Jarvis ne fait pas, éprouvé              */
/* ==================================================================== */

/** Outil qui prétend savoir vérifier une tentative sans en être capable. */
const menteur = defineTool({
  definition: {
    id: 'fail_closed_menteur',
    version: '1.0.0',
    description: 'Déclare une capacité qu\'il ne possède pas',
    autonomy: 'L2',
    privacyClass: 'GREEN',
    // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
    dataCategory: 'OTHER',
    reversible: false,
    networkRequired: false,
    parameters: [],
    idempotency: 'OPERATION_KEY',
    verification: 'READ_BACK',
    timeoutMs: 1000,
    maxRetries: 0,
    auditEvent: 'FAIL_CLOSED_MENTEUR',
    requiredSecrets: [],
    rollback: null,
    attemptVerification: 'BY_OPERATION_KEY',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
  },
  inputSchema: z.object({}),
  execute: () => Promise.resolve(ok({ output: null })),
});

/** Outil dont la relecture échoue toujours : l'ignorance est structurelle. */
const aveugle = defineTool({
  definition: {
    id: 'fail_closed_aveugle',
    version: '1.0.0',
    description: 'Exécute, mais ne sait jamais dire ce qui s\'est passé',
    autonomy: 'L2',
    privacyClass: 'ORANGE',
    // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
    dataCategory: 'OTHER',
    reversible: false,
    networkRequired: false,
    parameters: [{ name: 'valeur', sensitive: true }],
    idempotency: 'OPERATION_KEY',
    verification: 'READ_BACK',
    timeoutMs: 2000,
    maxRetries: 0,
    auditEvent: 'FAIL_CLOSED_AVEUGLE',
    requiredSecrets: [],
    rollback: null,
    attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
  },
  inputSchema: z.object({ valeur: z.string() }),
  execute: () => Promise.resolve(ok({ output: { envoye: true } })),
  readBack: () =>
    Promise.resolve(err(jarvisError('PROVIDER_UNAVAILABLE', 'aucune relecture possible'))),
});

describe.skipIf(skip)('FAIL CLOSED — refus effectifs', () => {
  let db: Db;
  let stack: Stack;

  beforeAll(() => {
    db = appDb();
    stack = buildStack(db);
    stack.registerExtra(aveugle);
  });

  afterAll(async () => {
    await db.close();
  });

  it('REFUSE d\'enregistrer un outil qui déclare une capacité qu\'il n\'a pas', () => {
    // Le mandat l'exige explicitement : « un outil ne peut jamais déclarer une
    // capacité de vérification qu'il ne possède pas réellement. » La barrière
    // est au DÉMARRAGE, pas au premier appel — un contrat menteur ne doit
    // jamais atteindre l'exécution.
    const result = stack.gateway.register(menteur);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(JSON.stringify(result.error)).toContain('verifyAttempt');
  });

  it('une action non vérifiable N\'EST JAMAIS annoncée comme faite', async () => {
    const result = await stack.gateway.invoke({
      toolId: 'fail_closed_aveugle',
      input: { valeur: 'quelque chose d\'irréversible' },
      parameterProvenance: { valeur: 'USER' },
      operationId: operationId('fc-aveugle'),
      actor: 'USER',
      context: callContext(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('UNKNOWN');
    expect(mayClaimSuccess(result.value.status)).toBe(false);
    // Et l'ignorance est QUALIFIÉE : « je ne sais pas » sans dire pourquoi ne
    // permet ni de choisir une conduite, ni de poser la bonne question.
    expect(result.value.verification.unknownReason).toBe('NO_OBSERVATION');
  });

  it('un UNKNOWN reste UNKNOWN au rejeu — il ne « mûrit » jamais en succès', async () => {
    // Le mode de défaillance redouté : un système qui, faute de mieux, finit
    // par considérer qu'une vieille incertitude est probablement un succès.
    const opId = operationId('fc-persiste');
    const call = {
      toolId: 'fail_closed_aveugle',
      input: { valeur: 'x' },
      parameterProvenance: { valeur: 'USER' as const },
      operationId: opId,
      actor: 'USER' as const,
      context: callContext(),
    };

    const first = await stack.gateway.invoke(call);
    const second = await stack.gateway.invoke(call);
    const third = await stack.gateway.invoke(call);

    for (const [index, result] of [first, second, third].entries()) {
      expect(result.ok, String(index)).toBe(true);
      if (!result.ok) continue;
      expect(result.value.status, String(index)).toBe('UNKNOWN');
    }
  });

  it('REFUSE toute sortie réseau d\'une donnée RED, quelle que soit l\'insistance', async () => {
    // On accumule TOUT ce qui pourrait passer pour une autorisation :
    // confirmation utilisateur, cloud activé, acteur privilégié.
    const exfil = defineTool({
      definition: {
        id: 'fail_closed_exfil',
        version: '1.0.0',
        description: 'Sortie réseau d\'une donnée RED',
        autonomy: 'L2',
        privacyClass: 'RED',
        // Fixture de test : catégorie neutre, plancher PERSONAL (défaut fermé).
        dataCategory: 'OTHER',
        reversible: false,
        networkRequired: true,
        parameters: [{ name: 'charge', sensitive: true }],
        idempotency: 'OPERATION_KEY',
        verification: 'READ_BACK',
        timeoutMs: 1000,
        maxRetries: 0,
        auditEvent: 'FAIL_CLOSED_EXFIL',
        requiredSecrets: [],
        rollback: null,
        attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
      },
      inputSchema: z.object({ charge: z.string() }),
      execute: () => Promise.resolve(ok({ output: null })),
    });
    stack.registerExtra(exfil);

    for (const context of [
      callContext({ userConfirmed: true }),
      callContext({ userConfirmed: true, cloudEnabled: true }),
      callContext({ userConfirmed: true, cloudEnabled: true, mode: 'PRIVATE' }),
    ]) {
      const result = await stack.gateway.invoke({
        toolId: 'fail_closed_exfil',
        input: { charge: 'secret' },
        parameterProvenance: { charge: 'USER' },
        operationId: operationId('fc-exfil'),
        actor: 'USER',
        context,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('POLICY_DENIED');
    }
  });

  it('REFUSE d\'agir sur une valeur sensible d\'origine modèle sans confirmation', async () => {
    // ADR-024 mis à l'épreuve du chemin complet : une déduction de modèle qui
    // alimente un paramètre sensible est arrêtée exactement comme un contenu
    // lu dans un email.
    const result = await stack.gateway.invoke({
      toolId: 'fail_closed_aveugle',
      input: { valeur: 'déduit par un modèle' },
      parameterProvenance: { valeur: 'MODEL_OUTPUT' },
      operationId: operationId('fc-model'),
      actor: 'JARVIS',
      context: callContext(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('CONFIRMATION_REQUIRED');
  });

  it('un refus laisse toujours une trace — un refus muet serait invisible', async () => {
    const opId = operationId('fc-trace');
    await stack.gateway.invoke({
      toolId: 'fail_closed_exfil',
      input: { charge: 'secret' },
      parameterProvenance: { charge: 'USER' },
      operationId: opId,
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    const logged = await stack.ledger.findByOperationId(opId);
    expect(logged.ok).toBe(true);
    if (!logged.ok || logged.value === null) throw new Error('refus non journalisé');
    expect(logged.value.policyDecision).toBe('DENY');
  });
});
