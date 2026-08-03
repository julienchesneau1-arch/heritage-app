import { store } from './redis';

/**
 * §8.2 — 100 req/min par IP, 10 req/min par famille sur les routes Passeur.
 * Fenêtre glissante par tranche : suffisant, et sans état côté application.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
}

export async function rateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const slot = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = `ratelimit:${bucket}:${slot}`;
  const count = await store.incr(key);
  if (count === 1) await store.expire(key, windowSeconds);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export const LIMITS = {
  perIp: { limit: 100, window: 60 },
  passeurPerFamily: { limit: 10, window: 60 },
} as const;
