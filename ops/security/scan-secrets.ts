/**
 * Scan de secrets — arbre de travail et historique git.
 *
 * Porte de sortie Phase 0 : « Aucun secret dans l'historique git (scan
 * automatisé) ».
 *
 * Ce scan est une barrière tardive : la vraie protection est de ne jamais
 * écrire un secret dans un fichier suivi. Mais un secret commité puis supprimé
 * reste dans l'historique pour toujours, et c'est précisément ce qu'un scan de
 * l'arbre de travail seul ne verrait pas.
 *
 * Sortie : code 0 si rien n'est trouvé, 1 sinon.
 */
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

export interface Pattern {
  readonly name: string;
  readonly regex: RegExp;
}

/** Exporté pour être testé : voir tests/security/secret-scan-patterns.test.ts. */
export const PATTERNS: readonly Pattern[] = [
  { name: 'Clé de style OpenAI', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Jeton GitHub', regex: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  // Pas de `\b` final sur ces deux motifs : la frontière de mot ne correspond
  // pas si la clé réelle est plus longue que la taille nominale, et un scan de
  // sécurité doit préférer le faux positif au silence.
  { name: 'Clé AWS', regex: /\bAKIA[0-9A-Z]{16}/ },
  { name: 'Clé Google', regex: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: 'Clé Anthropic', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Bloc de clé privée', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'JWT',
    regex: /\bey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/,
  },
  {
    name: 'Mot de passe en dur',
    regex: /(password|passwd|secret)\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
];

/**
 * Fichiers dont le contenu contient délibérément des motifs ressemblant à des
 * secrets : fixtures de test et documentation de la protection elle-même.
 */
const ALLOWLIST: readonly RegExp[] = [
  /^tests\/security\/secrets\.test\.ts$/,
  // Contient les échantillons de référence des motifs. Sans cette entrée, le
  // scan se signale lui-même — ce qu'il a d'ailleurs fait dès son premier
  // passage après commit, preuve qu'il ne se contente pas de l'arbre de travail.
  /^tests\/security\/secret-scan-patterns\.test\.ts$/,
  /^tests\/fixtures\//,
  /^ops\/security\/scan-secrets\.ts$/,
  /^src\/core\/observability\/logger\.ts$/,
  /^\.env\.example$/,
];

/**
 * Exceptions nominatives (fichier + motif), avec justification.
 *
 * Volontairement plus étroit qu'une entrée de liste blanche : blanchir un
 * fichier entier ferait passer un vrai secret ajouté plus tard au même endroit.
 * Ici, seule la combinaison fichier + motif est levée, et elle doit s'expliquer.
 */
interface PatternException {
  readonly file: RegExp;
  readonly pattern: string;
  readonly why: string;
}

const PATTERN_EXCEPTIONS: readonly PatternException[] = [
  {
    file: /^tests\/unit\/config\.test\.ts$/,
    pattern: 'Mot de passe en dur',
    why:
      'Valeur factice « canary_pw », utilisée précisément pour vérifier ' +
      "qu'aucun secret ne fuit dans la configuration publique.",
  },
  {
    file: /^tests\/golden\/scenarios\.test\.ts$/,
    pattern: 'Clé de style OpenAI',
    why:
      "Scénario doré B11. La redaction de `logger.ts` reconnaît les secrets À " +
      'LEUR FORME : un fixture qui ne ressemblerait pas à une clé rendrait ' +
      "l'assertion creuse — elle passerait parce que rien ne correspond, non " +
      'parce que la redaction fonctionne. La valeur « sk-secret-a-ne-jamais-' +
      'voir » est un littéral inutilisable, choisi pour se dénoncer à la ' +
      'lecture.',
  },
  {
    file: /^tests\/redteam\/failure-modes\.test\.ts$/,
    pattern: 'Mot de passe en dur',
    why:
      'Valeur littérale « peu-importe », passée à une base volontairement ' +
      'injoignable (port 1) pour éprouver la résilience. Aucune connexion ' +
      "n'aboutit avec ce mot de passe : c'est précisément le sujet du test.",
  },
];

/**
 * Exporté pour que l'ÉTROITESSE des exceptions soit éprouvée — voir
 * `tests/security/secret-scan-patterns.test.ts`.
 *
 * Une exception blanchit un couple (fichier, motif). Si elle blanchissait le
 * fichier entier, un vrai secret ajouté plus tard au même endroit passerait
 * sans bruit — et personne ne le saurait, puisque le scan resterait vert.
 */
export function isExcepted(file: string, pattern: string): boolean {
  return PATTERN_EXCEPTIONS.some(
    (e) => e.pattern === pattern && e.file.test(file),
  );
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // `git show HEAD:<fichier>` échoue bruyamment pour un fichier non encore
    // commité. C'est un cas normal, traité par l'appelant : on n'inonde pas la
    // sortie d'erreurs qui ne sont pas des erreurs.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

interface Finding {
  readonly where: string;
  readonly pattern: string;
  readonly excerpt: string;
}

function scanText(where: string, text: string, file: string): Finding[] {
  const findings: Finding[] = [];
  for (const { name, regex } of PATTERNS) {
    if (isExcepted(file, name)) continue;
    const match = regex.exec(text);
    if (match !== null) {
      const excerpt = match[0].slice(0, 12);
      findings.push({ where, pattern: name, excerpt: `${excerpt}…` });
    }
  }
  return findings;
}

function main(): void {
  const findings: Finding[] = [];

  // 1. Un fichier .env ne doit jamais être suivi.
  const tracked = git(['ls-files']).split('\n').filter((f) => f !== '');
  for (const file of tracked) {
    if (/^\.env$|^\.env\.(?!example)/.test(file)) {
      findings.push({
        where: file,
        pattern: 'Fichier .env suivi par git',
        excerpt: file,
      });
    }
  }

  // 2. Contenu des fichiers suivis.
  for (const file of tracked) {
    if (ALLOWLIST.some((r) => r.test(file))) continue;
    let content: string;
    try {
      content = git(['show', `HEAD:${file}`]);
    } catch {
      continue; // fichier non encore commité
    }
    findings.push(...scanText(file, content, file));
  }

  // 3. Historique complet — un secret supprimé y demeure.
  let history = '';
  try {
    history = git(['log', '--all', '-p', '--no-color']);
  } catch {
    console.warn('  (historique illisible — scan limité à l\'arbre de travail)');
  }
  if (history !== '') {
    // On découpe le diff par section `diff --git a/x b/y` plutôt que de
    // chercher le nom de fichier à rebours depuis chaque correspondance : le
    // rattachement fichier↔contenu devient exact, et la liste blanche cesse
    // d'être approximative.
    const seen = new Set<string>();

    for (const section of history.split(/^diff --git /m).slice(1)) {
      const header = /^a\/(\S+) b\/(\S+)/.exec(section);
      const file = header?.[2];
      if (file === undefined) continue;
      if (ALLOWLIST.some((r) => r.test(file))) continue;

      // Seules les lignes AJOUTÉES nous intéressent : une ligne supprimée a
      // déjà été signalée au commit qui l'a introduite.
      const added = section
        .split('\n')
        .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
        .join('\n');

      for (const finding of scanText(`historique git — ${file}`, added, file)) {
        const key = `${file}:${finding.pattern}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push(finding);
      }
    }
  }

  if (findings.length === 0) {
    console.log('✓ Aucun secret détecté (arbre de travail et historique).');
    process.exit(0);
  }

  console.error('✗ Secrets potentiels détectés :\n');
  for (const f of findings) {
    console.error(`  ${f.where}`);
    console.error(`    motif : ${f.pattern} (${f.excerpt})\n`);
  }
  console.error(
    'Un secret présent dans l\'historique y reste même après suppression du fichier.\n' +
      'Le révoquer immédiatement, puis réécrire l\'historique si nécessaire (03 §9).',
  );
  process.exit(1);
}

/**
 * Ne s'exécute qu'en invocation directe.
 *
 * Les motifs sont importés par les tests ; sans cette garde, importer le module
 * déclencherait un scan complet de l'historique git à chaque exécution de la
 * suite — et `process.exit` couperait le lanceur de tests.
 */
const invokedDirectly =
  argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;

if (invokedDirectly) main();
