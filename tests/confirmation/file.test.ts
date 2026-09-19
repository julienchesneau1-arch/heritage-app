/**
 * LA FILE D'ATTENTE DE CONFIRMATIONS — ADR-099.
 *
 * Le téléphone prépare, la machine décide. Ce fichier éprouve les deux
 * propriétés sans lesquelles ce mécanisme serait un trou de sécurité :
 *
 *   1. **Une ligne de la file n'autorise rien.** Le module stocke une
 *      intention et n'a aucun moyen d'en exécuter une.
 *
 *   2. **Seuls les refus de SURFACE peuvent y entrer.** Un `forbid` Cedar ne
 *      doit jamais devenir « à confirmer plus tard » — sinon il suffirait de
 *      demander depuis le téléphone pour obtenir ce qui est interdit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { databaseAvailable, ownerDb } from '../helpers/db.js';
import {
  createFileDeConfirmations,
  MINUTES_AVANT_EXPIRATION,
  type FileDeConfirmations,
} from '../../src/core/confirmation/file.js';
import { createPolicyGate } from '../../src/core/policy/gate.js';
import type { PolicyEvaluator } from '../../src/core/policy/evaluator.js';
import { ok } from '../../src/core/types/result.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

/* ====================================================================== *
 * 1. LE MOTIF — sans base, parce que c'est une pure décision
 * ====================================================================== */

const PERMISSIF: PolicyEvaluator = {
  evaluate: () =>
    ok({ decision: 'ALLOW' as const, determiningPolicies: [], reasons: [] }),
};
const REFUSANT: PolicyEvaluator = {
  evaluate: () =>
    ok({ decision: 'DENY' as const, determiningPolicies: ['forbid_test'], reasons: [] }),
};

function demande(surface: 'LOCALE' | 'DISTANTE', niveau: 'L2' | 'L4'): unknown {
  return {
    actor: 'USER',
    action: { tool: 'note_delete', operation: 'delete' },
    declaredAutonomy: niveau,
    resource: { type: 'note', id: 'n1', privacyClass: 'ORANGE', dataLevel: 'PERSONAL' },
    context: {
      mode: 'NORMAL',
      egress: false,
      cloudEnabled: false,
      proactive: false,
      userConfirmed: false,
      surface,
    },
    parameters: [],
  };
}

describe('seuls les refus RÉPARABLES portent un motif', () => {
  it('un refus de SURFACE porte `SURFACE_DISTANTE`', () => {
    const r = createPolicyGate(PERMISSIF).decide(demande('DISTANTE', 'L4'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision).toBe('DENY');
    expect(r.value.motif).toBe('SURFACE_DISTANTE');
  });

  it('⚠ un refus CEDAR n’en porte AUCUN — c’est le cœur de la sûreté', () => {
    /* SANS CETTE ASSERTION, LA FILE DEVIENDRAIT UN CONTOURNEMENT DE POLITIQUE.

       Si un `forbid` Cedar portait un motif, l'Assistant le mettrait en file,
       et l'utilisateur se verrait proposer d'exécuter demain, devant sa
       machine, ce qu'une politique interdit aujourd'hui.

       Le refus de surface est RÉPARABLE — la même demande passerait devant la
       machine. Le refus Cedar ne l'est pas. Le motif dit exactement cette
       différence, et rien d'autre. */
    const r = createPolicyGate(REFUSANT).decide(demande('LOCALE', 'L4'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.decision).toBe('DENY');
    expect(r.value.motif).toBeUndefined();
  });

  it('⚠ L0 n’en porte aucun non plus — rien ne précède l’interdit', () => {
    const r = createPolicyGate(PERMISSIF).decide(demande('DISTANTE', 'L2'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // L2 depuis DISTANTE : autorisé, donc aucun motif à porter.
    expect(r.value.motif).toBeUndefined();
  });

  it('l’Assistant ne met en file QUE sur ce motif', () => {
    /* La condition vit dans `assistant.ts`. On l'éprouve par lecture de source
       plutôt que par exécution, parce que la produire demanderait une pile
       complète — et parce que ce qui doit être garanti est la FORME de la
       condition : un champ typé, jamais une comparaison de phrase.

       Si quelqu'un remplace ce test d'égalité par une recherche dans
       `message`, ce test rougit. */
    const src = readFileSync('src/core/assistant.ts', 'utf8');
    expect(src).toContain("motif === 'SURFACE_DISTANTE'");
    expect(src, 'la condition ne doit pas se fonder sur le texte du refus')
      .not.toContain('message.includes');
  });
});

/* ====================================================================== *
 * 2. LA FILE N'EXÉCUTE RIEN
 * ====================================================================== */

describe('le module de file n’a aucun moyen d’exécuter', () => {
  it('⚠ il n’importe NI passerelle NI outil', () => {
    /* LA PROPRIÉTÉ EST ARCHITECTURALE, et ce test la tient par ce qui
       N'EXISTE PAS — comme pour `Secret` et pour `micro.ts`.

       `confirmer()` marque une ligne et rend son contenu. Le rejeu de la
       chaîne complète — Policy Gate compris — appartient à l'appelant, sur la
       surface locale. Le jour où ce module importerait la passerelle, il
       pourrait exécuter ce qu'il a lui-même enregistré, et la séparation qui
       rend la file sûre disparaîtrait. */
    const src = readFileSync('src/core/confirmation/file.ts', 'utf8');
    for (const interdit of ['tools/gateway', 'ToolGateway', 'invoke(']) {
      expect(src, `la file ne doit pas connaître « ${interdit} »`).not.toContain(interdit);
    }
  });

  it('le confirmateur, lui, REJOUE la chaîne — sur la surface LOCALE', () => {
    /* Contre-épreuve du test précédent : la capacité d'exécuter doit exister
       QUELQUE PART, sinon la file ne servirait à rien. Elle est dans le CLI,
       c'est-à-dire sur la machine. */
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain('runtime.gateway.invoke');
    expect(cli).toContain("surface: 'LOCALE'");
    expect(cli).toContain('/confirmer');
  });
});

/* ====================================================================== *
 * 3. LE COMPORTEMENT, SUR LA BASE RÉELLE
 * ====================================================================== */

describe.runIf(enabled)('la file, sur la base', () => {
  let db: Db;
  let file: FileDeConfirmations;

  beforeAll(() => {
    db = ownerDb();
    file = createFileDeConfirmations(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const demandeType = (cle: string) => ({
    operationId: cle,
    toolId: 'note_delete',
    input: { noteId: '00000000-0000-0000-0000-000000000001' },
    provenance: { noteId: 'USER' as const },
    resume: 'note_delete — « la note du carreleur »',
    demandeeDe: 'DISTANTE' as const,
  });

  it('met en file, puis la retrouve en attente', async () => {
    const cle = `adr099-${String(Date.now())}-a`;
    const mis = await file.mettreEnFile(demandeType(cle));
    expect(mis.ok, mis.ok ? '' : mis.error.message).toBe(true);
    if (!mis.ok) return;
    expect(mis.value.minutesRestantes).toBeLessThanOrEqual(MINUTES_AVANT_EXPIRATION);
    expect(mis.value.minutesRestantes).toBeGreaterThan(0);

    const liste = await file.enAttente();
    expect(liste.ok).toBe(true);
    if (!liste.ok) return;
    expect(liste.value.some((d) => d.operationId === cle)).toBe(true);

    await file.refuser(mis.value.id);
  }, 30_000);

  it('⚠ un REJEU ne crée pas une seconde ligne — ADR-030', async () => {
    /* Un client qui renvoie sa demande après une coupure fait exactement ce
       qu'il faut. Deux lignes signifieraient deux confirmations à donner pour
       une seule intention — et l'utilisateur en approuverait une en croyant
       les traiter toutes. */
    const cle = `adr099-${String(Date.now())}-b`;
    const un = await file.mettreEnFile(demandeType(cle));
    const deux = await file.mettreEnFile(demandeType(cle));
    expect(un.ok && deux.ok).toBe(true);
    if (!un.ok || !deux.ok) return;
    expect(deux.value.id).toBe(un.value.id);

    await file.refuser(un.value.id);
  }, 30_000);

  it('⚠ on ne confirme PAS deux fois la même intention', async () => {
    /* La seconde confirmation doit échouer. Sans ça, une intention approuvée
       pourrait être rejouée par une seconde invocation de `/confirmer` — et
       si la clé d'opération avait expiré côté outil, l'action aurait lieu
       DEUX fois. */
    const cle = `adr099-${String(Date.now())}-c`;
    const mis = await file.mettreEnFile(demandeType(cle));
    expect(mis.ok).toBe(true);
    if (!mis.ok) return;

    const premier = await file.confirmer(mis.value.id);
    expect(premier.ok, premier.ok ? '' : premier.error.message).toBe(true);

    const second = await file.confirmer(mis.value.id);
    expect(second.ok, 'une intention déjà confirmée ne se reconfirme pas').toBe(false);
  }, 30_000);

  it('une intention REFUSÉE quitte la file', async () => {
    const cle = `adr099-${String(Date.now())}-d`;
    const mis = await file.mettreEnFile(demandeType(cle));
    expect(mis.ok).toBe(true);
    if (!mis.ok) return;

    expect((await file.refuser(mis.value.id)).ok).toBe(true);

    const liste = await file.enAttente();
    expect(liste.ok).toBe(true);
    if (!liste.ok) return;
    expect(liste.value.some((d) => d.operationId === cle)).toBe(false);
  }, 30_000);

  it('⚠ une intention EXPIRÉE n’est ni proposée ni confirmable', async () => {
    /* LE TEST QUI EXIGE DE FABRIQUER LE TEMPS.

       On ne peut pas attendre trente minutes. On pose donc l'échéance dans le
       passé directement en base — ce qui éprouve la condition SQL, c'est-à-dire
       exactement le mécanisme qui compte. `confirmer()` porte sa condition
       d'expiration DANS le `WHERE` de l'écriture : la vérifier d'abord puis
       écrire laisserait une fenêtre où l'intention expire entre les deux. */
    const cle = `adr099-${String(Date.now())}-e`;
    const mis = await file.mettreEnFile(demandeType(cle));
    expect(mis.ok).toBe(true);
    if (!mis.ok) return;

    const vieilli = await db.query(
      `UPDATE confirmations_en_attente
          SET expires_at = clock_timestamp() - interval '1 minute'
        WHERE id = $1::uuid`,
      [mis.value.id],
    );
    expect(vieilli.ok).toBe(true);

    const liste = await file.enAttente();
    expect(liste.ok).toBe(true);
    if (!liste.ok) return;
    expect(
      liste.value.some((d) => d.operationId === cle),
      'une intention expirée ne doit pas être proposée',
    ).toBe(false);

    const tentee = await file.confirmer(mis.value.id);
    expect(tentee.ok, 'une intention expirée ne doit pas être confirmable').toBe(false);
    if (tentee.ok) return;
    expect(tentee.error.message).toContain('expiré');
  }, 30_000);

  it('CONTRÔLE — refuser une intention expirée reste permis', async () => {
    /* La seule asymétrie entre `confirmer` et `refuser`, et elle va dans le
       sens qui ne peut rien exécuter : l'utilisateur doit pouvoir nettoyer sa
       file même après coup. */
    const cle = `adr099-${String(Date.now())}-f`;
    const mis = await file.mettreEnFile(demandeType(cle));
    expect(mis.ok).toBe(true);
    if (!mis.ok) return;

    await db.query(
      `UPDATE confirmations_en_attente
          SET expires_at = clock_timestamp() - interval '1 minute'
        WHERE id = $1::uuid`,
      [mis.value.id],
    );
    const refus = await file.refuser(mis.value.id);
    expect(refus.ok).toBe(true);
    if (!refus.ok) return;
    expect(refus.value).toBe(true);
  }, 30_000);
});
