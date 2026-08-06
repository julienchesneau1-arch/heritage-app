import { limiteParIp } from '@/lib/rate-limit';
import { NextRequest } from 'next/server';
import { transcriptionService } from '@/services/transcription.service';
import { apiError, apiOk } from '@/lib/errors';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Traitement de la file de transcription.
 *
 * À appeler par une tâche planifiée (cron Vercel, GitHub Actions, systemd
 * timer — peu importe), toutes les minutes. La transcription ne peut pas
 * tourner dans le cycle d'une requête : dix minutes d'audio dépassent le
 * délai d'une fonction serverless.
 *
 * Protégée par un secret partagé : cette route déclenche des appels facturés.
 */
export async function POST(request: NextRequest) {
  // §8.2 : 100 req/min par IP, sur TOUTES les routes de l’API.
  const trop = await limiteParIp(request);
  if (trop) return trop;

  const secret = process.env.TRANSCRIPTION_WORKER_SECRET;
  if (!secret) return apiError('FORBIDDEN', 'TRANSCRIPTION_WORKER_SECRET non configuré.');

  const provided =
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    request.headers.get('x-worker-secret');
  if (provided !== secret) return apiError('FORBIDDEN');

  if (!transcriptionService.isAvailable) {
    return apiError('CONSTITUTION_BLOCK', 'Aucune clé OpenAI configurée : rien à traiter.');
  }

  const result = await transcriptionService.processPending();
  return apiOk(result);
}
