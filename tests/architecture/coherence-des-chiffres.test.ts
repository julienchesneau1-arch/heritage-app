/**
 * LES CHIFFRES PUBLIÉS DISENT-ILS LA VÉRITÉ, ET LA MÊME PARTOUT ?
 *
 * CE FICHIER EXISTE PARCE QUE LE MÊME DÉFAUT EST SURVENU QUATRE FOIS.
 * ---------------------------------------------------------------------------
 *   ADR-054   « 9 des 15 invariants » — la mesure en donnait 7
 *   ADR-055   « le compteur aurait échoué » — il ne lisait que sa propre table
 *   ADR-057   un scénario CRITIQUE compté couvert par collision de chaîne
 *   ADR-058   `docs/28` se contredisait LUI-MÊME : §6 disait 64 %/80 % quand
 *             §1 et §2 disaient 65 % et 76 %
 *
 * Quatre fois la même forme : **un chiffre écrit en prose que rien ne relie au
 * réel.** Corriger le quatrième sans corriger la cause aurait garanti un
 * cinquième.
 *
 * LA CAUSE EST LA DUPLICATION, ET LE DÉPÔT LA CONNAÎT DÉJÀ
 * ---------------------------------------------------------
 * ADR-041 l'a tranchée pour les données : *une console alimentée par une
 * seconde table pourrait diverger — et le jour où elles divergent, aucune ne
 * fait autorité.* Exactement ce qui est arrivé à la documentation : l'étendue
 * fonctionnelle vivait dans `docs/28 §1`, `docs/28 §6` et `README`, et les
 * trois ont fini par dire trois choses.
 *
 * `docs/28` est donc la SEULE source. Ce fichier vérifie deux propriétés :
 *
 *   COHÉRENCE INTERNE   `docs/28` ne se contredit pas lui-même
 *   FIDÉLITÉ AU RÉEL    ses chiffres vérifiables sont MESURÉS, pas recopiés
 *   NON-DUPLICATION     aucun autre document ne republie un chiffre concurrent
 *
 * ⚠ CE QUE CE FICHIER NE PROUVE PAS, et il faut le dire ici plutôt qu'en note.
 *   Il n'établit pas que les pondérations de `docs/28 §1` sont justes — ce sont
 *   des JUGEMENTS, écrits pour être contestés, et aucun test ne tranche un
 *   jugement. Il établit qu'un chiffre écrit quelque part correspond à ce qu'on
 *   peut compter ailleurs. C'est tout, et c'est déjà ce qui manquait.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const AVANCEMENT = readFileSync('docs/28_ETAT_D_AVANCEMENT.md', 'utf8');
const ZONES = readFileSync('docs/26_REGISTRE_DES_ZONES_D_OMBRE.md', 'utf8');
const README = readFileSync('README.md', 'utf8');
const QUICKSTART = readFileSync('QUICKSTART.md', 'utf8');

/** Premier nombre capturé par `motif`, ou `null` si le motif ne mord pas. */
function nombre(source: string, motif: RegExp): number | null {
  const m = motif.exec(source);
  const brut = m?.[1];
  return brut === undefined ? null : Number(brut.replace(',', '.'));
}

/* ====================================================================== *
 * LES MESURES — chacune compte quelque chose de RÉEL
 * ====================================================================== */

function adrMesurees(): number {
  return [...readFileSync('docs/01_ARCHITECTURE_DECISIONS.md', 'utf8')
    .matchAll(/^## ADR-\d+/gm)].length;
}

function outilsEnregistres(): readonly string[] {
  const ids: string[] = [];
  for (const f of readdirSync('src/tools')) {
    if (!f.endsWith('.ts') || f === 'index.ts') continue;
    const src = readFileSync(join('src/tools', f), 'utf8');
    for (const m of src.matchAll(/^\s{6}id: '([a-z_]+)',$/gm)) {
      const id = m[1];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

function scenariosDores(): number {
  return [...readFileSync('docs/05_GOLDEN_TESTS.md', 'utf8')
    .matchAll(/^### [A-Z]\d+ —/gm)].length;
}

function invariantsSecurite(): number {
  return [...readFileSync('docs/03_SECURITY_AND_PRIVACY.md', 'utf8')
    .matchAll(/^S\d+\.\s+\S/gm)].length;
}

describe('les chiffres publiés sont-ils vrais, et les mêmes partout ?', () => {
  /* ================================================================== *
   * 1. COHÉRENCE INTERNE — `docs/28` ne se contredit pas lui-même
   * ================================================================== */

  it('le RÉSUMÉ de docs/28 dit la même chose que ses en-têtes', () => {
    /* LE DÉFAUT EXACT D'ADR-058.

       `## 1. Étendue fonctionnelle — ≈ 65 %` et le bloc de synthèse final
       avaient divergé, parce que deux corrections successives avaient touché
       les sections sans toucher le résumé. Personne ne l'a vu : les deux
       nombres sont à cent lignes l'un de l'autre. */
    const etendueTitre = nombre(AVANCEMENT, /## 1\. Étendue fonctionnelle — \*\*≈ (\d+) %/);
    const preuveTitre = nombre(AVANCEMENT, /## 2\. Profondeur de preuve — \*\*≈ (\d+) %/);
    const etendueResume = nombre(AVANCEMENT, /ÉTENDUE FONCTIONNELLE\s+≈ (\d+) %/);
    const preuveResume = nombre(AVANCEMENT, /PROFONDEUR DE PREUVE\s+≈ (\d+) %/);

    // Aucun ne doit être nul : un motif qui ne mord pas rendrait ce test vert
    // pour la pire des raisons.
    for (const [nom, v] of [
      ['étendue (titre)', etendueTitre],
      ['preuve (titre)', preuveTitre],
      ['étendue (résumé)', etendueResume],
      ['preuve (résumé)', preuveResume],
    ] as const) {
      expect(v, `${nom} : motif introuvable dans docs/28`).not.toBeNull();
    }

    expect(etendueResume, 'le résumé contredit le §1').toBe(etendueTitre);
    expect(preuveResume, 'le résumé contredit le §2').toBe(preuveTitre);
  });

  it('le TOTAL du tableau de phases est celui annoncé en titre', () => {
    const titre = nombre(AVANCEMENT, /## 1\. Étendue fonctionnelle — \*\*≈ (\d+) %/);
    const total = nombre(AVANCEMENT, /\| \*\*TOTAL\*\* \| 100 % \| \| \*\*≈ (\d+) %\*\*/);
    expect(total, 'ligne TOTAL introuvable').not.toBeNull();
    expect(total).toBe(titre);
  });

  it('la MOYENNE de profondeur est celle annoncée en titre', () => {
    const titre = nombre(AVANCEMENT, /## 2\. Profondeur de preuve — \*\*≈ (\d+) %/);
    const moyenne = nombre(AVANCEMENT, /\| \*\*Moyenne\*\* \| \| \*\*≈ (\d+) %\*\* \|/);
    expect(moyenne, 'ligne Moyenne introuvable').not.toBeNull();
    expect(moyenne).toBe(titre);
  });

  it('la moyenne de profondeur est bien la MOYENNE de ses quatre lignes', () => {
    /* Sans ce test, les quatre taux pourraient bouger sans que la moyenne
       suive — c'est exactement ce qui s'est produit quand « 9 des 15 » est
       devenu « 7 des 15 » sans que la moyenne descende. */
    const taux = [...AVANCEMENT.matchAll(/\| \*\*(?:≈ )?(\d+) %\*\* \|$/gm)].map((m) =>
      Number(m[1]),
    );
    // Les quatre sources + la moyenne : cinq valeurs dans ce tableau.
    expect(taux.length, 'les taux du tableau de profondeur sont introuvables').toBe(5);

    const sources = taux.slice(0, 4);
    const moyennePubliee = taux[4];
    const calculee = Math.round(sources.reduce((a, b) => a + b, 0) / sources.length);
    expect(moyennePubliee).toBe(calculee);
  });

  /* ================================================================== *
   * 2. FIDÉLITÉ AU RÉEL — mesuré, pas recopié
   * ================================================================== */

  it('le nombre d’ADR annoncé est le nombre d’ADR écrites', () => {
    const publie = nombre(AVANCEMENT, /\*\*(\d+) ADR\*\*, chacune avec sa condition/);
    expect(publie, 'ligne ADR introuvable dans docs/28').not.toBeNull();
    expect(publie).toBe(adrMesurees());
  });

  it('le nombre d’OUTILS annoncé est le nombre d’outils enregistrés', () => {
    /* `docs/02` en liste quinze ; `egress_review` est arrivé en Phase 4, hors
       liste. Le total du dépôt est donc seize, et `docs/28` doit dire les deux
       sans les confondre. */
    const outils = outilsEnregistres();
    const publie = nombre(AVANCEMENT, /\*\*(\d+) outils sur 15\*\*/);
    expect(publie, 'ligne outils introuvable dans docs/28').not.toBeNull();
    expect(publie).toBe(outils.length - 1); // −1 : `egress_review`, hors liste
    expect(outils).toContain('egress_review');
    expect(outils.length).toBe(16);
  });

  it('les chiffres des SCÉNARIOS DORÉS collent au document et au test', () => {
    const couverts = nombre(AVANCEMENT, /\*\*(\d+) des 30\*\* référencés/);
    const bloques = nombre(AVANCEMENT, /\*\*\d+ des 30\*\* référencés, (\d+) déclarés bloqués/);
    expect(couverts, 'ligne scénarios introuvable').not.toBeNull();
    expect(bloques).not.toBeNull();

    // Le total colle au DOCUMENT source, pas à une constante recopiée.
    expect((couverts ?? 0) + (bloques ?? 0)).toBe(scenariosDores());

    /* Et il colle au TEST qui porte la mesure : deux registres du même fait
       finiraient par diverger, et le jour où ils divergent aucun ne fait
       autorité (ADR-041). */
    const contrat = readFileSync('tests/golden/contract.test.ts', 'utf8');
    expect(contrat).toContain(`expect(couverts).toBe(${String(couverts)});`);
    expect(contrat).toContain(`expect(bloques).toBe(${String(bloques)});`);
  });

  it('les chiffres des INVARIANTS S1–S15 collent au document et au test', () => {
    const nommes = nombre(AVANCEMENT, /\*\*(\d+) des 15\*\* nommément référencés/);
    expect(nommes, 'ligne invariants introuvable').not.toBeNull();
    expect(invariantsSecurite()).toBe(15);

    const contrat = readFileSync('tests/security/invariants-contract.test.ts', 'utf8');
    expect(contrat).toContain(`expect(nommes.length).toBe(${String(nommes)});`);

    // Le taux publié doit être celui que le test fige.
    const taux = Math.round(((nommes ?? 0) / 15) * 100);
    expect(contrat).toContain(`.toBe(${String(taux)});`);
  });

  it('le nombre de MODULES HORS CIRCUIT de docs/26 colle à wiring.test.ts', () => {
    /* `docs/26 §4.1` a affiché « Cinq » pendant toute la période où il valait
       six, alors que `wiring.test.ts` disait déjà `toHaveLength(6)`. Le test
       avait raison contre le registre, et rien ne le signalait. */
    const enLettres: Readonly<Record<string, number>> = {
      Trois: 3, Quatre: 4, Cinq: 5, Six: 6, Sept: 7, Huit: 8,
    };
    const m = /### 4\.1 (\w+) modules de logique hors circuit/.exec(ZONES);
    const mot = m?.[1];
    expect(mot, 'titre §4.1 introuvable dans docs/26').not.toBeUndefined();
    const publie = enLettres[mot ?? ''];
    expect(publie, `« ${mot ?? ''} » n’est pas un nombre reconnu`).not.toBeUndefined();

    const wiring = readFileSync('tests/redteam/wiring.test.ts', 'utf8');
    expect(wiring).toContain(`expect(deadLogic).toHaveLength(${String(publie)});`);
  });

  /* ================================================================== *
   * 3. NON-DUPLICATION — un seul document porte les chiffres
   * ================================================================== */

  it('NI le README NI le QUICKSTART ne republient un compte de tests', () => {
    /* LA CAUSE RACINE, TRAITÉE PLUTÔT QUE SES SYMPTÔMES.

       Mesuré avant correction : `README` annonçait « 670 tests » à un endroit,
       « 154 tests » à un autre, et `QUICKSTART` « 345 tests ». Trois nombres,
       trois documents, une seule réalité — et aucun des trois n'était juste.

       Un compte de tests ne peut d'ailleurs pas être vérifié sans exécuter la
       suite : le figer en prose garantit qu'il se périme. Il vit dans
       `docs/28`, qui est le document dont c'est le sujet. */
    for (const [nom, texte] of [
      ['README.md', README],
      ['QUICKSTART.md', QUICKSTART],
    ] as const) {
      const fautes = [...texte.matchAll(/(\d{2,4})\s+tests/g)].map((m) => m[0]);
      expect(fautes, `${nom} republie un compte de tests`).toEqual([]);
    }
  });

  it('le README ne republie AUCUN pourcentage d’avancement', () => {
    // Il en portait un — « ≈ 51 % » — périmé de deux révisions.
    const fautes = [...README.matchAll(/(?:étendue|profondeur)[^\n]{0,40}≈\s*\d+\s*%/gi)].map(
      (m) => m[0],
    );
    expect(fautes).toEqual([]);
  });

  it('les RAPPORTS DATÉS gardent leurs chiffres — on ne réécrit pas l’histoire', () => {
    /* DISTINCTION ESSENTIELLE, ET ELLE VA DANS L'AUTRE SENS.

       `docs/09`, `docs/11` et `docs/12` sont des audits menés à une date
       donnée. « 121 tests », « 345 tests » y sont des CONSTATS d'alors. Les
       mettre à jour serait falsifier un rapport — et rendrait incompréhensible
       la progression qu'ils documentent.

       Ce test fige la distinction : ces documents DOIVENT continuer à porter
       leurs chiffres d'époque. Sans lui, un futur balayage « de cohérence »
       les corrigerait par excès de zèle. */
    expect(readFileSync('docs/09_ARCHITECTURE_AUDIT_AND_GAPS.md', 'utf8')).toContain(
      '121 tests',
    );
    expect(readFileSync('docs/11_RED_TEAM_AUDIT.md', 'utf8')).toContain('345 tests');
  });

  /* ================================================================== *
   * CONTRÔLES NÉGATIFS — les motifs voient-ils vraiment ?
   * ================================================================== */

  it('DÉTECTE une divergence entre le résumé et l’en-tête', () => {
    const falsifie = AVANCEMENT.replace(
      /ÉTENDUE FONCTIONNELLE\s+≈ \d+ %/,
      'ÉTENDUE FONCTIONNELLE   ≈ 99 %',
    );
    expect(nombre(falsifie, /ÉTENDUE FONCTIONNELLE\s+≈ (\d+) %/)).toBe(99);
    expect(nombre(AVANCEMENT, /## 1\. Étendue fonctionnelle — \*\*≈ (\d+) %/)).not.toBe(99);
  });

  it('DÉTECTE un compte de tests réintroduit dans le README', () => {
    const falsifie = `${README}\n\n**512 tests passent.**\n`;
    const fautes = [...falsifie.matchAll(/(\d{2,4})\s+tests/g)].map((m) => m[0]);
    expect(fautes).toContain('512 tests');
  });

  it('N’EST PAS aveugle à un document vide — un motif muet rendrait tout vert', () => {
    // Le mode de panne le plus dangereux de ce fichier : `nombre()` rend `null`
    // partout, et chaque comparaison `null === null` passerait. D'où les
    // assertions `not.toBeNull()` ci-dessus, et ce contrôle qui les justifie.
    expect(nombre('', /≈ (\d+) %/)).toBeNull();
    expect(nombre('aucun pourcentage ici', /≈ (\d+) %/)).toBeNull();
  });

  it('le README NOMME chaque outil enregistré — un outil absent est une lacune', () => {
    /* Le récit du README s'était arrêté à `system_status` : `egress_review` et
       `web_search` existaient sans y figurer, et l'introduction disait encore
       « les sept outils écrits » devant une liste de dix noms.

       Un README qui décrit ce qui existe et en oublie le tiers n'est pas
       incomplet — il est FAUX, et c'est un lecteur qui le découvre. */
    const manquants = outilsEnregistres().filter((id) => !README.includes(id));
    expect(manquants, 'outils enregistrés absents du README').toEqual([]);
  });

  it('DÉTECTE un outil retiré du README — contrôle négatif du précédent', () => {
    const ampute = README.replaceAll('web_search', 'xxx');
    const manquants = outilsEnregistres().filter((id) => !ampute.includes(id));
    expect(manquants).toContain('web_search');
  });

  it('les MESURES elles-mêmes ne rendent pas zéro en silence', () => {
    // Un compteur qui rend 0 ferait passer n'importe quelle comparaison à 0.
    expect(adrMesurees()).toBeGreaterThan(50);
    expect(outilsEnregistres().length).toBeGreaterThan(10);
    expect(scenariosDores()).toBe(30);
    expect(invariantsSecurite()).toBe(15);
  });

  it('le balayage voit TOUS les fichiers d’outils, pas seulement quelques-uns', () => {
    // Sans ça, un `readdirSync` mal filtré donnerait un compte plus bas et
    // toutes les comparaisons suivraient sans broncher.
    const fichiers = readdirSync('src/tools').filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts' && statSync(join('src/tools', f)).isFile(),
    );
    expect(fichiers.length).toBeGreaterThanOrEqual(11);
    expect(fichiers).toContain('web.ts');
  });
});
