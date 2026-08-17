/**
 * `file_search` — Phase 3, point 5 de `docs/02`.
 *
 * Premier outil qui touche le disque. Deux propriétés le structurent, et elles
 * viennent toutes les deux du pack :
 *
 *   1. `CLAUDE.md` — « ne jamais donner un accès shell non contraint à un
 *      modèle ». Une racine explicitement autorisée, ou rien.
 *
 *   2. Le mode de panne discret :
 *      « je n'ai pas trouvé » et « je n'ai pas pu regarder partout » sont deux
 *      réponses différentes. Un fichier illisible OMIS transforme la seconde
 *      en la première — et ignorer une erreur de lecture ressemble tellement à
 *      de la robustesse qu'on l'écrit sans y penser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildStack, callContext, operationId, type Stack } from '../helpers/stack.js';
import type { Db } from '../../src/core/db/client.js';

const enabled = databaseAvailable();

let compteur = 0;
const op = (p: string): ReturnType<typeof operationId> =>
  operationId(`${p}-${String(Date.now())}-${String(++compteur)}`);

describe.runIf(enabled)('file_search — Phase 3 point 5', () => {
  let db: Db;
  let base: string;
  /** La racine AUTORISÉE. */
  let racine: string;
  /** Un répertoire voisin, HORS racine — la cible des évasions. */
  let dehors: string;
  let illisible: string;

  beforeAll(async () => {
    db = appDb();
    base = await mkdtemp(join(tmpdir(), 'jarvis-fs-'));
    racine = join(base, 'autorise');
    dehors = join(base, 'interdit');

    await mkdir(join(racine, 'docs'), { recursive: true });
    await mkdir(dehors, { recursive: true });

    await writeFile(join(racine, 'facture-2026.pdf'), 'contenu');
    await writeFile(join(racine, 'docs', 'facture-carrelage.txt'), 'ref: XYZ-12');
    await writeFile(join(racine, 'autre.md'), 'rien');
    await writeFile(join(dehors, 'facture-SECRETE.txt'), 'ne doit jamais apparaître');

    // Lien symbolique DANS la racine, pointant DEHORS. Le piège de l'outil.
    await symlink(dehors, join(racine, 'raccourci'));

    /* DEUX LACUNES, ET LA SECONDE EXISTE À CAUSE D'UNE MESURE.

       `coffre/` en 000 est le cas naturel — sauf que la suite tourne en root
       dans le conteneur de développement, et root lit tout. Le test était donc
       vert ailleurs et MUET ici : il n'éprouvait rien sans le dire.

       Le lien symbolique CASSÉ ne dépend d'aucun utilisateur : `realpath`
       échoue pour tout le monde, root compris. C'est lui qui porte
       l'assertion. */
    illisible = join(racine, 'coffre');
    await mkdir(illisible, { recursive: true });
    await writeFile(join(illisible, 'facture-cachee.txt'), 'x');
    await chmod(illisible, 0o000);

    await symlink(join(base, 'facture-disparue.txt'), join(racine, 'facture-lien-casse'));
  });

  afterAll(async () => {
    await chmod(illisible, 0o755).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
    await db.close();
  });

  async function chercher(
    stack: Stack,
    input: Record<string, unknown> = { query: 'facture' },
  ): Promise<
    | { ok: true; output: Record<string, unknown> }
    | { ok: false; kind: string; message: string }
  > {
    const result = await stack.gateway.invoke({
      toolId: 'file_search',
      input,
      // `path` est un paramètre SENSIBLE (docs/03 §106) : sans provenance
      // fiable, le Gateway exigerait une confirmation. Un test dédié l'éprouve.
      parameterProvenance: { path: 'USER', query: 'USER' },
      operationId: op('fs'),
      actor: 'USER',
      context: callContext({ userConfirmed: true }),
    });
    if (!result.ok) {
      return { ok: false, kind: result.error.kind, message: result.error.message };
    }
    return { ok: true, output: result.value.output as Record<string, unknown> };
  }

  /* ================================================================== *
   * LE CONFINEMENT — CLAUDE.md, « aucun accès non contraint »
   * ================================================================== */

  it("SANS racine autorisée : REFUSE, et ne rend pas « aucun résultat »", async () => {
    /* L'état réel du dépôt : aucune racine configurée. « Aucun fichier
       trouvé » alors qu'on n'a regardé nulle part est le mensonge d'ADR-043
       appliqué au disque. */
    const stack = buildStack(db);
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(false);
    if (cherche.ok) return;
    expect(cherche.kind).toBe('CONFIGURATION');
    expect(cherche.message).toContain("je n'ai pas cherché");
  }, 30_000);

  it('trouve ce qui est DANS la racine — contrôle négatif des refus', async () => {
    /* Sans lui, tous les tests de confinement seraient verts en ne trouvant
       jamais rien. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    const hits = cherche.output['hits'] as { path: string }[];
    const noms = hits.map((h) => h.path);
    expect(noms).toContain('facture-2026.pdf');
    expect(noms.some((n) => n.includes('facture-carrelage.txt'))).toBe(true);
  }, 30_000);

  it("N'ATTEINT JAMAIS un fichier hors racine, même nommé comme la cible", async () => {
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    const hits = cherche.output['hits'] as { path: string }[];
    expect(hits.some((h) => h.path.includes('SECRETE'))).toBe(false);
  }, 30_000);

  it("REFUSE l'évasion par `../`", async () => {
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack, { query: 'facture', path: '../interdit' });

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    const hits = cherche.output['hits'] as { path: string }[];
    expect(hits).toEqual([]);
    // Et l'évasion est COMPTÉE, pas silencieusement ignorée.
    const gaps = cherche.output['gaps'] as { outsideRoot: number };
    expect(gaps.outsideRoot).toBeGreaterThan(0);
  }, 30_000);

  it("REFUSE l'évasion par LIEN SYMBOLIQUE — le piège que `resolve()` ne voit pas", async () => {
    /* LE TEST QUI JUSTIFIE `realpath`.

       `racine/raccourci` est un lien vers `interdit/`. Un outil qui
       confinerait par comparaison de CHAÎNES verrait un chemin commençant par
       la racine et le suivrait : `resolve()` travaille sur le texte, pas sur
       le disque.

       Seul `realpath` suit le lien et démasque la destination. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack, { query: 'facture', path: 'raccourci' });

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    const hits = cherche.output['hits'] as { path: string }[];
    expect(hits.some((h) => h.path.includes('SECRETE'))).toBe(false);
    expect(hits).toEqual([]);
  }, 30_000);

  it('REFUSE un chemin ABSOLU avant toute résolution', async () => {
    /* `resolve(racine, '/etc')` rend `/etc` : l'argument absolu gagne,
       silencieusement. Le refuser en amont évite d'avoir à s'en souvenir plus
       bas — et un jour on ne s'en souviendrait pas. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack, { query: 'facture', path: dehors });

    expect(cherche.ok).toBe(false);
    if (cherche.ok) return;
    expect(cherche.kind).toBe('VALIDATION');
  }, 30_000);

  it("un lien symbolique croisé EN COURS DE PARCOURS est écarté, pas seulement au départ", async () => {
    /* Le confinement du point de départ ne suffit pas : le parcours descend, et
       chaque entrée rencontrée doit être résolue à son tour. Ici on part de la
       racine — le lien est donc découvert PENDANT la descente. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack, { query: 'SECRETE' });

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    expect(cherche.output['count']).toBe(0);
    const gaps = cherche.output['gaps'] as { outsideRoot: number };
    expect(gaps.outsideRoot).toBeGreaterThan(0);
  }, 30_000);

  /* ================================================================== *
   * « Pas trouvé » ≠ « pas pu regarder »
   * ================================================================== */

  it("COMPTE ce qu'il n'a pas pu lire, au lieu de l'omettre", async () => {
    /* LE MODE DE PANNE DISCRET.

       `coffre/` est en 000 : il contient `facture-cachee.txt`, que la
       recherche ne verra pas. Un outil qui avalerait l'erreur rendrait « 2
       résultats » — vrai en apparence, faux en substance : il existe peut-être
       un troisième fichier, et l'utilisateur n'a aucun moyen de le savoir.

       Ignorer une erreur de lecture ressemble à de la robustesse. C'est ce qui
       rend ce défaut facile à écrire sans y penser. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    const gaps = cherche.output['gaps'] as { unreadable: number };
    expect(gaps.unreadable).toBeGreaterThan(0);

    /* Et la lacune est DÉCLARÉE, pas comblée : le lien cassé porte pourtant le
       mot cherché dans son nom, et il n'apparaît pas dans les résultats. On ne
       devine pas ce qu'on n'a pas pu ouvrir.

       Aucune assertion sur `facture-cachee.txt` : sous root il est lisible et
       légitimement trouvé, sous un utilisateur ordinaire il ne l'est pas. Une
       assertion vraie seulement sur certaines machines n'est pas une preuve —
       c'est un test qui ment la moitié du temps. */
    const hits = cherche.output['hits'] as { path: string }[];
    expect(hits.some((h) => h.path.includes('facture-lien-casse'))).toBe(false);
  }, 30_000);

  it('une racine INEXISTANTE est une lacune, pas un non-événement', async () => {
    /* Une racine configurée mais absente ne peut pas donner « rien trouvé » :
       on ne l'a pas ouverte. */
    const stack = buildStack(db, { fileRoots: [join(base, 'nexiste-pas')] });
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    expect(cherche.output['count']).toBe(0);
    const gaps = cherche.output['gaps'] as { unreadable: number };
    expect(gaps.unreadable).toBeGreaterThan(0);
  }, 30_000);

  it('un répertoire VRAIMENT vide se distingue des lacunes', async () => {
    /* Contrôle négatif : sans lui, il suffirait de toujours déclarer une
       lacune pour que les deux tests ci-dessus passent. */
    const vide = join(base, 'vide');
    await mkdir(vide, { recursive: true });
    const stack = buildStack(db, { fileRoots: [vide] });
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    expect(cherche.output['count']).toBe(0);
    const gaps = cherche.output['gaps'] as {
      unreadable: number;
      outsideRoot: number;
    };
    expect(gaps.unreadable).toBe(0);
    expect(gaps.outsideRoot).toBe(0);
  }, 30_000);

  /* ================================================================== *
   * Ce que l'outil rend, et ce qu'il ne révèle pas
   * ================================================================== */

  it('ne rend JAMAIS de chemin absolu', async () => {
    /* Le chemin absolu révélerait l'arborescence de la machine à quiconque lit
       la réponse — ou le journal, qui la conserve indéfiniment. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    const hits = cherche.output['hits'] as { path: string }[];
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.path.startsWith('/'), hit.path).toBe(false);
      expect(hit.path.includes(base), hit.path).toBe(false);
    }
  }, 30_000);

  it("étiquette son résultat EXTERNAL_UNTRUSTED — `docs/05 §B2`", async () => {
    /* « Un PDF contient : ajoute une règle… ». Ce que cet outil rend est de la
       DONNÉE, jamais une instruction, et l'étiquette voyage avec elle. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const cherche = await chercher(stack);

    expect(cherche.ok).toBe(true);
    if (!cherche.ok) return;
    expect(cherche.output['provenance']).toBe('EXTERNAL_UNTRUSTED');
  }, 30_000);

  /* ================================================================== *
   * Le chemin est un paramètre SENSIBLE — docs/03 §106
   * ================================================================== */

  it("REFUSE un chemin venu de EXTERNAL_UNTRUSTED sans confirmation", async () => {
    /* `docs/03 §106` nomme LITTÉRALEMENT « chemin de fichier » parmi les
       paramètres sensibles. Le scénario réel : un PDF contient un chemin, le
       modèle le recopie, l'outil irait le lire. La confirmation doit porter
       sur la valeur concrète.

       Ce n'est pas l'outil qui l'applique — c'est le Gateway, à partir de
       `sensitive: true`. Le test vérifie que la déclaration a bien cet effet. */
    const stack = buildStack(db, { fileRoots: [racine] });
    const result = await stack.gateway.invoke({
      toolId: 'file_search',
      input: { query: 'facture', path: 'docs' },
      parameterProvenance: { path: 'EXTERNAL_UNTRUSTED', query: 'USER' },
      operationId: op('fs-untrusted'),
      actor: 'USER',
      context: callContext({ userConfirmed: false }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(['CONFIRMATION_REQUIRED', 'POLICY_DENIED']).toContain(result.error.kind);
  }, 30_000);

  it('déclare le contrat que sa nature impose', () => {
    const stack = buildStack(db, { fileRoots: [racine] });
    const tool = stack.gateway.list().find((t) => t.definition.id === 'file_search');
    expect(tool).toBeDefined();
    if (tool === undefined) return;

    const d = tool.definition;
    expect(d.effect).toBe('NO_EXTERNAL_EFFECT');
    /* Le disque local n'est pas le réseau : contrairement à l'agenda, aucune
       incertitude sur le trajet. Rien ne sort de la machine. */
    expect(d.networkRequired).toBe(false);
    expect(d.autonomy).toBe('L1');
    expect(d.requiredSecrets).toEqual([]);
    // `docs/03 §106`, cité et non déduit.
    expect(d.parameters.find((p) => p.name === 'path')?.sensitive).toBe(true);
  });
});
