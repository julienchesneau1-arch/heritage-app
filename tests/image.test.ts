import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * L'IMAGE DE PRODUCTION — la panne qu'aucun test ne voyait.
 *
 * Le premier déploiement réel a échoué ainsi : image construite, base
 * `Healthy`, conteneur `app` créé… et rien qui réponde. Aucune erreur
 * applicative, aucun test rouge. La cause tenait à une ligne du Dockerfile.
 *
 * `CMD` lançait `node_modules/.bin/prisma migrate deploy`. Or `.bin/prisma`
 * est un LIEN SYMBOLIQUE que npm crée dans `node_modules/.bin/`, et l'étage
 * d'exécution ne copie que `prisma`, `@prisma` et `.prisma` — jamais
 * `.bin/`. Le conteneur sortait sur « not found » avant d'atteindre
 * `node server.js`.
 *
 * Reproduit hors Docker, en recomposant à l'identique l'ensemble copié :
 *   sh: node_modules/.bin/prisma: not found
 *
 * Ces tests lisent le Dockerfile parce que c'est le seul endroit où cette
 * classe de panne est visible sans construire l'image — ce que
 * l'environnement de développement ne peut pas faire (Docker Hub bloqué).
 * Un test faible sur le bon fichier vaut mieux qu'un test absent.
 */

const DOCKERFILE = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

/** L'étage d'exécution seul : c'est lui qui part en production. */
const RUNNER = DOCKERFILE.slice(DOCKERFILE.indexOf('AS runner'));

/** Le Dockerfile sans ses commentaires — sinon on teste sa documentation. */
const RUNNER_CODE = RUNNER.replace(/^\s*#.*$/gm, '');

describe('L’étage d’exécution n’invoque que ce qu’il embarque', () => {
  it('n’appelle rien depuis `node_modules/.bin` — ce dossier n’est pas copié', () => {
    const copieBin = /COPY[^\n]*node_modules\/\.bin/.test(RUNNER_CODE);
    const appelleBin = /node_modules\/\.bin\//.test(RUNNER_CODE);
    // Les deux sont acceptables ensemble ; c'est l'appel SANS la copie qui tue.
    expect(appelleBin && !copieBin, 'CMD/RUN appelle .bin sans que .bin soit copié').toBe(false);
  });

  it('appelle la CLI Prisma par son fichier, qui lui est copié', () => {
    expect(RUNNER_CODE).toMatch(/node\s+node_modules\/prisma\/build\/index\.js\s+migrate\s+deploy/);
    expect(RUNNER_CODE).toMatch(/COPY[^\n]*node_modules\/prisma\s+\.\/node_modules\/prisma/);
  });

  it('embarque le moteur et le client dont `migrate deploy` a besoin', () => {
    for (const chemin of ['node_modules/@prisma', 'node_modules/.prisma', '/app/prisma ']) {
      expect(RUNNER_CODE, chemin).toContain(chemin);
    }
  });

  it('applique les migrations AVANT de servir', () => {
    // `&&` et non `;` : une migration qui échoue ne doit pas laisser un
    // serveur répondre sur un schéma qu'il croit à jour.
    expect(RUNNER_CODE).toMatch(/migrate deploy\s*&&/);
  });

  it('remplace le shell par le serveur, pour que l’arrêt lui parvienne', () => {
    // Sans `exec`, `sh` reste PID 1 et n'transmet pas SIGTERM : `docker
    // compose stop` attendrait dix secondes puis tuerait le processus au
    // milieu d'une écriture.
    expect(RUNNER_CODE).toMatch(/&&\s*exec node server\.js/);
  });

  it('écoute sur toutes les interfaces du conteneur', () => {
    // Avec HOSTNAME=localhost, le serveur n'écouterait que la boucle locale
    // DU CONTENEUR : la redirection de port ne l'atteindrait jamais, et le
    // symptôme serait identique — « ne répond pas », sans erreur.
    expect(RUNNER_CODE).toMatch(/ENV HOSTNAME=0\.0\.0\.0/);
    expect(RUNNER_CODE).toMatch(/ENV PORT=3000/);
  });
});

describe('La pile ne peut pas prendre la place d’une autre application', () => {
  const COMPOSE = readFileSync(join(process.cwd(), 'docker-compose.yml'), 'utf8');
  const CODE = COMPOSE.replace(/^\s*#.*$/gm, '');

  it('fige le nom du projet, qui sinon dépendrait du dossier de clonage', () => {
    expect(CODE).toMatch(/^name:\s*heritage\s*$/m);
  });

  it('ne publie l’application que sur la boucle locale', () => {
    expect(CODE).toMatch(/'127\.0\.0\.1:\$\{PORT_LOCAL:-\d+\}:3000'/);
  });

  it('ne réclame 80 et 443 que derrière un profil explicite', () => {
    const proxy = CODE.slice(CODE.indexOf('proxy:'));
    expect(proxy).toMatch(/profiles:\s*\['autonome'\]/);
    // Et les ports publics n'apparaissent que dans ce bloc-là.
    const horsProxy = CODE.slice(0, CODE.indexOf('proxy:'));
    expect(horsProxy).not.toMatch(/'(80|443):/);
  });
});

describe('La sauvegarde ne peut pas se déclarer faite sans l’être', () => {
  /**
   * Le script disait « sauvegarde faite » sans rien savoir.
   *
   * Il écrivait `pg_dump ... | gzip > fichier`. Dans un tube, c'est le
   * DERNIER maillon qui donne le code de retour : `pg_dump` échouait,
   * `gzip` compressait zéro octet et sortait en 0, `set -e` ne voyait
   * rien. Et la purge des trente jours s'exécutait quand même — trente
   * nuits d'échec silencieux, et la dernière sauvegarde valide effacée
   * par le script censé la protéger.
   *
   * C'est la faute que ce dépôt poursuit partout ailleurs, posée sur le
   * seul fichier dont la défaillance est irréversible.
   */
  const SCRIPT = readFileSync(join(process.cwd(), 'sauvegarde.sh'), 'utf8');
  const CODE = SCRIPT.replace(/^\s*#.*$/gm, '');

  it('ne compresse jamais la sortie d’une commande dans un tube', () => {
    // `commande | gzip` masque l'échec de `commande`.
    expect(CODE).not.toMatch(/\|\s*gzip\s*>/);
  });

  it('vérifie le code de retour de ce qu’elle exécute', () => {
    expect(CODE).toMatch(/code=\$\?/);
    expect(CODE).toMatch(/if \[ "\$code" -ne 0 \]/);
  });

  it('refuse une sortie vide plutôt que de l’archiver', () => {
    expect(CODE).toMatch(/TAILLE_MINIMALE/);
    expect(CODE).toMatch(/sortie vide/);
  });

  it('relit l’archive écrite : un disque plein tronque sans le dire', () => {
    expect(CODE).toMatch(/gzip -t/);
  });

  it('écrit d’abord ailleurs, et ne promeut qu’après vérification', () => {
    // Sans cela, une exécution ratée écrase la sauvegarde de la veille.
    expect(CODE).toMatch(/temporaire=/);
    expect(CODE).toMatch(/mv "\$temporaire" "\$destination"/);
  });

  it('ne purge jamais avant d’avoir établi les sauvegardes du jour', () => {
    const purge = CODE.indexOf('-mtime');
    const derniereCapture = CODE.lastIndexOf('capturer "$DOSSIER');
    expect(derniereCapture).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(derniereCapture);
  });
});

describe('Le navigateur doit pouvoir donner le micro à l’application', () => {
  /**
   * `Permissions-Policy: microphone=()` n'autorise PERSONNE — l'origine
   * elle-même comprise. Le commentaire d'à côté disait « pas de micro sans
   * action explicite » ; l'en-tête disait autre chose, et c'est l'en-tête
   * que le navigateur applique.
   *
   * Le mode entretien ne pouvait donc enregistrer aucun mot en production :
   * le bouton s'affichait, on appuyait, il ne se passait rien. Aucune erreur
   * applicative, aucun test rouge — le navigateur refusait avant de
   * demander quoi que ce soit à qui que ce soit.
   *
   * Ce test lit une chaîne ; `outils/permissions.mjs` va jusqu'à appuyer
   * sur le bouton et compter les octets déposés. Les deux sont nécessaires :
   * l'outil trouve, ce test empêche de revenir en arrière sans le voir.
   */
  const CONFIG = readFileSync(join(process.cwd(), 'next.config.mjs'), 'utf8');
  const POLITIQUE = CONFIG.match(/'Permissions-Policy',\s*value:\s*'([^']*)'/)?.[1] ?? '';

  it('la politique de permissions est bien servie', () => {
    expect(POLITIQUE).not.toBe('');
  });

  it('le micro est autorisé à l’origine, et à elle seule', () => {
    expect(POLITIQUE).toMatch(/microphone=\(self\)/);
    expect(POLITIQUE).not.toMatch(/microphone=\(\)/);
    // `*` ouvrirait le micro à n'importe quel cadre embarqué.
    expect(POLITIQUE).not.toMatch(/microphone=\*/);
  });

  it('la géolocalisation et la caméra restent fermées — §3.1', () => {
    expect(POLITIQUE).toMatch(/geolocation=\(\)/);
    expect(POLITIQUE).toMatch(/camera=\(\)/);
  });

  it('les autres en-têtes de sécurité sont là', () => {
    for (const entete of [
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'X-Frame-Options',
      'Referrer-Policy',
    ]) {
      expect(CONFIG).toContain(entete);
    }
    expect(CONFIG).toMatch(/poweredByHeader:\s*false/);
  });
});
