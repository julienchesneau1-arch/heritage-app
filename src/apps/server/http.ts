/**
 * Passerelle HTTP locale — le routeur, sans socket.
 *
 * Référence : PRD §30 (« une seule passerelle authentifiée », aucune exposition
 * publique), 03 §2, ADR-023.
 *
 * Le routeur est une fonction pure de requête vers réponse : il ne connaît ni
 * `node:http`, ni les flux, ni les sockets. C'est ce qui permet de le tester
 * intégralement — y compris les chemins d'échec d'authentification — sans
 * jamais ouvrir un port pendant la suite de tests.
 *
 * CE QUI EST AUTHENTIFIÉ
 * ----------------------
 * Tout `/api/*`. Les trois ressources statiques (`/`, `/app.css`, `/app.js`) ne
 * le sont pas : elles ne contiennent aucune donnée personnelle, et le jeton
 * arrive par le fragment d'URL, qui n'est jamais transmis au serveur. Exiger le
 * jeton pour servir la page rendrait l'amorçage impossible sans le placer dans
 * la requête — donc dans les journaux.
 *
 * PAS DE COOKIE, DONC PAS DE CSRF
 * -------------------------------
 * Le jeton voyage dans l'en-tête `Authorization`. Un navigateur ne l'attache
 * pas spontanément à une requête déclenchée par un autre site : le vecteur
 * CSRF n'existe pas ici. C'est une raison de fond de ne pas utiliser de cookie.
 */
import { fromClient } from '../../core/tools/identity.js';
import { z } from 'zod';
import { HTML, CSS, JS } from './ui.js';
import { bearerToken, tokenMatches, type AuthLimiter } from './auth.js';
import { auditReport, diagnosticReport, inboxReport } from '../reports.js';
import type { Runtime } from '../runtime.js';

export interface HttpRequest {
  readonly method: string;
  /** Chemin seul, sans chaîne de requête. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  /** Adresse de l'appelant — clé du verrouillage après échecs. */
  readonly address: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HandlerDeps {
  readonly runtime: Runtime;
  readonly token: string;
  readonly limiter: AuthLimiter;
  readonly sessionId: string;
  /** Reçoit les défauts internes. Ils vont dans le journal local, pas sur le réseau. */
  readonly onError?: (error: unknown) => void;
}

/** Taille maximale d'un corps de requête. Une phrase, pas un fichier. */
export const MAX_BODY_BYTES = 16 * 1024;

/**
 * En-têtes appliqués à **toute** réponse.
 *
 * `default-src 'self'` est tenable parce que l'interface n'utilise aucune
 * ressource distante : ni police, ni script, ni feuille de style externe. Une
 * page qui ne peut charger que ses propres ressources ne peut rien exfiltrer,
 * même si une injection parvenait à s'y glisser.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), interest-cohort=()',
  // La mémoire personnelle ne doit rester ni dans un cache disque ni dans un
  // proxy intermédiaire.
  'cache-control': 'no-store',
};

function respond(
  status: number,
  contentType: string,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': contentType, ...extra },
    body,
  };
}

function json(status: number, value: unknown): HttpResponse {
  return respond(status, 'application/json; charset=utf-8', JSON.stringify(value));
}

/* -------------------------------------------------------------------------- */
/* Corps de /api/say                                                          */
/* -------------------------------------------------------------------------- */

/**
 * La frontière. Rien n'entre dans le noyau sans franchir Zod (ADR-016).
 *
 * `operationId` vient du client : c'est la clé d'idempotence renvoyée par une
 * demande de confirmation. Le format est contraint pour qu'un client ne puisse
 * pas fabriquer une clé arbitraire susceptible de collisionner avec une autre.
 */
const SayBody = z.object({
  text: z.string().min(1).max(4000),
  operationId: z.uuid().optional(),
  confirm: z.boolean().optional(),
});

export function createHandler(deps: HandlerDeps) {
  const { runtime, token, limiter, sessionId } = deps;

  async function api(request: HttpRequest): Promise<HttpResponse> {
    if (request.path === '/api/say') {
      if (request.method !== 'POST') return json(405, { message: 'Méthode refusée.' });

      // Un `content-type` non JSON signale une requête qui n'a pas été écrite
      // pour cette API. On refuse plutôt que d'essayer de deviner.
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return json(415, { message: 'Corps attendu en application/json.' });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(request.body);
      } catch {
        return json(400, { message: 'Corps JSON illisible.' });
      }

      const checked = SayBody.safeParse(parsed);
      if (!checked.success) {
        return json(400, { message: 'Requête invalide.' });
      }

      await runtime.sessions.appendTurn(sessionId, {
        speaker: 'USER',
        content: checked.data.text,
      });

      const reply = await runtime.assistant.say(checked.data.text, {
        ...(checked.data.operationId === undefined
          ? {}
          : // Identité proposée par le client : frontière explicite (ADR-030).
            // Un client qui renvoie la même clé après une coupure fait
            // exactement ce qu'il faut — c'est ce qui empêche le double envoi.
            { operationId: fromClient(checked.data.operationId) }),
        ...(checked.data.confirm === undefined ? {} : { confirm: checked.data.confirm }),
      });

      if (reply.kind === 'DONE') {
        await runtime.sessions.appendTurn(sessionId, {
          speaker: 'JARVIS',
          content: `${reply.toolId} → ${reply.status}`,
        });
      }

      return json(200, reply);
    }

    if (request.method !== 'GET') return json(405, { message: 'Méthode refusée.' });

    if (request.path === '/api/audit') {
      const report = await auditReport(runtime);
      return report.ok ? json(200, report.value) : json(500, { message: report.error.message });
    }
    if (request.path === '/api/inbox') {
      const report = await inboxReport(runtime);
      return report.ok ? json(200, report.value) : json(500, { message: report.error.message });
    }
    if (request.path === '/api/diagnostic') {
      const report = await diagnosticReport(runtime);
      return report.ok ? json(200, report.value) : json(500, { message: report.error.message });
    }

    return json(404, { message: 'Inconnu.' });
  }

  return async function handle(request: HttpRequest): Promise<HttpResponse> {
    /* --- Ressources statiques : aucune donnée, aucun jeton --------------- */
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (request.path === '/') return respond(200, 'text/html; charset=utf-8', HTML);
      if (request.path === '/app.css') return respond(200, 'text/css; charset=utf-8', CSS);
      if (request.path === '/app.js') {
        return respond(200, 'text/javascript; charset=utf-8', JS);
      }
    }

    if (!request.path.startsWith('/api/')) {
      return respond(404, 'text/plain; charset=utf-8', 'Inconnu.\n');
    }

    /* --- Verrouillage avant vérification --------------------------------- */
    // L'ordre compte : une adresse verrouillée ne doit même pas pouvoir
    // consommer une comparaison de jeton. Sinon le verrou ne ralentit rien.
    if (limiter.isLocked(request.address)) {
      return json(429, {
        message: 'Trop de tentatives. Réessaie dans une minute.',
      });
    }

    const provided = bearerToken(request.headers['authorization']);
    if (provided === null || !tokenMatches(provided, token)) {
      limiter.recordFailure(request.address);
      // Aucun détail : ni la longueur attendue, ni la raison du refus.
      return json(401, { message: 'Jeton refusé.' });
    }
    limiter.recordSuccess(request.address);

    if (Buffer.byteLength(request.body) > MAX_BODY_BYTES) {
      return json(413, { message: 'Requête trop volumineuse.' });
    }

    try {
      return await api(request);
    } catch (error: unknown) {
      // Un défaut interne ne devient jamais un message détaillé côté client :
      // il part dans le journal local du serveur, pas sur le réseau.
      deps.onError?.(error);
      return json(500, { message: 'Erreur interne.' });
    }
  };
}
