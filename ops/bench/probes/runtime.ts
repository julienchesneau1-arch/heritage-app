/**
 * Sonde des runtimes locaux — question 7 de l'audit (empreinte mémoire) et
 * prérequis des autres sondes.
 *
 * ADR-007 : Ollama est le runtime de référence, jamais une dépendance dure.
 * Cette sonde constate ce qui est présent ; elle n'installe rien.
 */
import type { ProbeResult } from '../run.js';
import { sh } from '../run.js';

const OLLAMA_URL = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';

interface OllamaTag {
  name: string;
  size: number;
}

async function listOllamaModels(): Promise<readonly OllamaTag[] | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('models' in body) ||
      !Array.isArray((body as { models: unknown }).models)
    ) {
      return null;
    }
    const models = (body as { models: unknown[] }).models;
    return models.flatMap((m): OllamaTag[] => {
      if (
        typeof m === 'object' &&
        m !== null &&
        'name' in m &&
        typeof (m as { name: unknown }).name === 'string'
      ) {
        const size =
          'size' in m && typeof (m as { size: unknown }).size === 'number'
            ? (m as { size: number }).size
            : 0;
        return [{ name: (m as { name: string }).name, size }];
      }
      return [];
    });
  } catch {
    return null;
  }
}

export async function probeRuntime(): Promise<ProbeResult> {
  const findings: Record<string, string | number | boolean> = {};

  const ollamaVersion = sh('ollama', ['--version']);
  findings['ollama (CLI)'] = ollamaVersion ?? 'absent';

  const llamaCpp = sh('llama-cli', ['--version']);
  findings['llama.cpp'] = llamaCpp === null ? 'absent' : 'présent';

  const models = await listOllamaModels();
  if (models === null) {
    return {
      question: 'Q7 — runtimes locaux et empreinte mémoire (08 §7.7)',
      status: 'INDISPONIBLE',
      findings,
      missing:
        `Aucun serveur Ollama joignable sur ${OLLAMA_URL}. ` +
        'Installer Ollama puis tirer au moins un modèle à évaluer ' +
        '(par exemple qwen3 et mistral-small — voir 08 §3.4). ' +
        'Le choix se fait au benchmark, pas au classement public.',
      decides: 'ADR-007 et le choix du modèle local de référence.',
    };
  }

  findings['modèles disponibles'] = models.length;
  for (const model of models.slice(0, 12)) {
    findings[`  ${model.name}`] = `${String(Math.round(model.size / 1024 ** 3))} Go`;
  }

  const totalGb = models.reduce((sum, m) => sum + m.size, 0) / 1024 ** 3;
  findings['empreinte disque totale (Go)'] = Math.round(totalGb * 10) / 10;

  return {
    question: 'Q7 — runtimes locaux et empreinte mémoire (08 §7.7)',
    status: models.length > 0 ? 'MESURÉ' : 'INDISPONIBLE',
    findings,
    ...(models.length === 0
      ? {
          missing:
            'Ollama répond mais aucun modèle n\'est installé. ' +
            '`ollama pull qwen3` pour commencer.',
        }
      : {}),
    decides:
      'Quels modèles peuvent être soumis au benchmark d\'appel d\'outils français.',
  };
}
