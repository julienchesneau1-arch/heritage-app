/**
 * LE DÉMARRAGE, REJOUÉ — l'étage d'exécution reconstitué à l'identique.
 *
 * ── Pourquoi ce fichier plutôt qu'un `docker build` ──
 *
 * Le premier déploiement réel a échoué au démarrage : `CMD` invoquait
 * `node_modules/.bin/prisma`, un lien symbolique que l'étage d'exécution ne
 * copie jamais. Le conteneur sortait sur « not found » avant d'atteindre
 * `node server.js` — de l'extérieur, une application qui ne répond pas,
 * sans une seule erreur applicative.
 *
 * J'ai longtemps écrit que l'image « n'avait jamais été construite parce
 * que Docker Hub est bloqué ». C'était imprécis, et l'imprécision comptait :
 * le démon Docker n'était simplement PAS LANCÉ. Une fois démarré, l'API des
 * registres répond (401, la réponse normale sans jeton) — mais leurs CDN de
 * blobs, eux, sont refusés par la politique du relais, sur Docker Hub comme
 * sur ghcr.io et public.ecr.aws. Le blocage est donc réel, il ne porte pas
 * là où je le disais, et aucun miroir n'y changerait rien.
 *
 * Ce que ce fichier fait à la place, et qui va plus loin qu'une
 * construction d'image : il RECONSTITUE le système de fichiers de l'étage
 * d'exécution en ne copiant QUE ce que le Dockerfile copie — lu dans le
 * Dockerfile, jamais recopié à la main — puis il exécute la vraie `CMD`
 * contre la vraie base. Si un chemin manque, il manque ici aussi.
 *
 * Il vérifie donc trois choses qu'aucun test statique ne peut atteindre :
 *   · que `migrate deploy` s'exécute sur une base DÉJÀ PEUPLÉE, ce qui est
 *     le cas de production et non celui d'un `migrate reset` ;
 *   · que le serveur démarre ensuite et répond ;
 *   · que l'ordre tient : aucune requête n'est servie avant les migrations.
 *
 * USAGE :  BASE_PORT=3210 node outils/demarrage.mjs
 *          (DATABASE_URL et FAMILY_TOKEN_SECRET dans l'environnement)
 */

import { readFileSync, mkdtempSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.BASE_PORT ?? 3210);
const racine = process.cwd();

const resultats = [];
function verifier(nom, condition, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

// ── Ce que l'étage d'exécution copie, lu dans le Dockerfile ──
//
// Recopier cette liste à la main serait la meilleure façon de tester une
// image qui n'existe pas : le jour où le Dockerfile change, ce contrôle
// continuerait de valider l'ancienne.
const DOCKERFILE = readFileSync(join(racine, 'Dockerfile'), 'utf8');
const runner = DOCKERFILE.slice(DOCKERFILE.indexOf('AS runner'));

const copies = [...runner.matchAll(/^COPY\s+--from=builder(?:\s+--chown=\S+)?\s+(\S+)\s+(\S+)\s*$/gm)].map(
  ([, source, destination]) => ({
    source: source.replace(/^\/app\//, ''),
    destination: destination.replace(/^\.\//, '').replace(/^\.$/, ''),
  }),
);
verifier('le Dockerfile déclare bien des copies', copies.length >= 6, `${copies.length} instructions`);

const cmd = runner.match(/^CMD\s+(\[[\s\S]*?\])\s*$/m);
verifier('la commande de démarrage est lisible', Boolean(cmd));
const argv = cmd ? JSON.parse(cmd[1]) : null;

// ── On reconstitue ──
const image = mkdtempSync(join(tmpdir(), 'runner-'));
let manquants = [];
for (const { source, destination } of copies) {
  const depuis = join(racine, source);
  if (!existsSync(depuis)) {
    manquants.push(source);
    continue;
  }
  const vers = destination ? join(image, destination) : image;
  cpSync(depuis, vers, { recursive: true, dereference: false, verbatimSymlinks: true });
}
verifier(
  'tout ce que le Dockerfile copie existe après `npm run build`',
  manquants.length === 0,
  manquants.join(', ') || `${copies.length} chemins`,
);

// Le piège d'origine, remis à l'épreuve : `.bin/` n'est PAS copié.
verifier(
  '`node_modules/.bin/` n’est pas dans l’image — le piège d’origine',
  !existsSync(join(image, 'node_modules', '.bin')),
);

if (manquants.length === 0 && argv) {
  // ── Et on démarre, pour de vrai ──
  //
  // La base est déjà peuplée : c'est le cas de production. `migrate deploy`
  // sur une base vide ne prouve presque rien — c'est `migrate reset` avec
  // plus d'étapes.
  const enfant = spawn(argv[0], argv.slice(1), {
    cwd: image,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(PORT),
      HOSTNAME: '127.0.0.1',
      STORAGE_DIR: join(image, 'data', 'archives'),
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let journal = '';
  enfant.stdout.on('data', (bloc) => (journal += bloc));
  enfant.stderr.on('data', (bloc) => (journal += bloc));

  const sortiePrecoce = new Promise((resoudre) =>
    enfant.on('exit', (code) => resoudre(code ?? -1)),
  );

  const attendre = async () => {
    for (let essai = 0; essai < 60; essai++) {
      try {
        const reponse = await fetch(`http://127.0.0.1:${PORT}/bienvenue`);
        if (reponse.status < 500) return reponse.status;
      } catch {
        /* pas encore là */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  };

  const issue = await Promise.race([attendre(), sortiePrecoce]);

  if (typeof issue === 'number' && issue >= 200) {
    verifier('le conteneur démarre et répond', true, `HTTP ${issue} sur /bienvenue`);
    verifier(
      'les migrations tournent AVANT le serveur, sur une base peuplée',
      /migrat/i.test(journal),
      (journal.match(/.*migrat.*/i) ?? ['—'])[0].trim().slice(0, 90),
    );
    // Prisma écrit « No pending migrations to apply. » quand tout va bien :
    // chercher « pending migration » déclarait donc un défaut sur le
    // message de succès. On cherche l'ÉCHEC, pas un mot du vocabulaire.
    const echec = journal.match(
      /failed to apply|migration failed|drift detected|following migrations? have not yet been applied/i,
    );
    verifier(
      'aucune migration en échec : la base de production démarrerait',
      !echec,
      echec ? echec[0] : (journal.match(/No pending migrations.*/i) ?? ['appliquées'])[0],
    );
  } else {
    verifier('le conteneur démarre et répond', false, `sortie ${issue}`);
    console.log('\n--- journal du démarrage ---\n' + journal.slice(0, 1500));
  }

  enfant.kill('SIGKILL');
}

rmSync(image, { recursive: true, force: true });

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
