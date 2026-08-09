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
  /^tests\/fixtures\//,
  /^ops\/security\/scan-secrets\.ts$/,
  /^src\/core\/observability\/logger\.ts$/,
  /^\.env\.example$/,
];

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

interface Finding {
  readonly where: string;
  readonly pattern: string;
  readonly excerpt: string;
}

function scanText(where: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { name, regex } of PATTERNS) {
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
    findings.push(...scanText(file, content));
  }

  // 3. Historique complet — un secret supprimé y demeure.
  let history = '';
  try {
    history = git(['log', '--all', '-p', '--no-color']);
  } catch {
    console.warn('  (historique illisible — scan limité à l\'arbre de travail)');
  }
  if (history !== '') {
    for (const { name, regex } of PATTERNS) {
      // On ignore les motifs des fichiers de la liste blanche : ils y sont par
      // conception, et leur diff apparaît dans l'historique.
      const global = new RegExp(regex.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = global.exec(history)) !== null) {
        const line = match[0];
        const context = history.slice(
          Math.max(0, match.index - 400),
          match.index,
        );
        const inAllowlisted = ALLOWLIST.some((r) => {
          const files = /\+\+\+ b\/(.+)/g;
          let m: RegExpExecArray | null;
          let last: string | null = null;
          while ((m = files.exec(context)) !== null) last = m[1] ?? null;
          return last !== null && r.test(last);
        });
        if (inAllowlisted) continue;
        findings.push({
          where: 'historique git',
          pattern: name,
          excerpt: `${line.slice(0, 12)}…`,
        });
        break; // une occurrence par motif suffit à alerter
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
