/**
 * S13 — L'UTILISATEUR PEUT COUPER LE CLOUD, ET CELA DOIT ÊTRE VRAI.
 *
 * La phrase est de `policies/00_hard_security.cedar`, juste au-dessus de la
 * règle qui interdit toute égression quand `cloudEnabled` est faux :
 *
 * ```cedar
 * // L'utilisateur doit pouvoir couper le cloud, et cela doit être vrai.
 * forbid(principal, action, resource)
 * when { context.egress == true && context.cloudEnabled == false };
 * ```
 *
 * **Ça ne l'était pas.** `config/default.json` expose `cloud.enabled` ; le
 * runtime et l'Assistant écrivaient `cloudEnabled: false` EN DUR. La clé ne
 * pilotait rien.
 *
 * POURQUOI C'EST UN DÉFAUT ET NON UNE PRUDENCE — ADR-069
 * ---------------------------------------------------------------------------
 * Le résultat allait dans le bon sens : le cloud était éteint. Mais il l'était
 * par un littéral, pas par un mécanisme — le motif « tenu par ABSENCE, pas par
 * mécanisme » que `docs/26 §4.11` avait déjà nommé pour le CostGate.
 *
 * > **Un interrupteur qui n'interrompt pas est pire que pas d'interrupteur.**
 * > L'utilisateur se croit protégé par son choix alors qu'il l'est par un
 * > hasard d'écriture — et le jour où quelqu'un remplace le littéral, plus
 * > rien ne le signale.
 *
 * CE QUE CE FICHIER NE DÉCIDE PAS
 * --------------------------------
 * Rien sur le FOURNISSEUR cloud. Le défaut de `config/default.json` reste
 * `false`. Ce qui change n'est pas le comportement par défaut : c'est que le
 * choix de l'utilisateur soit HONORÉ.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPolicyGate } from '../../src/core/policy/gate.js';
import { createCedarEvaluator, loadPolicySource } from '../../src/providers/policy/cedar.js';
import { join } from 'node:path';

const source = loadPolicySource(join(process.cwd(), 'policies'));
if (!source.ok) throw new Error('politiques illisibles');
const gate = createPolicyGate(createCedarEvaluator(source.value));

/** Une demande d'action SORTANTE, seule variable : l'interrupteur. */
function demande(cloudEnabled: boolean): unknown {
  return {
    actor: 'USER',
    action: { tool: 'web_search', operation: 'search' },
    declaredAutonomy: 'L1',
    resource: {
      type: 'web',
      id: 'recherche',
      privacyClass: 'ORANGE',
      dataLevel: 'PERSONAL',
    },
    context: {
      mode: 'NORMAL',
      // La seule variable du fichier : l'action SORT de la machine.
      egress: true,
      cloudEnabled,
      proactive: false,
      userConfirmed: false,
    },
    parameters: [],
  };
}

describe('S13 — l’interrupteur cloud interrompt vraiment', () => {
  it('ÉTEINT, une action sortante est REFUSÉE par la politique', () => {
    const verdict = gate.decide(demande(false));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.decision).toBe('DENY');
  });

  it('ALLUMÉ, la même action n’est plus refusée POUR CETTE RAISON', () => {
    /* LE CONTRÔLE NÉGATIF, ET IL EST INDISPENSABLE. Sans lui, une politique qui
       refuserait TOUT passerait le test précédent en donnant l'illusion que
       l'interrupteur fonctionne.

       On n'affirme pas « autorisé » — d'autres règles peuvent légitimement
       s'appliquer. On affirme que le verdict CHANGE : c'est ce qui distingue un
       interrupteur d'un mur peint en forme d'interrupteur. */
    const eteint = gate.decide(demande(false));
    const allume = gate.decide(demande(true));
    expect(eteint.ok && allume.ok).toBe(true);
    if (!eteint.ok || !allume.ok) return;
    expect(allume.value.decision).not.toBe(eteint.value.decision);
  });

  /* ==================================================================== *
   * LE CÂBLAGE — la clé de configuration est-elle LUE ?
   * ==================================================================== */

  it('le runtime LIT `cloud.enabled` au lieu d’écrire un littéral', () => {
    /* ⚠ CE TEST EXISTE PARCE QUE LE DÉFAUT ÉTAIT EXACTEMENT LÀ, et qu'il ne se
       voyait dans aucun comportement : le résultat était le bon.

       `assistant.ts` et `runtime.ts` posaient `cloudEnabled: false`. La preuve
       du câblage n'est donc pas un comportement observable aujourd'hui — les
       deux valent `false` — mais la LECTURE de la configuration. On la vérifie
       dans la source, faute de pouvoir l'observer autrement. */
    const runtime = readFileSync('src/apps/runtime.ts', 'utf8');
    expect(runtime).toContain('config.value.public.cloud.enabled');

    /* Et le littéral a DISPARU des deux fichiers : c'est la moitié qui
       manquerait si on ajoutait la lecture sans retirer l'ancien chemin. */
    const assistant = readFileSync('src/core/assistant.ts', 'utf8');
    expect(assistant).not.toContain('cloudEnabled: false');
    expect(runtime).not.toContain('cloudEnabled: false,');
  });

  it('le DÉFAUT reste fermé — la correction n’ouvre rien', () => {
    /* Ce qui change n'est pas le comportement par défaut, c'est que le choix
       soit honoré. Si cette assertion tombait, ADR-069 aurait transformé une
       correction en ouverture. */
    const config: unknown = JSON.parse(readFileSync('config/default.json', 'utf8'));
    const cloud = (config as { cloud: { enabled: boolean } }).cloud;
    expect(cloud.enabled).toBe(false);
  });

  it('la RÈGLE Cedar existe et porte sa raison — S13 n’est pas qu’un test', () => {
    /* Le test ci-dessus éprouve le comportement ; celui-ci vérifie que la règle
       qui le produit est bien celle qu'on croit, et qu'elle porte encore la
       phrase qui l'explique. Une règle dont le motif s'efface finit par être
       supprimée par quelqu'un qui ne sait plus pourquoi elle est là. */
    const politique = readFileSync('policies/00_hard_security.cedar', 'utf8');
    expect(politique).toContain('context.egress == true && context.cloudEnabled == false');
    expect(politique).toContain('L\'utilisateur doit pouvoir couper le cloud');
  });
});
