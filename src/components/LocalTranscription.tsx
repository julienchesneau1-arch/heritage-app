'use client';

import { useRef, useState } from 'react';
import {
  detectSpeechSegments,
  mapChunkTimes,
  planChunks,
  sliceSamples,
  speechRatio,
} from '@/lib/audio-chunking';
import { LOCAL_MODELS, TARGET_SAMPLE_RATE, type LocalModelKey } from '@/lib/local-transcription';
import type { WorkerResponse } from '@/workers/transcribe.worker';

/**
 * Transcription dans le navigateur — coût nul, durée sans incidence,
 * audio jamais transmis.
 *
 * L'ordre des opérations compte : on décode, on retire les silences, PUIS
 * on transcrit. Retirer les silences en amont supprime la première cause
 * d'hallucination — un modèle privé de vide n'a pas l'occasion d'inventer —
 * et raccourcit d'autant le calcul.
 */
export function LocalTranscription({
  familyId,
  draftId,
  audioUrl,
  role,
}: {
  familyId: string;
  draftId: string;
  audioUrl: string;
  role: 'first' | 'second';
}) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [ratio, setRatio] = useState<number | null>(null);
  const [model, setModel] = useState<LocalModelKey>('rapide');
  const workerRef = useRef<Worker | null>(null);

  async function run() {
    setState('running');
    setRatio(null);
    setMessage('Lecture de l’enregistrement…');

    try {
      // 1. Décodage en 16 kHz mono, ce qu'attend Whisper.
      const response = await fetch(audioUrl);
      const encoded = await response.arrayBuffer();

      const AudioCtx =
        window.OfflineAudioContext ??
        (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext })
          .webkitOfflineAudioContext;
      const decoder = new AudioCtx(1, 1, TARGET_SAMPLE_RATE);
      const decoded = await decoder.decodeAudioData(encoded);

      const resampler = new AudioCtx(
        1,
        Math.ceil(decoded.duration * TARGET_SAMPLE_RATE),
        TARGET_SAMPLE_RATE,
      );
      const source = resampler.createBufferSource();
      source.buffer = decoded;
      source.connect(resampler.destination);
      source.start();
      const rendered = await resampler.startRendering();
      const samples = rendered.getChannelData(0);

      // 2. Retrait des silences. C'est ici que l'essentiel se joue.
      setMessage('Repérage des passages parlés…');
      const segments = detectSpeechSegments(samples, TARGET_SAMPLE_RATE);
      const chunks = planChunks(segments, 30);
      const spoken = speechRatio(segments, rendered.duration);

      if (segments.length === 0) {
        setState('error');
        setMessage('Aucune parole détectée dans cet enregistrement.');
        return;
      }

      const kept = sliceSamples(samples, TARGET_SAMPLE_RATE, segments);
      setMessage(
        `${Math.round(spoken * 100)} % de parole, ${chunks.length} passage${chunks.length > 1 ? 's' : ''}. Les silences ne sont pas transmis au modèle.`,
      );

      // 3. Transcription dans un worker, pour ne pas figer la page.
      const worker =
        workerRef.current ??
        new Worker(new URL('../workers/transcribe.worker.ts', import.meta.url));
      workerRef.current = worker;

      const text = await new Promise<{ text: string; chunks: WorkerChunk[] }>((resolve, reject) => {
        const onMessage = (event: MessageEvent<WorkerResponse>) => {
          const data = event.data;
          if (data.type === 'progress') {
            setMessage(data.message);
            setRatio(data.ratio ?? null);
          } else if (data.type === 'result') {
            worker.removeEventListener('message', onMessage);
            resolve({ text: data.text, chunks: data.chunks });
          } else if (data.type === 'error') {
            worker.removeEventListener('message', onMessage);
            reject(new Error(data.message));
          }
        };
        worker.addEventListener('message', onMessage);
        worker.postMessage({
          type: 'transcribe',
          id: draftId,
          audio: kept,
          model: LOCAL_MODELS[model].id,
        });
      });

      // 4. Recalage des horodatages sur le temps RÉEL de l'enregistrement.
      //    Le modèle a travaillé sur l'audio sans les silences : ses repères
      //    comptent dans un temps où les blancs n'existent pas. Sans ce
      //    recalage, la famille irait écouter au mauvais endroit.
      const recalé = mapChunkTimes(text.chunks, segments);

      // 5. Dépôt du texte. L'audio, lui, n'a jamais quitté l'appareil.
      setMessage('Enregistrement du brouillon…');
      const saved = await fetch(`/api/family/${familyId}/transcriptions/${draftId}/local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, model: LOCAL_MODELS[model].id, text: text.text, chunks: recalé }),
      });
      if (!saved.ok) throw new Error('Le brouillon n’a pas pu être enregistré.');

      // Le modèle occupe plusieurs centaines de mégaoctets : on rend la
      // mémoire dès que le travail est fait. Sur un téléphone, la garder
      // suffirait à faire tomber l'onglet.
      worker.terminate();
      workerRef.current = null;

      setState('done');
      setMessage('Terminé. Il reste à écouter et relire.');
      window.location.reload();
    } catch (error) {
      setState('error');
      setMessage(
        error instanceof Error ? error.message : 'La transcription locale a échoué sur cet appareil.',
      );
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`modele-${role}`} className="sr-only">
          Moteur de transcription
        </label>
        <select
          id={`modele-${role}`}
          value={model}
          onChange={(event) => setModel(event.target.value as LocalModelKey)}
          disabled={state === 'running'}
          className="min-h-[44px] rounded-sm border border-rule bg-transparent px-2 font-sans text-sm"
        >
          {Object.entries(LOCAL_MODELS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label}
            </option>
          ))}
        </select>

        <button type="button" onClick={run} disabled={state === 'running'} className="btn">
          {state === 'running'
            ? 'En cours…'
            : role === 'second'
              ? 'Demander un second avis'
              : 'Transcrire sur cet appareil'}
        </button>
      </div>

      <p className="justification">{LOCAL_MODELS[model].note}</p>

      {message ? (
        <p className="justification" role="status">
          {message}
          {ratio !== null ? ` ${Math.round(ratio * 100)} %` : ''}
        </p>
      ) : null}

      {state === 'idle' ? (
        <p className="justification">
          Le calcul a lieu sur cet appareil : rien n’est facturé, la durée n’a pas d’importance, et
          l’enregistrement n’est envoyé nulle part.
        </p>
      ) : null}
    </div>
  );
}

interface WorkerChunk {
  start: number;
  end: number;
  text: string;
}
