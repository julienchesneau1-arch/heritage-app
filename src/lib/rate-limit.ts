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

/**
 * ── L'IP DU CLIENT, ET POURQUOI LA PREMIÈRE VALEUR EST LA PIRE ──
 *
 * Cette fonction lisait `X-Forwarded-For` et prenait la valeur de GAUCHE.
 * Or cet en-tête est envoyé par le client : n'importe qui pouvait donc
 * s'inventer une IP différente à chaque requête et n'être jamais compté.
 * Mesuré plutôt que supposé — 120 requêtes avec un `X-Forwarded-For`
 * aléatoire : 120 servies, sur une limite annoncée à 100 par minute. La
 * §8.2 était appliquée à la lettre et ne protégeait de rien.
 *
 * Deux corrections :
 *
 *  · On ne fait confiance à ces en-têtes QUE derrière un proxy déclaré
 *    (`TRUST_PROXY`). Sans lui, tout le monde partage un seul compteur :
 *    c'est plus strict, jamais plus permissif. Une application exposée
 *    directement ne doit croire personne sur parole.
 *  · Derrière le proxy, on prend la DERNIÈRE valeur de `X-Forwarded-For` —
 *    celle que notre propre nginx a ajoutée (`$proxy_add_x_forwarded_for`
 *    concatène ce que le client a envoyé PUIS l'adresse réelle). Mieux
 *    encore : `X-Real-IP`, que nginx ÉCRASE (`$remote_addr`), donc qu'un
 *    client ne peut pas fabriquer. On l'essaie en premier.
 *
 * L'installateur pose les deux en-têtes et `TRUST_PROXY=1`. Sur une pile
 * différente, c'est à l'exploitant de vérifier que son proxy écrase bien
 * `X-Real-IP` avant d'activer ce réglage — sans quoi il rouvre le trou.
 */
export function clientIp(request: Request): string {
  if (process.env.TRUST_PROXY !== '1') return 'direct';

  const reel = request.headers.get('x-real-ip');
  if (reel) return reel.trim();

  /*
   * ── ET `X-FORWARDED-FOR` NE SERT PAS DE SECOURS ──
   *
   * Deuxième mesure, après correction : toujours 120 requêtes servies sur
   * 120 avec un en-tête inventé. La raison est nette une fois vue — sans
   * nginx devant, la « dernière » valeur de la chaîne EST celle du client.
   * Se rabattre sur cet en-tête revient donc à faire confiance à qui n'est
   * pas passé par le proxy, c'est-à-dire exactement à qui cherche à
   * contourner.
   *
   * On exige donc `X-Real-IP`, que le proxy ÉCRASE. S'il manque, la requête
   * n'a pas traversé notre proxy : on ne devine pas, on compte tout le
   * monde ensemble. Plus strict, jamais plus permissif.
   */
  return 'sans-proxy';
}

export const LIMITS = {
  perIp: { limit: 100, window: 60 },
  passeurPerFamily: { limit: 10, window: 60 },
} as const;

/**
 * ── LA LIMITE PAR IP, EN UN SEUL GESTE ──
 *
 * La §8.2 demande « 100 req/min par IP » sur les routes API. Deux routes
 * sur dix-neuf l'appliquaient, et la checklist de l'Annexe C cochait la
 * ligne comme faite : le document affirmait plus large que le code.
 *
 * Pourquoi pas un `middleware.ts` — ce qui serait la bonne place ? Parce
 * que le middleware de Next 14 tourne sur le runtime « edge », qui ne peut
 * pas ouvrir de connexion Redis. Un compteur qui ne compte pas serait pire
 * que pas de compteur.
 *
 * On garde donc un appel par route, et c'est un TEST qui empêche d'en
 * oublier une : `tests/rate-limit.test.ts` parcourt `src/app/api/**` et
 * échoue si un fichier de route n'appelle pas `limiteParIp`. La discipline
 * n'est pas dans la mémoire de qui écrit la prochaine route.
 *
 * Rend `null` quand le passage est autorisé, une réponse 429 sinon —
 * de sorte que l'appel tienne en une ligne au début du gestionnaire.
 */
export async function limiteParIp(request: Request): Promise<Response | null> {
  const { allowed } = await rateLimit(
    `ip:${clientIp(request)}`,
    LIMITS.perIp.limit,
    LIMITS.perIp.window,
  );
  if (allowed) return null;
  // Importé ici, et non en tête : `errors` importe des types de Next que
  // ce module n'a pas à connaître ailleurs.
  const { apiError } = await import('./errors');
  return apiError('RATE_LIMITED');
}
