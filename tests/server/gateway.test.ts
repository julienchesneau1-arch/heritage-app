/**
 * La passerelle web, de bout en bout.
 *
 * Référence : PRD §30, 03 §2, ADR-023.
 *
 * Le routeur est monté sur le VRAI noyau — vraies politiques Cedar, vrai Policy
 * Gate, vrai journal. Une passerelle testée contre un noyau simulé ne
 * prouverait que notre intention, pas la propriété.
 *
 * Ce que ces tests cherchent à mettre en défaut :
 *   — une route de données joignable sans jeton ;
 *   — une réponse d'erreur qui renseigne l'attaquant ;
 *   — un chemin d'exécution propre au web, court-circuitant le Policy Gate.
 */
/* Couvre **B13** de `docs/05` — appareil hostile sur le réseau local :
   401 sur toute route de données, y compris un chemin `/api/` inexistant,
   et aucun message ne distingue « jeton absent » de « jeton faux ». */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';
import { createAuthLimiter, MAX_FAILURES } from '../../src/apps/server/auth.js';
import {
  createHandler,
  MAX_BODY_BYTES,
  type HttpRequest,
  type HttpResponse,
} from '../../src/apps/server/http.js';

const skip = !databaseAvailable();
const TOKEN = 'jeton-de-test-suffisamment-long-pour-passer';
const TAG = `web-${String(Date.now())}`;

/** Construit une requête. Par défaut : authentifiée, JSON, depuis le LAN. */
function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    path: '/',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '',
    address: '192.168.1.20',
    ...overrides,
  };
}

function say(text: string, extra: Record<string, unknown> = {}): HttpRequest {
  return request({
    method: 'POST',
    path: '/api/say',
    body: JSON.stringify({ text, ...extra }),
  });
}

function parse(response: HttpResponse): Record<string, unknown> {
  const parsed: unknown = JSON.parse(response.body);
  return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
}

describe.skipIf(skip)('passerelle web', () => {
  let runtime: Runtime;
  let handle: (request: HttpRequest) => Promise<HttpResponse>;

  beforeAll(async () => {
    const built = buildRuntime(appDb());
    if (!built.ok) throw new Error(built.error.message);
    runtime = built.value;

    const session = await runtime.sessions.start('NORMAL');
    if (!session.ok) throw new Error(session.error.message);

    handle = createHandler({
      runtime,
      token: TOKEN,
      limiter: createAuthLimiter(),
      sessionId: session.value.id,
    });
  });

  afterAll(async () => {
    await runtime.close();
  });

  /* ---------------------------------------------------------------- */
  /* Authentification                                                  */
  /* ---------------------------------------------------------------- */

  describe('authentification', () => {
    it('refuse toute route de données sans jeton', async () => {
      for (const path of ['/api/audit', '/api/inbox', '/api/diagnostic', '/api/say']) {
        const response = await handle(
          request({ path, headers: {}, address: `10.0.0.${String(path.length)}` }),
        );
        expect(response.status, path).toBe(401);
      }
    });

    it('refuse un mauvais jeton', async () => {
      const response = await handle(
        request({
          path: '/api/audit',
          headers: { authorization: 'Bearer mauvais-jeton' },
          address: '10.9.9.1',
        }),
      );
      expect(response.status).toBe(401);
    });

    it('ne renseigne pas l\'attaquant sur la raison du refus', async () => {
      // Ni la longueur attendue, ni « jeton absent » vs « jeton faux » : la
      // différence entre les deux messages serait déjà une information.
      const absent = await handle(request({ path: '/api/audit', headers: {}, address: '10.9.9.2' }));
      const faux = await handle(
        request({
          path: '/api/audit',
          headers: { authorization: 'Bearer x' },
          address: '10.9.9.3',
        }),
      );
      expect(absent.body).toBe(faux.body);
      expect(absent.body).not.toContain(TOKEN);
    });

    it('authentifie AVANT de router : une route inconnue ne se distingue pas', async () => {
      // Sinon, un 404 sur `/api/admin` et un 401 sur `/api/say` révéleraient la
      // surface exacte de l'API à quelqu'un qui n'a pas le jeton.
      const response = await handle(
        request({ path: '/api/inexistant', headers: {}, address: '10.9.9.4' }),
      );
      expect(response.status).toBe(401);
    });

    it('verrouille l\'adresse après des échecs répétés', async () => {
      const address = '10.9.9.50';
      for (let i = 0; i < MAX_FAILURES; i += 1) {
        await handle(request({ path: '/api/audit', headers: {}, address }));
      }
      const locked = await handle(request({ path: '/api/audit', headers: {}, address }));
      expect(locked.status).toBe(429);

      // Le verrou tient même avec le BON jeton : il protège l'adresse, pas la
      // requête. Une force brute qui trouve le jeton au 6ᵉ essai est arrêtée.
      const withToken = await handle(request({ path: '/api/audit', address }));
      expect(withToken.status).toBe(429);
    });

    it('ne verrouille pas les autres appareils du réseau', async () => {
      const response = await handle(request({ path: '/api/diagnostic' }));
      expect(response.status).toBe(200);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Ressources statiques                                              */
  /* ---------------------------------------------------------------- */

  describe('interface', () => {
    it('sert la page sans jeton — le jeton arrive par le fragment', async () => {
      const response = await handle(request({ path: '/', headers: {} }));
      expect(response.status).toBe(200);
      expect(response.body).toContain('<title>Jarvis</title>');
    });

    it('n\'appelle aucune ressource distante', async () => {
      // Condition de la CSP stricte : une page qui ne charge que ses propres
      // ressources ne peut rien exfiltrer, même injectée.
      const page = await handle(request({ path: '/', headers: {} }));
      expect(page.body).not.toMatch(/https?:\/\//);
      const script = await handle(request({ path: '/app.js', headers: {} }));
      expect(script.body).not.toMatch(/https?:\/\//);
    });

    it('applique les en-têtes de sécurité à toute réponse', async () => {
      for (const path of ['/', '/app.css', '/app.js']) {
        const response = await handle(request({ path, headers: {} }));
        expect(response.headers['content-security-policy'], path).toContain(
          "default-src 'self'",
        );
        expect(response.headers['x-content-type-options'], path).toBe('nosniff');
        expect(response.headers['referrer-policy'], path).toBe('no-referrer');
        expect(response.headers['cache-control'], path).toBe('no-store');
      }
    });

    it('n\'expose pas la mémoire à un cache intermédiaire', async () => {
      const response = await handle(request({ path: '/api/diagnostic' }));
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  /* ---------------------------------------------------------------- */
  /* Frontière d'entrée                                                */
  /* ---------------------------------------------------------------- */

  describe('frontière', () => {
    it('refuse un corps qui n\'est pas du JSON déclaré', async () => {
      const response = await handle(
        request({
          method: 'POST',
          path: '/api/say',
          headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'text/plain',
          },
          body: 'bonjour',
        }),
      );
      expect(response.status).toBe(415);
    });

    it('refuse un JSON illisible', async () => {
      const response = await handle(
        request({ method: 'POST', path: '/api/say', body: '{oups' }),
      );
      expect(response.status).toBe(400);
    });

    it('refuse un corps qui ne respecte pas le schéma', async () => {
      for (const body of ['{}', '{"text":""}', '{"text":123}', '{"text":"ok","confirm":"oui"}']) {
        const response = await handle(request({ method: 'POST', path: '/api/say', body }));
        expect(response.status, body).toBe(400);
      }
    });

    it('refuse une clé d\'opération qui n\'est pas un UUID', async () => {
      // La clé d'idempotence vient du client : un format libre permettrait de
      // viser délibérément l'opération d'un autre appel.
      const response = await handle(
        say('mes tâches', { operationId: '../../etc/passwd' }),
      );
      expect(response.status).toBe(400);
    });

    it('refuse un corps trop volumineux', async () => {
      const response = await handle(
        request({
          method: 'POST',
          path: '/api/say',
          body: JSON.stringify({ text: 'x'.repeat(MAX_BODY_BYTES) }),
        }),
      );
      expect(response.status).toBe(413);
    });

    it('refuse les méthodes non prévues', async () => {
      expect((await handle(request({ method: 'GET', path: '/api/say' }))).status).toBe(405);
      expect(
        (await handle(request({ method: 'POST', path: '/api/audit', body: '{}' }))).status,
      ).toBe(405);
    });
  });

  /* ---------------------------------------------------------------- */
  /* La même chaîne que le CLI                                         */
  /* ---------------------------------------------------------------- */

  describe('exécution', () => {
    it('traverse la chaîne complète et n\'annonce le succès qu\'après vérification', async () => {
      const response = await handle(say(`Ajoute ${TAG} à ma liste`));
      expect(response.status).toBe(200);

      const reply = parse(response);
      expect(reply['kind']).toBe('DONE');
      expect(reply['toolId']).toBe('task_create');
      // CONFIRMED n'est possible qu'après relecture de l'état réel : c'est le
      // Verification Engine qui l'a produit, pas le routeur.
      expect(reply['status']).toBe('CONFIRMED');
    });

    it('mémorise ce que l\'utilisateur ordonne de retenir', async () => {
      const written = await handle(say(`Retiens que ${TAG} est un test de passerelle`));
      expect(parse(written)['kind']).toBe('DONE');

      const found = await handle(say(`Que sais-tu sur ${TAG}`));
      const reply = parse(found);
      expect(reply['kind']).toBe('DONE');
      const output: Record<string, unknown> =
        typeof reply['output'] === 'object' && reply['output'] !== null
          ? { ...reply['output'] }
          : {};
      expect(Array.isArray(output['results'])).toBe(true);
    });

    it('dit ce qu\'il ne sait pas faire, sans prétendre avoir compris', async () => {
      const response = await handle(say('Envoie un mail à Paul'));
      const reply = parse(response);
      expect(reply['kind']).toBe('UNSUPPORTED');
      expect(String(reply['missing']).length).toBeGreaterThan(0);
    });

    it('demande une précision plutôt que de deviner', async () => {
      const response = await handle(say('Note que'));
      expect(parse(response)['kind']).toBe('CLARIFY');
    });

    it('rejoue la même opération au lieu d\'en créer une seconde', async () => {
      // Idempotence (ADR-013) : c'est ce qui rend sûr le bouton « Confirmer »
      // sur un téléphone dont la connexion Wi-Fi vacille.
      const operationId = '6f0e2b7c-6d1a-4f2f-9a3e-0b1c2d3e4f50';
      const first = await handle(say(`Ajoute ${TAG}-idem à ma liste`, { operationId }));
      const second = await handle(say(`Ajoute ${TAG}-idem à ma liste`, { operationId }));

      expect(parse(first)['kind']).toBe('DONE');
      expect(parse(second)['kind']).toBe('DONE');

      const tasks = parse(await handle(say('mes tâches')));
      const raw: unknown = tasks['output'];
      const output: Record<string, unknown> =
        typeof raw === 'object' && raw !== null ? { ...raw } : {};
      const list: unknown[] = Array.isArray(output['tasks']) ? output['tasks'] : [];
      const matching = list.filter((task) => {
        const item: Record<string, unknown> =
          typeof task === 'object' && task !== null ? { ...task } : {};
        return String(item['title']).includes(`${TAG}-idem`);
      });
      expect(matching).toHaveLength(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /* Rapports                                                          */
  /* ---------------------------------------------------------------- */

  describe('rapports', () => {
    it('répond depuis le journal, chaîne vérifiée', async () => {
      const response = await handle(request({ path: '/api/audit' }));
      expect(response.status).toBe(200);
      const report = parse(response);
      expect(report['chainValid']).toBe(true);
      expect(Array.isArray(report['events'])).toBe(true);
    });

    it('dit que la voie sémantique est indisponible plutôt que de la taire', async () => {
      const response = await handle(request({ path: '/api/diagnostic' }));
      const report = parse(response);
      expect(report['embeddings']).toBe(false);
      expect(report['cloud']).toBe(false);
      expect(Number(report['tools'])).toBeGreaterThan(0);
    });

    it('expose l\'inbox', async () => {
      const response = await handle(request({ path: '/api/inbox' }));
      expect(response.status).toBe(200);
      expect(Array.isArray(parse(response)['candidates'])).toBe(true);
    });
  });
});
