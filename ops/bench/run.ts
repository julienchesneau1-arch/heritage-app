/**
 * Banc de mesure.
 *
 * Répond aux sept questions ouvertes de `08 §7` — celles qu'aucune lecture ne
 * peut trancher. Conçu pour être exécuté sur la machine cible (le Mac de
 * Julien), pas en CI.
 *
 *   pnpm bench                  # tout ce qui est mesurable ici
 *   pnpm bench -- --only=tools  # une seule sonde
 *
 * PRINCIPE : ce banc ne devine jamais. Quand une mesure est impossible faute
 * d'outil ou de corpus, il le dit et explique quoi installer. Un banc qui
 * renvoie une valeur plausible en l'absence de mesure est pire qu'un banc vide.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeHardware } from './probes/hardware.js';
import { probeRuntime } from './probes/runtime.js';
import { probeToolCalling } from './probes/tool-calling.js';

export type ProbeStatus = 'MESURÉ' | 'INDISPONIBLE' | 'ÉCHEC';

export interface ProbeResult {
  readonly question: string;
  readonly status: ProbeStatus;
  readonly findings: Readonly<Record<string, string | number | boolean>>;
  /** Ce qu'il faut installer ou fournir quand le statut est INDISPONIBLE. */
  readonly missing?: string;
  /** Ce que ce résultat décide, en une phrase. */
  readonly decides?: string;
}

export function sh(command: string, args: readonly string[]): string | null {
  try {
    return execFileSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const PROBES: readonly {
  id: string;
  run: () => Promise<ProbeResult> | ProbeResult;
}[] = [
  { id: 'hardware', run: probeHardware },
  { id: 'runtime', run: probeRuntime },
  { id: 'tools', run: probeToolCalling },
];

/** Sondes non implémentées : déclarées explicitement plutôt que passées sous silence. */
const NOT_IMPLEMENTED: readonly ProbeResult[] = [
  {
    question: 'Q1 — WER français : Whisper vs Parakeet (08 §7.1)',
    status: 'INDISPONIBLE',
    missing:
      'Un corpus audio français annoté (30–60 min de dictée, commandes courtes, ' +
      'bruit ambiant), à déposer dans ops/bench/corpus/fr-audio/. ' +
      'Aucun corpus public ne reflète votre voix ni vos formulations : ' +
      'c\'est une mesure qui exige vos propres enregistrements.',
    findings: {},
    decides: 'ADR-008 — confirme ou infirme le choix de Whisper pour le français.',
  },
  {
    question: 'Q3 — Latence bout-en-bout VAD→STT→intention→outil→TTS (08 §7.3)',
    status: 'INDISPONIBLE',
    missing:
      'Les Phases 2 et 5 (Tool Gateway et pipeline voix). Mesurable dès que ' +
      'la chaîne existe ; jusque-là, toute valeur serait inventée.',
    findings: {},
    decides: 'Objectif « < 500 ms perçu » atteignable ou non.',
  },
  {
    question: 'Q4 — Qualité de récupération des trois voies (08 §7.4)',
    status: 'INDISPONIBLE',
    missing:
      'La Phase 1 (Memory Engine) et un corpus personnel réel avec ses ' +
      'requêtes de référence.',
    findings: {},
    decides: 'ADR-002 — faut-il introduire pg_textsearch (BM25) ?',
  },
  {
    question: 'Q6 — Barge-in < 300 ms (08 §7.6)',
    status: 'INDISPONIBLE',
    missing: 'La Phase 5 (Audio Gateway).',
    findings: {},
    decides: 'ADR-009 — Piper ou Kokoro selon la latence de première syllabe.',
  },
];

function render(results: readonly ProbeResult[]): void {
  for (const r of results) {
    const mark =
      r.status === 'MESURÉ' ? '✓' : r.status === 'INDISPONIBLE' ? '·' : '✗';
    console.log(`\n  ${mark} ${r.question}`);
    console.log(`    statut : ${r.status}`);

    for (const [key, value] of Object.entries(r.findings)) {
      console.log(`      ${key.padEnd(28)} ${String(value)}`);
    }
    if (r.missing !== undefined) {
      console.log(`    manque : ${r.missing.replace(/\n\s*/g, '\n             ')}`);
    }
    if (r.decides !== undefined) {
      console.log(`    décide : ${r.decides}`);
    }
  }
}

async function main(): Promise<void> {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg?.slice('--only='.length);

  console.log('\n  BANC DE MESURE JARVIS');
  console.log('  Répond aux questions ouvertes de docs/08 §7.\n');
  console.log(`  ${new Date().toISOString()}`);

  const results: ProbeResult[] = [];
  for (const probe of PROBES) {
    if (only !== undefined && only !== probe.id) continue;
    try {
      results.push(await probe.run());
    } catch (error: unknown) {
      results.push({
        question: `Sonde « ${probe.id} »`,
        status: 'ÉCHEC',
        findings: {
          erreur: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  if (only === undefined) results.push(...NOT_IMPLEMENTED);

  render(results);

  const measured = results.filter((r) => r.status === 'MESURÉ').length;
  console.log(
    `\n  ${String(measured)}/${String(results.length)} question(s) mesurée(s).\n`,
  );

  const outDir = join(process.cwd(), 'ops', 'bench', 'results');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`);
  writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`  Résultats : ${outFile}\n`);
}

main().catch((error: unknown) => {
  console.error('Banc interrompu :', error);
  process.exit(1);
});
