/// <reference lib="webworker" />

/**
 * TRANSCRIPTION LOCALE — coût marginal nul.
 *
 * Whisper tourne ici, dans le navigateur de la famille. Trois conséquences,
 * et ce sont exactement celles qu'on cherchait :
 *
 *  1. COÛT ZÉRO. Aucun appel facturé. Une heure d'enregistrement coûte
 *     autant qu'une minute : rien. La durée cesse d'être un paramètre
 *     économique, donc une barrière à l'accès.
 *
 *  2. LA VOIX NE SORT PAS. L'audio n'est envoyé nulle part. C'est la seule
 *     configuration qui lève complètement la tension avec le §3.1, et la
 *     seule qu'on puisse proposer sans réserve à une famille qui refuse
 *     qu'un tiers entende sa grand-mère.
 *
 *  3. Le modèle est plus petit que celui de l'API, donc moins précis. C'est
 *     assumé et compensé ailleurs : les silences sont retirés en amont, le
 *     doute est signalé, un second avis peut être demandé, et rien n'entre
 *     dans la mémoire sans relecture humaine.
 *
 * Les poids sont téléchargés une fois puis mis en cache par le navigateur.
 * WebGPU quand il est disponible, WASM sinon — plus lent, mais fonctionnel.
 *
 * ── Ce qui transite tout de même par le réseau ──
 * L'AUDIO ne sort jamais de l'appareil : c'est l'engagement, et il est tenu.
 * En revanche la bibliothèque et les poids du modèle sont téléchargés depuis
 * un CDN, une fois, puis mis en cache. Une famille qui veut un appareil
 * totalement isolé doit héberger ces fichiers elle-même et pointer
 * TRANSCRIBE_LIB_URL / env.remoteHost vers son propre serveur.
 *
 * La bibliothèque est chargée à l'exécution, pas empaquetée : elle pèse
 * plusieurs mégaoctets et ne sert qu'à ceux qui demandent une transcription
 * locale. L'application ne doit pas s'alourdir pour tous à cause d'eux.
 */

/** Version épinglée : une mise à jour silencieuse changerait le comportement du modèle. */
const TRANSFORMERS_URL =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

export type WorkerRequest =
  | { type: 'load'; model: string }
  | { type: 'transcribe'; id: string; audio: Float32Array; model: string };

export type WorkerResponse =
  | { type: 'progress'; message: string; ratio?: number }
  | { type: 'ready' }
  | { type: 'result'; id: string; text: string; chunks: Array<{ start: number; end: number; text: string }> }
  | { type: 'error'; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface TransformersModule {
  pipeline: (task: string, model: string, options?: any) => Promise<any>;
  env: { allowLocalModels: boolean; remoteHost?: string };
}

let pipelinePromise: Promise<any> | null = null;
let loadedModel: string | null = null;

async function getPipeline(model: string) {
  if (pipelinePromise && loadedModel === model) return pipelinePromise;

  loadedModel = model;
  pipelinePromise = (async () => {
    // Import à l'exécution, hors du bundle : `webpackIgnore` empêche le
    // compilateur de tenter de résoudre et d'analyser ce paquet, qui n'est
    // fait que pour le navigateur.
    post({ type: 'progress', message: 'Chargement du moteur…' });
    const { pipeline, env } = (await import(
      /* webpackIgnore: true */ TRANSFORMERS_URL
    )) as TransformersModule;

    // Aucun modèle local servi par l'application : on s'appuie sur le cache
    // du navigateur, qui garde les poids d'une session à l'autre.
    env.allowLocalModels = false;

    const device = (await hasWebGpu()) ? 'webgpu' : 'wasm';
    post({ type: 'progress', message: `Préparation du moteur (${device})…` });

    return pipeline('automatic-speech-recognition', model, {
      device,
      dtype: device === 'webgpu' ? 'fp16' : 'q8',
      progress_callback: (progress: any) => {
        if (progress?.status === 'progress' && typeof progress.progress === 'number') {
          post({
            type: 'progress',
            message: 'Téléchargement du moteur (une seule fois)…',
            ratio: progress.progress / 100,
          });
        }
      },
    });
  })();

  return pipelinePromise;
}

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) return false;
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

scope.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === 'load') {
      await getPipeline(request.model);
      post({ type: 'ready' });
      return;
    }

    if (request.type === 'transcribe') {
      const transcriber = await getPipeline(request.model);
      post({ type: 'progress', message: 'Transcription en cours…' });

      const output = await transcriber(request.audio, {
        // Les mêmes garde-fous que côté serveur : aucune créativité, langue
        // forcée, et surtout aucun prompt qui orienterait la sortie.
        language: 'fr',
        task: 'transcribe',
        temperature: 0,
        return_timestamps: true,
        // Découpage interne : la durée d'un morceau reste bornée même si
        // l'enregistrement est long.
        chunk_length_s: 30,
        stride_length_s: 5,
      });

      post({
        type: 'result',
        id: request.id,
        text: typeof output?.text === 'string' ? output.text.trim() : '',
        chunks: Array.isArray(output?.chunks)
          ? output.chunks.map((chunk: any) => ({
              start: Number(chunk?.timestamp?.[0] ?? 0),
              end: Number(chunk?.timestamp?.[1] ?? 0),
              text: String(chunk?.text ?? '').trim(),
            }))
          : [],
      });
    }
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : 'Transcription locale impossible.',
    });
  }
});

function post(message: WorkerResponse) {
  scope.postMessage(message);
}
