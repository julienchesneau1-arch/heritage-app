/**
 * CLASSIFICATION — `docs/14`, étape F1 du Data Firewall.
 *
 * `docs/14 §6` énumère **sept tests exigés avant de considérer ce document
 * acquis**. Quatre relèvent du calcul pur et sont ici ; le cinquième (aucune
 * valeur `RESTRICTED` dans un prompt, un embedding ou un log) est déjà tenu par
 * le scanner de secrets ; les deux derniers demandent un branchement (F2) et
 * une migration (F4).
 *
 * Le document nomme lui-même le plus important :
 *
 *   > Le test 4 est le plus important : c'est celui qui prouve que le coût ne
 *   > décide pas de la confidentialité.
 *
 * Il n'est pas encore atteignable — rien n'appelle cette classification — et
 * l'écrire ici serait éprouver la simulation. Il arrive avec F2.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classify,
  floorFor,
  fromLegacy,
  levelOfSet,
  mayEgress,
} from '../../src/core/privacy/classify.js';
import { DataCategory, DataLevel } from '../../src/core/types/domain.js';

describe('docs/14 — la classification tient-elle ?', () => {
  /* ================================================================== *
   * §6.1 — CREDENTIAL est RESTRICTED, quoi qu'on demande
   * ================================================================== */

  it("§6.1 — CREDENTIAL est RESTRICTED, quelle que soit la classe demandée", () => {
    /* Le seul niveau où certains traitements sont interdits MÊME LOCALEMENT.
       Un secret n'entre dans aucun contexte de modèle — pas dans un prompt,
       pas dans un embedding (« un vecteur reste dérivé de la valeur »), pas
       dans un log. */
    expect(floorFor('CREDENTIAL')).toBe('RESTRICTED');

    for (const demande of DataLevel.options) {
      expect(classify({ category: 'CREDENTIAL', requested: demande })).toBe('RESTRICTED');
    }
  });

  /* ================================================================== *
   * §6.2 — un ensemble hérite du niveau MAXIMUM
   * ================================================================== */

  it("§6.2 — trois tâches et un bulletin de salaire forment un ensemble HIGHLY_SENSITIVE", () => {
    /* `docs/14 §3` appelle ça « l'erreur classique du RAG, qui agrège des
       fragments et perd leur classification en route ». */
    const ensemble = levelOfSet([
      classify({ category: 'TASK' }),
      classify({ category: 'TASK' }),
      classify({ category: 'TASK' }),
      classify({ category: 'FINANCIAL' }),
    ]);
    expect(ensemble).toBe('HIGHLY_SENSITIVE');
  });

  it("un ensemble VIDE vaut PUBLIC — contrôle négatif du précédent", () => {
    /* Sans lui, il suffirait de toujours rendre le maximum pour passer. */
    expect(levelOfSet([])).toBe('PUBLIC');
    expect(levelOfSet(['PUBLIC', 'PUBLIC'])).toBe('PUBLIC');
  });

  /* ================================================================== *
   * §6.3 — l'utilisateur monte, jamais ne descend
   * ================================================================== */

  it("§6.3 — l'utilisateur peut MONTER un niveau", () => {
    expect(classify({ category: 'TASK' })).toBe('PERSONAL');
    expect(classify({ category: 'TASK', requested: 'HIGHLY_SENSITIVE' })).toBe(
      'HIGHLY_SENSITIVE',
    );
  });

  it("§6.3 — et JAMAIS descendre sous le plancher de sa catégorie", () => {
    /* La demande plus basse est ignorée, pas refusée : refuser ferait échouer
       une opération légitime pour une intention qui, de toute façon, n'a aucun
       effet. */
    expect(classify({ category: 'CALENDAR', requested: 'PUBLIC' })).toBe('SENSITIVE');
    expect(classify({ category: 'HEALTH', requested: 'PERSONAL' })).toBe(
      'HIGHLY_SENSITIVE',
    );
  });

  /* ================================================================== *
   * §6.6 — OTHER tombe sur PERSONAL, pas sur PUBLIC
   * ================================================================== */

  it('§6.6 — OTHER tombe sur PERSONAL, et surtout pas sur PUBLIC', () => {
    /* Ce qu'on ne sait pas nommer, on ne l'envoie pas. C'est le défaut fermé,
       et c'est la ligne de la table qui se trompe le plus facilement dans
       l'autre sens. */
    expect(floorFor('OTHER')).toBe('PERSONAL');
    expect(floorFor('OTHER')).not.toBe('PUBLIC');
  });

  /* ================================================================== *
   * La table est COMPLÈTE — aucune catégorie ne file entre les mailles
   * ================================================================== */

  it('CHAQUE catégorie a un plancher explicite, et une seule est PUBLIC', () => {
    /* Une catégorie oubliée doit provoquer une erreur de compilation, pas un
       repli silencieux vers le niveau le plus bas. On le constate aussi à
       l'exécution : le nombre de catégories PUBLIC est le chiffre qui se
       dégraderait sans bruit si la table se relâchait. */
    const planchers = DataCategory.options.map((c) => floorFor(c));
    expect(planchers.length).toBe(DataCategory.options.length);
    for (const p of planchers) {
      expect(DataLevel.options).toContain(p);
    }
    expect(planchers.filter((p) => p === 'PUBLIC')).toEqual(['PUBLIC']);
    expect(floorFor('WEATHER')).toBe('PUBLIC');
  });

  it("une donnée EXTERNAL_UNTRUSTED ne peut jamais ABAISSER un niveau", () => {
    /* `docs/14 §3`, source 2. La provenance ne monte pas mécaniquement le
       niveau — ce serait confondre « qui l'a écrite » avec « de quoi elle
       parle » — mais elle ne peut rien descendre. */
    for (const categorie of DataCategory.options) {
      const sans = classify({ category: categorie });
      const avec = classify({ category: categorie, provenance: 'EXTERNAL_UNTRUSTED' });
      expect(avec, categorie).toBe(sans);
    }
    // Et une demande basse reste sans effet, provenance externe ou non.
    expect(
      classify({
        category: 'DOCUMENT',
        requested: 'PUBLIC',
        provenance: 'EXTERNAL_UNTRUSTED',
      }),
    ).toBe('SENSITIVE');
  });

  /* ================================================================== *
   * LA CONVERSION REFUSE DE DEVINER — le seul pas qui pourrait élargir
   * ================================================================== */

  it('RED et ORANGE se convertissent seuls : ils ne peuvent que rester protégés', () => {
    const red = fromLegacy('RED', 'DOCUMENT');
    expect(red.ok).toBe(true);
    if (red.ok) expect(red.value).toBe('HIGHLY_SENSITIVE');

    const orange = fromLegacy('ORANGE', 'TASK');
    expect(orange.ok).toBe(true);
    if (orange.ok) expect(orange.value).toBe('PERSONAL');
  });

  it("un CREDENTIAL classé RED devient RESTRICTED, pas HIGHLY_SENSITIVE", () => {
    /* `docs/14 §5` : « les CREDENTIAL devront être re-classés RESTRICTED par
       leur CATÉGORIE, pas par leur ancienne classe ». La conversion applique
       donc le plancher par-dessus la correspondance. */
    const converti = fromLegacy('RED', 'CREDENTIAL');
    expect(converti.ok).toBe(true);
    if (converti.ok) expect(converti.value).toBe('RESTRICTED');
  });

  it('GREEN ÉCHOUE bruyamment dès que la catégorie ne le confirme pas', () => {
    /* LE TEST QUI PROTÈGE LE SEUL PAS DANGEREUX DU CHANTIER.

       Une donnée aujourd'hui GREEN « par défaut d'attention » deviendrait
       publiquement envoyable. `docs/14 §5` : la migration doit défaillir
       plutôt que deviner. */
    for (const categorie of DataCategory.options) {
      const converti = fromLegacy('GREEN', categorie);
      if (categorie === 'WEATHER') {
        expect(converti.ok, categorie).toBe(true);
        if (converti.ok) expect(converti.value).toBe('PUBLIC');
      } else {
        expect(converti.ok, categorie).toBe(false);
        if (!converti.ok) expect(converti.error.message).toContain('ligne par ligne');
      }
    }
  });

  /* ================================================================== *
   * Ce que F1 ne fait PAS
   * ================================================================== */

  it("mayEgress refuse à partir de SENSITIVE — et n'est encore appelé par PERSONNE", () => {
    /* La frontière que F2 branchera au Policy Gate. On la fixe maintenant pour
       qu'elle ne se négocie pas au moment du branchement, où la tentation sera
       de l'assouplir pour faire passer un outil.

       Et on VÉRIFIE qu'elle n'est appelée par personne : F1 est un calcul,
       pas une décision. Le jour où ce test rougit, c'est que F2 a eu lieu — et
       il devra être remplacé par la preuve du refus, pas par une exemption. */
    expect(mayEgress('PUBLIC')).toBe(true);
    expect(mayEgress('PERSONAL')).toBe(true);
    expect(mayEgress('SENSITIVE')).toBe(false);
    expect(mayEgress('HIGHLY_SENSITIVE')).toBe(false);
    expect(mayEgress('RESTRICTED')).toBe(false);

    const appelants: string[] = [];
    const parcourir = (dir: string): void => {
      for (const entree of readdirSync(dir)) {
        const complet = join(dir, entree);
        if (statSync(complet).isDirectory()) parcourir(complet);
        else if (complet.endsWith('.ts') && !complet.endsWith('privacy/classify.ts')) {
          /* On cherche l'IMPORT du module, pas un nom de fonction : la
             première rédaction cherchait `classify(` et trouvait le
             `classify()` sans rapport de `memory/guard.ts` — un faux positif
             qui aurait pu, dans l'autre sens, masquer un vrai appelant. */
          if (/from ['"].*privacy\/classify\.js['"]/.test(readFileSync(complet, 'utf8'))) {
            appelants.push(complet);
          }
        }
      }
    };
    parcourir('src');
    expect(appelants).toEqual([]);
  });
});
