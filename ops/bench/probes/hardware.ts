/**
 * Sonde matérielle — question 2 de l'audit.
 *
 * `08/C2` : le bénéfice MLX d'Ollama serait conditionné à 32 Go de mémoire
 * unifiée, en dessous desquels la machine reste sur l'ancien chemin Metal.
 * L'affirmation vient de sources secondaires et n'a pas pu être vérifiée sur le
 * blog officiel (domaine bloqué pendant l'audit).
 *
 * Cette sonde ne tranche pas la question — elle établit de quel côté du seuil
 * se trouve la machine, ce qui détermine si la question nous concerne.
 */
import { arch, platform, totalmem } from 'node:os';
import type { ProbeResult } from '../run.js';
import { sh } from '../run.js';

/** Seuil rapporté par les sources secondaires de l'audit (confiance ◐). */
const MLX_THRESHOLD_GB = 32;

export function probeHardware(): ProbeResult {
  const isMac = platform() === 'darwin';
  const isAppleSilicon = isMac && arch() === 'arm64';
  const memoryGb = Math.round(totalmem() / 1024 ** 3);

  const findings: Record<string, string | number | boolean> = {
    plateforme: platform(),
    architecture: arch(),
    'mémoire totale (Go)': memoryGb,
  };

  if (isMac) {
    const chip = sh('sysctl', ['-n', 'machdep.cpu.brand_string']);
    if (chip !== null) findings['puce'] = chip;
    const cores = sh('sysctl', ['-n', 'hw.perflevel0.logicalcpu']);
    if (cores !== null) findings['cœurs performance'] = cores;
  }

  if (!isAppleSilicon) {
    return {
      question: 'Q2 — seuil de 32 Go pour le backend MLX d\'Ollama (08 §7.2)',
      status: 'INDISPONIBLE',
      findings,
      missing:
        'Machine non-Apple Silicon. La question du seuil MLX ne se pose que sur ' +
        'Mac ARM ; sur les autres plateformes, Ollama conserve llama.cpp ' +
        '(ADR-007). À relancer sur la machine cible.',
      decides: 'ADR-007 — prérequis matériel à documenter à l\'installation.',
    };
  }

  const aboveThreshold = memoryGb >= MLX_THRESHOLD_GB;
  findings['seuil MLX supposé (Go)'] = MLX_THRESHOLD_GB;
  findings['au-dessus du seuil'] = aboveThreshold;

  return {
    question: 'Q2 — seuil de 32 Go pour le backend MLX d\'Ollama (08 §7.2)',
    status: 'MESURÉ',
    findings,
    decides: aboveThreshold
      ? 'Machine éligible au chemin MLX. Reste à confirmer le seuil sur source ' +
        'primaire, puis à mesurer le gain réel plutôt que de le supposer.'
      : `Machine sous le seuil supposé (${String(memoryGb)} Go < ${String(MLX_THRESHOLD_GB)} Go) : ` +
        'le gain MLX annoncé ne s\'appliquerait pas. À écrire dans les prérequis ' +
        'd\'installation avant que quiconque en soit surpris.',
  };
}
