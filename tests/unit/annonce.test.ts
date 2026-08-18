/**
 * « JAMAIS DE SUCCÈS NON VÉRIFIÉ » — au dernier pouce, là où c'est une phrase.
 *
 * LA RÈGLE 3 DE `CLAUDE.md`, ET ELLE NE SE NÉGOCIE PAS
 * ---------------------------------------------------------------------------
 *   > « L'email est envoyé » n'est autorisé qu'après confirmation du
 *   > fournisseur (ID de message, statut). Sinon : `UNKNOWN` ou `FAILED`,
 *   > et Jarvis le dit.
 *
 * Tout le dépôt existe pour ça. Le Verification Engine, `constrainToVerifiability`,
 * la distinction `UNKNOWN` / `FAILED` d'ADR-030, le contrat d'effet d'ADR-033 :
 * des milliers de lignes pour établir **quel statut est vrai**.
 *
 * Et puis ce statut devient une phrase, dans `src/apps/cli/report.ts` — la
 * couche d'affichage, celle que `docs/26 §4.2` classait en « ergonomie ».
 *
 * MESURÉ AVANT D'ÊTRE ÉCRIT
 * --------------------------
 * ```text
 * case 'UNKNOWN' → return "C'est fait."   → 752 tests VERTS
 * ```
 *
 * Toute la machinerie de vérification annulée par une ligne, dans le fichier
 * qu'aucun test ne référençait. **Le statut peut être juste et la phrase
 * mentir** : ce sont deux choses, et une seule était éprouvée.
 *
 * CE QUE CE FICHIER TESTE — ET CE QU'IL ÉVITE DE FIGER
 * -----------------------------------------------------
 * Pas la formulation. Geler « C'est fait. » interdirait de reformuler et
 * n'apporterait rien : ce qui compte n'est pas le mot, c'est la **propriété**
 * — un seul statut a le droit d'affirmer que c'est fait.
 *
 * Les tests sont donc écrits contre la phrase de `CONFIRMED` telle qu'elle
 * est, quelle qu'elle soit : si on la réécrit, ils suivent.
 */
import { describe, expect, it } from 'vitest';
import { announce, headline, mark } from '../../src/apps/cli/report.js';
import { JS } from '../../src/apps/server/ui.js';
import { VerificationStatus } from '../../src/core/types/domain.js';
import type { VerificationStatus as Statut } from '../../src/core/types/domain.js';

/** Tous les statuts, lus depuis l'énumération — jamais recopiés à la main. */
const STATUTS = VerificationStatus.options as readonly Statut[];

/**
 * Extrait une table du script réellement servi au navigateur.
 *
 * ⚠ L'ÉCHEC DOIT S'EXPLIQUER. Une première version laissait remonter
 * « Expected property name or '}' in JSON » — message exact, inutilisable :
 * il ne dit ni quelle table, ni pourquoi c'est grave. Un test rouge qu'on ne
 * comprend pas finit désactivé.
 *
 * Le `JSON.parse` échoue précisément quand la table a été RÉÉCRITE À LA MAIN
 * (objet JavaScript, clés sans guillemets) au lieu d'être dérivée — c'est-à-
 * dire dans le cas qu'ADR-062 existe pour empêcher. Le message le dit.
 */
function tableDe(nom: 'SAY' | 'MARK'): Record<string, string> {
  const trouve = new RegExp(`const ${nom} = (\\{.*?\\});`, 's').exec(JS);
  const brut = trouve?.[1];
  if (brut === undefined) {
    throw new Error(
      `Table ${nom} introuvable dans le script servi : la passerelle web ` +
        'ne rend plus les statuts, ou la forme a changé.',
    );
  }
  try {
    return JSON.parse(brut) as Record<string, string>;
  } catch {
    throw new Error(
      `Table ${nom} non dérivée : elle est écrite à la main dans ui.ts au lieu ` +
        'de venir de `report.ts` (ADR-062). Deux tables du même fait finissent ' +
        `par diverger — c'est exactement ce qui était arrivé.\n  Vu : ${brut.slice(0, 120)}`,
    );
  }
}

const clesDe = (nom: 'SAY' | 'MARK'): string[] => Object.keys(tableDe(nom));

const DETAIL = 'detail-temoin-42';
const dire = (status: Statut): string => announce({ status, detail: DETAIL });

describe('une annonce ne dit jamais plus que ce qui est établi', () => {
  it('les sept statuts sont lus depuis le TYPE, pas recopiés', () => {
    /* Si l'énumération gagne un statut, il apparaît ici automatiquement et les
       tests suivants l'exigent. Une liste recopiée aurait vieilli en silence —
       exactement la dérive corrigée par ADR-058. */
    expect(STATUTS.length).toBe(7);
    expect(STATUTS).toContain('CONFIRMED');
    expect(STATUTS).toContain('UNKNOWN');
    expect(STATUTS).toContain('PROVIDER_CONTRACT_VIOLATION');
  });

  /* ================================================================== *
   * LA PROPRIÉTÉ QUI PORTE LA RÈGLE 3
   * ================================================================== */

  it('SEUL `CONFIRMED` affirme que c’est fait', () => {
    /* LE TEST QUE LE SABOTAGE A RENDU NÉCESSAIRE.

       `case 'UNKNOWN' → "C'est fait."` laissait 752 tests verts. Ici, la phrase
       de `CONFIRMED` est prise telle qu'elle est — on ne fige aucune
       formulation — et on exige qu'aucun autre statut ne la produise. */
    const phraseDuSucces = dire('CONFIRMED');
    expect(phraseDuSucces.length).toBeGreaterThan(0);

    for (const statut of STATUTS) {
      if (statut === 'CONFIRMED') continue;
      expect(dire(statut), `${statut} affirme le succès`).not.toContain(
        phraseDuSucces,
      );
    }
  });

  it('tout statut NON confirmé rend le DÉTAIL — sinon l’humain ne peut pas juger', () => {
    /* `docs/12` : l'incertitude doit être instruite, pas seulement signalée.
       « Je ne sais pas » sans le motif laisse l'utilisateur devant un mur. */
    for (const statut of STATUTS) {
      if (statut === 'CONFIRMED') continue;
      expect(dire(statut), `${statut} n’explique rien`).toContain(DETAIL);
    }
  });

  it('l’incertitude a DROIT À PLUS DE MOTS que la réussite', () => {
    /* Ce n'est pas un caprice de style : c'est la règle que le fichier se donne
       à lui-même — « volontairement laconique sur le succès, explicite sur
       tout le reste ». On la rend vérifiable plutôt que déclarative.

       Elle a une conséquence concrète : un statut qui se résumerait à un mot
       serait aussi vite lu qu'un succès, donc aussi vite cru. */
    const succes = dire('CONFIRMED').length;
    for (const statut of STATUTS) {
      if (statut === 'CONFIRMED') continue;
      expect(dire(statut).length, `${statut} est plus court qu’un succès`).toBeGreaterThan(
        succes,
      );
    }
  });

  it('aucun statut ne tombe dans le vide — tous produisent une phrase', () => {
    // Un `switch` sans `default` protège au compilateur ; ce test protège si
    // quelqu'un ajoute un `default: return ''` pour « faire passer le build ».
    for (const statut of STATUTS) {
      expect(dire(statut).trim().length, `${statut} sans phrase`).toBeGreaterThan(10);
    }
  });

  it('les sept phrases sont DISTINCTES — deux statuts confondus ne servent à rien', () => {
    /* `UNKNOWN` et `FAILED` disent des choses opposées (ADR-030 : l'un ignore,
       l'autre a la preuve de l'absence d'effet). Les rendre identiques
       reviendrait à supprimer la distinction que tout le dépôt entretient. */
    const phrases = STATUTS.map((s) => dire(s));
    expect(new Set(phrases).size).toBe(STATUTS.length);
  });

  /* ================================================================== *
   * DEUX DISTINCTIONS QUE LE DÉPÔT PAIE CHER, ET QUI DOIVENT S'ENTENDRE
   * ================================================================== */

  it('`PROBABLE` ne se lit PAS comme une certitude', () => {
    /* ADR-030 : `PROBABLE` signifie « le fournisseur atteste, personne n'a
       relu ». C'est le statut le plus facile à sur-vendre — il est presque un
       succès, et le mot « probablement » est la seule chose qui l'en sépare. */
    const probable = dire('PROBABLE').toLowerCase();
    expect(probable).toMatch(/probable|pas pu vérifier|sans vérification/);
  });

  it('`FAILED` et `UNKNOWN` ne se confondent pas — l’un SAIT, l’autre non', () => {
    /* « Ça n'a pas marché » n'est autorisé que sur PREUVE d'absence d'effet.
       Un timeout ne l'autorise pas — il donne `UNKNOWN`. Si les deux phrases
       se ressemblaient, la distinction serait invisible pour l'utilisateur,
       donc inexistante là où elle compte. */
    expect(dire('FAILED')).not.toBe(dire('UNKNOWN'));
    expect(dire('UNKNOWN').toLowerCase()).toMatch(/ne sais pas|incertain|pas pu/);
  });

  it('`NOT_ATTEMPTED` dit qu’il ne s’est RIEN passé — pas qu’il y a eu un échec', () => {
    // Distinct d'un échec : rien n'a été tenté, donc rien n'a pu rater.
    expect(dire('NOT_ATTEMPTED')).not.toBe(dire('FAILED'));
    expect(dire('NOT_ATTEMPTED').toLowerCase()).toMatch(/rien tenté|rien n/);
  });

  it('`PROVIDER_CONTRACT_VIOLATION` met en cause la SOURCE, pas l’action', () => {
    /* `docs/22 §9` : il dit deux choses sans en mélanger aucune — j'ignore ce
       qui s'est passé, ET le service a fait autre chose que ce qu'il
       annonçait. Ne dire que la seconde laisserait croire à un échec. */
    const phrase = dire('PROVIDER_CONTRACT_VIOLATION').toLowerCase();
    expect(phrase).toMatch(/service|fournisseur/);
    expect(phrase).toMatch(/ne sais pas|pas ce qui/);
  });

  /* ================================================================== *
   * LE REPÈRE VISUEL — même discipline, même risque
   * ================================================================== */

  it('le SIGNE de `CONFIRMED` n’est porté par aucun autre statut', () => {
    /* Dans un terminal, le symbole est lu avant la phrase. Un `✓` sur un
       `UNKNOWN` ment plus vite que n'importe quel mot. */
    const signeDuSucces = mark('CONFIRMED');
    for (const statut of STATUTS) {
      if (statut === 'CONFIRMED') continue;
      expect(mark(statut), `${statut} porte le signe du succès`).not.toBe(
        signeDuSucces,
      );
    }
  });

  it('les sept signes sont distincts et non vides', () => {
    const signes = STATUTS.map((s) => mark(s));
    expect(new Set(signes).size).toBe(STATUTS.length);
    for (const s of signes) expect(s.trim().length).toBeGreaterThan(0);
  });

  /* ================================================================== *
   * LA PASSERELLE WEB — une seule table, deux rendus (ADR-062)
   * ================================================================== */

  it('le WEB connaît les sept statuts — il n’en connaissait que QUATRE', () => {
    /* LE DÉFAUT PRODUIT LE PLUS CONCRET DE LA SÉRIE.

       `ui.ts` portait sa propre table, écrite à la main :
       `{ CONFIRMED, PROBABLE, UNKNOWN, FAILED }`. Les trois autres tombaient
       sur un repli — l'identifiant BRUT affiché à l'utilisateur
       (« PROVIDER_CONTRACT_VIOLATION »), et le marqueur `·`, qui est dans le
       CLI celui de `NOT_ATTEMPTED`.

       **Le signal le plus fort du système portait le symbole du plus bénin.** */
    expect([...clesDe('SAY')].sort()).toEqual([...STATUTS].sort());
    expect([...clesDe('MARK')].sort()).toEqual([...STATUTS].sort());
  });

  it('le WEB dit EXACTEMENT ce que dit le CLI — sinon une source ment', () => {
    /* ADR-041 appliqué au rendu : deux tables du même fait finissent par
       diverger, et le jour où elles divergent aucune ne fait autorité. Le web
       DÉRIVE désormais d'ici ; ce test le vérifie sur le texte réellement
       servi au navigateur. */
    const say = tableDe('SAY');
    const marque = tableDe('MARK');

    for (const statut of STATUTS) {
      expect(say[statut], `SAY.${statut}`).toBe(headline(statut));
      expect(marque[statut], `MARK.${statut}`).toBe(mark(statut));
    }
  });

  it('`announce` reste la phrase PLUS le détail — la séparation n’a rien perdu', () => {
    // `headline` a été extraite d'`announce`. Le CLI doit continuer à dire les
    // deux : sans ça, on aurait réparé le web en abîmant le terminal.
    for (const statut of STATUTS) {
      if (statut === 'CONFIRMED') continue;
      expect(dire(statut)).toContain(headline(statut));
      expect(dire(statut)).toContain(DETAIL);
    }
    // `CONFIRMED` n'a pas de détail à instruire : c'est fait.
    expect(dire('CONFIRMED')).toBe(headline('CONFIRMED'));
  });

  /* ================================================================== *
   * CONTRÔLE NÉGATIF — les tests voient-ils vraiment ?
   * ================================================================== */

  it('DÉTECTE une annonce qui usurperait la phrase du succès', () => {
    /* Sans ce contrôle, « seul CONFIRMED affirme » pourrait passer sur un
       `announce` qui rendrait sept chaînes vides : aucune ne contiendrait la
       phrase du succès, et le test serait vert pour rien. */
    const succes = dire('CONFIRMED');
    const usurpateur = `${succes} (mais en réalité on ne sait pas)`;
    expect(usurpateur).toContain(succes);

    // Et la phrase du succès n'est pas vide — ce qui rendrait `toContain`
    // vrai partout.
    expect(succes.trim().length).toBeGreaterThan(3);
  });
});
