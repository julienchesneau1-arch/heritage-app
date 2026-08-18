/**
 * LES QUINZE INVARIANTS DE `docs/03`, RENDUS MÉCANIQUES.
 *
 * CE FICHIER EXISTE PARCE QU'UN CHIFFRE A MENTI PENDANT PLUSIEURS SPRINTS.
 * ---------------------------------------------------------------------------
 * `docs/28` affirmait « **9 des 15** invariants nommément référencés ». La
 * mesure en donne **sept**. Le neuf avait été hérité d'un rapport antérieur et
 * recopié sans être revérifié — et il penchait du côté flatteur, ce qui est le
 * sens dans lequel une erreur survit le plus longtemps.
 *
 * `docs/05` avait connu exactement la même dérive : quatorze scénarios dorés
 * sans aucun test, et personne ne l'avait vu parce que rien ne le vérifiait.
 * La réponse d'alors — `tests/golden/contract.test.ts` — n'a pas été d'écrire
 * les tests manquants, mais de **lier le document à la suite**. Ce fichier fait
 * pour `docs/03` ce que celui-là fait pour `docs/05`.
 *
 * TROIS ÉTATS, ET LE DEUXIÈME EST UNE DETTE, PAS UNE DÉROGATION
 * -------------------------------------------------------------
 *   NOMMÉ         un test cite `Sn`                  → rien à dire
 *   TRACÉ         la propriété est éprouvée ailleurs → la preuve est DÉSIGNÉE
 *   NON EXIGIBLE  le sous-système n'existe pas       → l'absence est VÉRIFIÉE
 *
 * « Non nommé » n'est pas « non prouvé », et c'est tout l'enjeu de la
 * distinction : S8 est tenu par le Data Firewall depuis F2 — la propriété est
 * éprouvée, le nom manque. Compter les noms mesure la **traçabilité** de la
 * preuve, pas son existence. Les confondre donnerait un chiffre qu'on ne sait
 * plus lire.
 *
 * CE QUI EMPÊCHE CE FICHIER D'ÊTRE UNE LISTE D'EXCUSES
 * -----------------------------------------------------
 * Chaque déclaration est **falsifiable**, et c'est la seule chose qui sépare un
 * registre d'un alibi :
 *
 *   TRACÉ         désigne des fichiers qui doivent exister ET contenir un
 *                 marqueur précis. Effacer l'assertion qui prouve l'invariant
 *                 fait rougir ce test — pas seulement supprimer le fichier.
 *   NON EXIGIBLE  désigne un chemin qui doit rester ABSENT. Le jour où le
 *                 sous-système est écrit, l'exemption tombe d'elle-même.
 *
 * ⚠ INFRASTRUCTURE DE TEST — il ne prouve aucun invariant, il prouve qu'on
 *   sait lesquels sont prouvés.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Extrait les identifiants d'invariant du bloc de `docs/03 §2`. */
export function invariantIds(markdown: string): readonly string[] {
  return [...markdown.matchAll(/^(S\d+)\.\s+\S/gm)].map((m) => m[1] ?? '');
}

/**
 * Neutralise l'ÉCHAPPEMENT, pas le contenu.
 *
 * ⚠ CE FICHIER A ROUGI DEUX FOIS POUR CETTE RAISON, ET AUCUNE N'ÉTAIT UN VRAI
 *   DÉFAUT D'INVARIANT.
 *
 * Un titre de test écrit `it('… l\'appel inverse …')` contient littéralement
 * `l\'appel` dans le source. Le marqueur cherchait `l'appel` et ne le trouvait
 * pas — le test signalait alors une preuve manquante là où seule la syntaxe de
 * la chaîne différait.
 *
 * Un test structurel doit viser la PROPRIÉTÉ, jamais l'encodage. C'est le même
 * raisonnement que `stripComments` dans `tests/lab/invariants.ts`, qui existe
 * déjà pour empêcher un test de proscrire un vocabulaire au lieu d'un
 * comportement.
 */
function sansEchappement(source: string): string {
  return source.replace(/\\(['"`])/g, '$1');
}

/** Tous les fichiers de test, sauf celui-ci — qui les cite forcément tous. */
function testSources(): readonly { file: string; content: string }[] {
  const found: { file: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('invariants-contract.test.ts')) {
        found.push({ file: full, content: readFileSync(full, 'utf8') });
      }
    }
  };
  walk('tests');
  return found;
}

/**
 * TRACÉ — la propriété est éprouvée, mais aucun test ne la NOMME.
 *
 * `marqueur` est le point dur : c'est un extrait de l'assertion qui porte
 * réellement l'invariant. Sans lui, cette table dirait « c'est prouvé quelque
 * part dans ce gros fichier », ce qu'on ne peut ni vérifier ni réfuter.
 *
 * `reserve` dit ce que la preuve NE couvre PAS. Une réserve vide serait
 * l'affirmation la plus forte du fichier ; elles sont donc comptées à part.
 */
interface Trace {
  readonly par: readonly string[];
  readonly marqueur: string;
  readonly reserve: string | null;
}

/**
 * CE QU'UNE PREUVE NE COUVRE PAS — indépendant de la CATÉGORIE.
 *
 * ⚠ CE REGISTRE A ÉTÉ SORTI DE `TRACES` PAR ADR-066, ET LA RAISON VAUT D'ÊTRE
 *   LUE. S12 y vivait comme réserve d'une entrée TRACÉE. Le jour où
 *   `tests/undo/engine.test.ts` l'a NOMMÉ, S12 a changé de catégorie — et sa
 *   réserve serait partie avec, alors que quatre outils inverses manquent
 *   toujours et qu'aucun moteur ne rejoue un `STATE_RESTORE`.
 *
 * > Gagner une capacité aurait fait CESSER DE SURVEILLER ce qui manque encore.
 *
 * Une réserve appartient à l'invariant, pas au tiroir dans lequel il est rangé.
 */
const RESERVES: Readonly<Record<string, string>> = {
  S12:
    'capture et exécution du défaire prouvées pour QUATRE outils inverses sur ' +
    'cinq (ADR-065/066/067) ; `calendar_delete` reste non écrit — seul effet ' +
    'externe — et aucun mécanisme ne rejoue une capture STATE_RESTORE',
  /* ⚠ S13 A QUITTÉ CE REGISTRE — ADR-069, et c'est le mouvement qu'on attend
     d'une réserve. Elle disait : « le cloud est éteint EN DUR, la clé de
     configuration n'a aucun effet, donc l'invariant est tenu par absence et non
     par un contrôle utilisateur. »

     La clé est désormais LUE. La réserve est LEVÉE, pas déplacée — la
     distinction compte : une réserve qu'on déménage sans la lever finit par
     décrire un état qui n'existe plus. */
};

const TRACES: Readonly<Record<string, Trace>> = {
  S4: {
    par: ['tests/tools/gateway.test.ts'],
    marqueur: 'POLICY_DENIED',
    reserve: null,
  },
  S5: {
    par: ['tests/policy/gate.test.ts'],
    marqueur: 'L3 exige une confirmation',
    reserve: null,
  },
  S8: {
    /* Tenu par MÉCANISME depuis F2, et pas seulement par l'absence de sortie :
       `mayEgress` est appelé par le Policy Gate, et le refus est éprouvé. */
    par: ['tests/privacy/classify.test.ts', 'tests/lab/exfiltration.test.ts'],
    marqueur: "mayEgress refuse à partir de SENSITIVE, et le Policy Gate l'APPELLE",
    reserve: null,
  },
  S9: {
    par: ['tests/lab/provider-fallback.test.ts'],
    marqueur: 'repli entre fournisseurs',
    reserve: null,
  },
  S10: {
    /* MARQUEUR PRIS DANS LE CODE, PAS DANS LA PROSE.

       `sansEchappement` rend désormais les titres utilisables, mais un titre
       se réécrit à la moindre relecture — une constante, non. `PROVIDER_DIRS`
       est ce qui porte réellement la propriété : c'est elle qui définit la
       frontière que l'invariant S10 protège. */
    par: ['tests/contracts/provider-isolation.test.ts'],
    marqueur: "PROVIDER_DIRS: readonly string[] = ['src/providers']",
    reserve: null,
  },
};

/**
 * NON EXIGIBLE — le sous-système que l'invariant contraint n'existe pas.
 *
 * `absent` est ce qui empêche cette catégorie d'être une échappatoire : c'est
 * un chemin qui doit rester introuvable. Le jour où quelqu'un l'écrit, ce test
 * rougit et l'exemption tombe — sans qu'on ait à s'en souvenir.
 */
const NON_EXIGIBLES: Readonly<Record<string, { manque: string; phase: string; absent: string }>> = {
  S11: {
    manque: "Update Engine — `docs/07` est spécifié, aucun module canary/rollback/twin n'existe",
    phase: 'docs/02 Phase 7',
    absent: 'src/core/update',
  },
};

describe('docs/03 — les quinze invariants sont-ils traçables ?', () => {
  const markdown = readFileSync('docs/03_SECURITY_AND_PRIVACY.md', 'utf8');
  const ids = invariantIds(markdown);
  const sources = testSources();

  const estNomme = (id: string): boolean => {
    const motif = new RegExp(`\\b${id}\\b`);
    return sources.some((s) => motif.test(s.content));
  };

  it('les quinze invariants sont bien lus depuis le document', () => {
    // Un extracteur qui ne trouve rien rendrait tout le reste vert pour la
    // pire des raisons — c'est le mode de panne qu'on garde en tête ici.
    expect(ids.length).toBe(15);
    expect(ids[0]).toBe('S1');
    expect(ids[14]).toBe('S15');
  });

  /* ================================================================== *
   * LE CHIFFRE, ÉCRIT DANS UN TEST PLUTÔT QUE DANS UN RAPPORT
   * ================================================================== */

  it('NEUF invariants sont nommés — et le chiffre est ici, pas dans un rapport', () => {
    const nommes = ids.filter(estNomme);

    /* `docs/28` a dit « neuf » pendant plusieurs sprints parce qu'un rapport se
       recopie sans se revérifier. Un test, lui, échoue. Ce chiffre doit monter
       — et le faire monter oblige à passer ici, ce qui est exactement le point. */
    expect(nommes).toEqual(['S1', 'S2', 'S3', 'S6', 'S7', 'S12', 'S13', 'S14', 'S15']);
    expect(nommes.length).toBe(9);
  });

  it('AUCUN invariant n\'est sans trace : ni nommé, ni désigné, ni exempté', () => {
    const sansTrace = ids.filter(
      (id) =>
        !estNomme(id) && TRACES[id] === undefined && NON_EXIGIBLES[id] === undefined,
    );

    if (sansTrace.length > 0) {
      throw new Error(
        `${String(sansTrace.length)} invariant(s) de docs/03 ne sont éprouvés ` +
          `nulle part et ne sont pas déclarés :\n  ${sansTrace.join(', ')}\n\n` +
          "Un invariant que rien ne rattache à une preuve ne peut pas être " +
          'invoqué le jour où il casse.',
      );
    }
    expect(sansTrace).toEqual([]);
  });

  it('un invariant NOMMÉ n\'est pas en plus déclaré TRACÉ — ce serait un doublon muet', () => {
    // Deux registres pour le même fait finiraient par diverger, et le jour où
    // ils divergent aucun ne fait autorité. Même raisonnement qu'ADR-041.
    for (const id of ids.filter(estNomme)) {
      expect(TRACES[id], `${id} est nommé ET déclaré tracé`).toBeUndefined();
      expect(NON_EXIGIBLES[id], `${id} est nommé ET déclaré non exigible`).toBeUndefined();
    }
  });

  /* ================================================================== *
   * CE QUI REND LES DÉCLARATIONS FALSIFIABLES
   * ================================================================== */

  it('chaque TRACÉ désigne des fichiers qui existent ET portent leur marqueur', () => {
    for (const [id, trace] of Object.entries(TRACES)) {
      expect(ids, `${id} n'existe pas dans docs/03`).toContain(id);
      expect(trace.par.length, `${id} ne désigne aucun fichier`).toBeGreaterThan(0);

      for (const fichier of trace.par) {
        expect(existsSync(fichier), `${id} désigne ${fichier}, introuvable`).toBe(true);
      }

      /* LE POINT DUR. Sans cette assertion, la table dirait « c'est prouvé
         quelque part dans ce gros fichier » — ce qu'on ne peut ni vérifier ni
         réfuter. Avec elle, effacer l'assertion qui porte l'invariant suffit à
         faire rougir ce test. */
      const trouve = trace.par.some((f) =>
        sansEchappement(readFileSync(f, 'utf8')).includes(trace.marqueur),
      );
      expect(trouve, `${id} : marqueur « ${trace.marqueur} » absent de ${trace.par.join(', ')}`).toBe(
        true,
      );
    }
  });

  it('chaque NON EXIGIBLE prouve que son sous-système est bien ABSENT', () => {
    for (const [id, exempt] of Object.entries(NON_EXIGIBLES)) {
      expect(ids).toContain(id);
      expect(exempt.manque.trim().length).toBeGreaterThan(20);
      expect(exempt.phase).toMatch(/docs\/02/);

      /* L'EXEMPTION S'AUTODÉTRUIT. Le jour où `src/core/update` existe, ce test
         rougit et S11 doit sortir de cette liste — personne n'a à s'en
         souvenir, et c'est toute la différence avec un commentaire. */
      expect(
        existsSync(exempt.absent),
        `${id} est exempté parce que ${exempt.absent} n'existe pas — or il existe`,
      ).toBe(false);
    }
  });

  /* ================================================================== *
   * LA DETTE EST CHIFFRÉE, PAS SEULEMENT DÉCRITE
   * ================================================================== */

  it('les preuves PARTIELLES sont comptées — S12 et S13 ne sont pas des acquis', () => {
    const avecReserve = Object.entries(RESERVES);

    /* Deux invariants sont tenus autrement qu'ils ne le prétendent :
         S12  la capture existe, l'exécution du défaire n'existe pas
         S13  le cloud est éteint EN DUR, pas par un contrôle utilisateur

       Les compter les rend impossibles à oublier. Les fondre dans « tracé »
       aurait produit un registre plus flatteur et moins vrai. */
    expect(avecReserve.map(([id]) => id).sort()).toEqual(['S12']);
    for (const [id, t] of avecReserve) {
      expect(t.length, `${id} : réserve trop vague`).toBeGreaterThan(40);
    }
  });

  it('la part NON NOMMÉE reste une dette visible, et elle est chiffrée', () => {
    const nommes = ids.filter(estNomme).length;
    const traces = Object.keys(TRACES).length;
    const exemptes = Object.keys(NON_EXIGIBLES).length;

    expect(nommes + traces + exemptes).toBe(ids.length);
    expect(traces).toBe(5);
    expect(exemptes).toBe(1);

    // Le taux publié par `docs/28`. Il est ici pour ne plus pouvoir dériver.
    expect(Math.round((nommes / ids.length) * 100)).toBe(60);
  });

  /* ================================================================== *
   * CONTRÔLES NÉGATIFS — l'extracteur voit-il vraiment ?
   * ================================================================== */

  it('DÉTECTE un invariant ajouté au document et oublié partout ailleurs', () => {
    const faux = markdown + '\nS99. Un invariant que personne n\'éprouve.\n';
    const avec = invariantIds(faux);

    expect(avec).toContain('S99');
    expect(avec.length).toBe(ids.length + 1);
    expect(TRACES['S99']).toBeUndefined();
    expect(NON_EXIGIBLES['S99']).toBeUndefined();
    expect(estNomme('S99')).toBe(false);
  });

  it('N\'EST PAS aveugle à un document vide ou déformé', () => {
    // Le mode de panne le plus dangereux d'un extracteur : rendre zéro et
    // déclarer la traçabilité parfaite.
    expect(invariantIds('')).toEqual([]);
    expect(invariantIds('S1 sans point ni texte')).toEqual([]);
    expect(invariantIds('### S1 — un titre, pas un invariant')).toEqual([]);
  });

  it('`sansEchappement` neutralise la SYNTAXE et rien d\'autre', () => {
    /* CONTRÔLE NÉGATIF DU CORRECTIF, et il est nécessaire : une normalisation
       trop large rendrait n'importe quel marqueur trouvable, donc le test des
       marqueurs vert quoi qu'il arrive — exactement le mode de panne qu'on
       cherche à éviter partout ailleurs dans ce fichier. */
    expect(sansEchappement("l\\'appel")).toBe("l'appel");
    expect(sansEchappement('dit \\"oui\\"')).toBe('dit "oui"');

    // Et surtout : il ne rapproche pas deux textes réellement différents.
    expect(sansEchappement('capture la donnée')).not.toContain('appel inverse');
    expect(sansEchappement('chemin\\\\vers')).toContain('\\');
  });

  it('DÉTECTE une désignation qui pointe vers un fichier inexistant', () => {
    // Contre-épreuve du test des marqueurs : sans elle, on ne saurait pas si
    // `existsSync` regarde vraiment.
    expect(existsSync('tests/security/invariants-contract.test.ts')).toBe(true);
    expect(existsSync('tests/security/ce-fichier-n-existe-pas.test.ts')).toBe(false);
  });
});
