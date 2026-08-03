'use client';

import { useEffect } from 'react';

/**
 * Enregistrement du Service Worker. Silencieux : un échec ne doit jamais
 * produire de message à l'écran — l'application fonctionne sans lui.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* Pas de réseau, pas de HTTPS, ou navigateur récalcitrant : sans effet. */
    });
  }, []);

  return null;
}
