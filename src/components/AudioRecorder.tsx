'use client';

import { useRef, useState } from 'react';

/**
 * Enregistrement depuis le navigateur.
 *
 * Pensé pour la table de cuisine d'une grand-mère : un gros bouton, un
 * chronomètre, rien d'autre. Le fichier obtenu part par le même dépôt que
 * les photos — l'audio est l'original et doit être sauvé même si la
 * transcription échoue ou n'est jamais demandée.
 *
 * Le micro n'est demandé qu'au moment où l'on appuie : aucune capture
 * passive, jamais.
 */
export function AudioRecorder({ inputId }: { inputId: string }) {
  const [state, setState] = useState<'idle' | 'recording' | 'done' | 'unsupported'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function start() {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
      setState('unsupported');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });

        // ── La réécoute a lieu AVANT que le son ne parte ──
        //
        // On peut supprimer un enregistrement déjà déposé, et c'est prévu.
        // Mais « vous pouvez l'effacer de notre serveur » et « il n'a jamais
        // quitté votre appareil sans votre accord » ne sont pas la même
        // promesse — et c'est la seconde qu'on doit à quelqu'un qui vient de
        // dire à voix haute une chose qu'il regrette peut-être.
        //
        // L'URL est révoquée au réenregistrement : sans cela chaque essai
        // laisserait un blob en mémoire jusqu'au rechargement de la page.
        setPreview((ancienne) => {
          if (ancienne) URL.revokeObjectURL(ancienne);
          return URL.createObjectURL(blob);
        });

        // On alimente le champ fichier du formulaire : le dépôt suit
        // exactement le même chemin qu'une photo, sans code parallèle.
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        if (input) {
          const file = new File([blob], `enregistrement-${Date.now()}.webm`, { type: blob.type });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
        }
        setState('done');
      };

      recorder.start();
      recorderRef.current = recorder;
      setSeconds(0);
      setState('recording');
      timerRef.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    } catch {
      setState('unsupported');
    }
  }

  function stop() {
    recorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
  }

  if (state === 'unsupported') {
    return (
      <p className="justification">
        Cet appareil ne permet pas d’enregistrer depuis le navigateur, ou le micro a été refusé. Le
        dépôt d’un fichier audio reste possible.
      </p>
    );
  }

  /** Renoncer avant l'envoi. Le son n'a alors jamais quitté l'appareil. */
  function jeter() {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (input) input.value = '';
    setSeconds(0);
    setState('idle');
  }

  return (
    <div className="space-y-3">
      {preview ? (
        <div className="space-y-2">
          {/* `controls` natif : lecture, pause et déplacement dans la bande
              sans une ligne de script, et manipulable au clavier. */}
          <audio src={preview} controls className="w-full" />
          <button type="button" onClick={jeter} className="justification underline">
            Effacer et recommencer
          </button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
      {state === 'recording' ? (
        <>
          <button type="button" onClick={stop} className="btn-primary">
            Arrêter l’enregistrement
          </button>
          <span className="justification tabular-nums" role="timer" aria-live="off">
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
          </span>
        </>
      ) : (
        <button type="button" onClick={start} className="btn">
          {state === 'done' ? 'Réenregistrer' : 'Enregistrer une voix'}
        </button>
      )}
      {state === 'done' ? (
        <span className="justification">Réécoutez avant de déposer. Rien n’est parti pour l’instant.</span>
      ) : null}
      </div>
    </div>
  );
}
