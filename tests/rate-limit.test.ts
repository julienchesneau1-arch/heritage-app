import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { clientIp, LIMITS } from '@/lib/rate-limit';

/**
 * LA LIMITE PAR IP — sur TOUTES les routes, et pas seulement sur deux.
 *
 * L'Annexe C cochait « Rate limiting actif sur les routes API ». Le
 * limiteur existait, et deux routes sur dix-neuf l'appelaient : la
 * checklist affirmait plus large que le code. Une case cochée qui déborde
 * de ce qu'elle recouvre est pire qu'une case vide — on ne revient jamais
 * regarder une ligne déjà cochée.
 *
 * La bonne place serait un `middleware.ts`, mais celui de Next 14 tourne
 * sur le runtime « edge », qui ne peut pas ouvrir de connexion Redis : un
 * compteur qui ne compte pas serait pire que pas de compteur. L'appel reste
 * donc dans chaque route, et c'est CE test qui empêche d'en oublier une —
 * la discipline n'est pas dans la mémoire de qui écrira la prochaine.
 */

const RACINE = join(process.cwd(), 'src', 'app', 'api');

function routes(dossier = RACINE): string[] {
  const trouvees: string[] = [];
  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) trouvees.push(...routes(chemin));
    else if (entree === 'route.ts') trouvees.push(chemin);
  }
  return trouvees;
}

/**
 * L'unique exemption, nommée ici pour qu'elle reste un choix.
 *
 * `/api/sante` est la sonde de l'orchestrateur : il l'interroge depuis une
 * IP unique, sans arrêt. La limiter reviendrait à lui répondre 429 aux
 * heures chargées, donc à lui faire redémarrer un conteneur en bonne santé
 * au moment où il sert le plus de monde.
 */
const EXEMPTES = new Set(['sante/route.ts']);

const TOUTES = routes();

describe('§8.2 — 100 req/min par IP sur les routes de l’API', () => {
  it('il y a bien des routes à vérifier', () => {
    // Sans cette ligne, un chemin faux rendrait « toutes conformes » sur
    // une liste vide.
    expect(TOUTES.length).toBeGreaterThanOrEqual(15);
  });

  it('la limite est celle que le document annonce', () => {
    expect(LIMITS.perIp).toEqual({ limit: 100, window: 60 });
    expect(LIMITS.passeurPerFamily).toEqual({ limit: 10, window: 60 });
  });

  it('chaque route appelle le limiteur, sauf l’exemption nommée', () => {
    const manquantes = TOUTES.filter((chemin) => {
      const relatif = relative(RACINE, chemin);
      if (EXEMPTES.has(relatif)) return false;
      return !readFileSync(chemin, 'utf8').includes('limiteParIp');
    }).map((chemin) => relative(RACINE, chemin));
    expect(manquantes).toEqual([]);
  });

  it('l’exemption existe vraiment, et elle est justifiée dans le fichier', () => {
    for (const relatif of EXEMPTES) {
      const source = readFileSync(join(RACINE, relatif), 'utf8');
      expect(source).not.toMatch(/limiteParIp/);
      // Exempter sans écrire pourquoi, c'est un oubli déguisé en décision.
      expect(source).toMatch(/orchestrateur/i);
    }
  });

  it('le limiteur passe AVANT le travail de la route', () => {
    // Compter après avoir interrogé la base ou appelé un modèle payant ne
    // protège de rien : la dépense a déjà eu lieu.
    for (const chemin of TOUTES) {
      const source = readFileSync(chemin, 'utf8');
      if (!source.includes('limiteParIp')) continue;
      for (const bloc of source.split(/export async function (?:GET|POST|PATCH|DELETE|PUT)/).slice(1)) {
        const limite = bloc.indexOf('limiteParIp');
        const prisma = bloc.indexOf('prisma.');
        expect(limite).toBeGreaterThan(-1);
        if (prisma > -1) expect(limite).toBeLessThan(prisma);
      }
    }
  });
});

describe('L’adresse du client ne se laisse pas inventer', () => {
  /**
   * `clientIp` lisait `X-Forwarded-For` et prenait la valeur de GAUCHE,
   * c'est-à-dire celle que le CLIENT envoie. Mesuré avant correction :
   * 120 requêtes avec une adresse différente à chaque fois, 120 servies,
   * sur une limite annoncée à 100 par minute. La §8.2 était appliquée à la
   * lettre et ne protégeait de rien.
   *
   * Deuxième essai, en prenant la DERNIÈRE valeur de la chaîne : toujours
   * 120 sur 120. Sans proxy devant, la dernière valeur EST celle du client.
   * Se rabattre sur cet en-tête revient donc à croire précisément qui
   * cherche à contourner.
   *
   * D'où la règle : `X-Real-IP`, que le proxy écrase, et rien d'autre.
   * Absent, on compte tout le monde ensemble — plus strict, jamais plus
   * permissif.
   */
  const avec = (entetes: Record<string, string>) =>
    new Request('http://localhost/api/x', { headers: entetes });

  it('sans TRUST_PROXY, aucun en-tête n’est cru', () => {
    delete process.env.TRUST_PROXY;
    expect(clientIp(avec({ 'X-Real-IP': '1.2.3.4' }))).toBe('direct');
    expect(clientIp(avec({ 'X-Forwarded-For': '1.2.3.4' }))).toBe('direct');
  });

  it('avec TRUST_PROXY, `X-Real-IP` fait foi', () => {
    process.env.TRUST_PROXY = '1';
    expect(clientIp(avec({ 'X-Real-IP': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('`X-Forwarded-For` seul ne suffit jamais', () => {
    process.env.TRUST_PROXY = '1';
    // Ni la première valeur, ni la dernière : l'en-tête entier est ignoré.
    expect(clientIp(avec({ 'X-Forwarded-For': '1.2.3.4' }))).toBe('sans-proxy');
    expect(clientIp(avec({ 'X-Forwarded-For': '1.2.3.4, 5.6.7.8' }))).toBe('sans-proxy');
  });

  it('`X-Real-IP` l’emporte sur ce que le client a pu envoyer', () => {
    process.env.TRUST_PROXY = '1';
    expect(
      clientIp(avec({ 'X-Forwarded-For': '9.9.9.9', 'X-Real-IP': '203.0.113.7' })),
    ).toBe('203.0.113.7');
    delete process.env.TRUST_PROXY;
  });

  it('les deux proxys documentés posent bien cet en-tête', () => {
    const CADDY = readFileSync(join(process.cwd(), 'Caddyfile'), 'utf8');
    const INSTALLEUR = readFileSync(join(process.cwd(), 'installer-a-cote.sh'), 'utf8');
    expect(CADDY).toMatch(/X-Real-IP/);
    expect(INSTALLEUR).toMatch(/X-Real-IP\s+\\?\$remote_addr/);
    // Et l'installateur active le réglage, sinon l'en-tête ne sert à rien.
    expect(INSTALLEUR).toMatch(/TRUST_PROXY/);
  });
});
