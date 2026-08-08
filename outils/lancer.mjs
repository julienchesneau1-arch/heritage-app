/**
 * TOUT VÉRIFIER, EN UNE COMMANDE — `npm run verifier`.
 *
 * Seize outils vivent ici, chacun avec ses variables d'environnement et
 * son port. Un contrôle qu'on ne sait pas lancer est un contrôle qu'on ne
 * lance pas, et un contrôle qu'on ne lance pas ne protège de rien.
 *
 * Ce lanceur lit `.env`, démarre l'application si elle ne tourne pas, passe
 * les outils dans l'ordre, arrête ce qu'il a démarré, et rend un compte
 * unique. Il ne masque aucun échec : un outil rouge rend un code non nul.
 *
 * ── CE QUI N'EST PAS VÉRIFIÉ ICI, ET QUI NE PEUT PAS L'ÊTRE ──
 *
 *  · La transcription locale dans un vrai navigateur : la bibliothèque et
 *    le modèle viennent de jsDelivr et Hugging Face, injoignables depuis
 *    l'environnement de développement.
 *  · Le pilote de stockage contre Cloudflare R2 : `stockage-s3.mts` parle à
 *    un vrai serveur S3, ce qui n'est pas la même chose que le service de
 *    Cloudflare — ni sa latence, ni ses quotas, ni ses politiques.
 *  · L'image Docker elle-même : les CDN de blobs des registres sont refusés
 *    par la politique du relais. `demarrage.mjs` rejoue l'étage d'exécution
 *    à l'identique, ce qui en approche le plus.
 *  · Une famille réelle. Aucune n'a utilisé ce produit.
 *
 * USAGE :   npm run verifier
 *           npm run verifier -- --rapide    (saute l'échelle et les captures)
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const rapide = process.argv.includes('--rapide');
const BASE = process.env.BASE ?? 'http://localhost:3000';
const PORT = Number(new URL(BASE).port || 3000);

// ── L'environnement ──
if (!process.env.DATABASE_URL && existsSync('.env')) {
  for (const ligne of readFileSync('.env', 'utf8').split('\n')) {
    const trouve = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (trouve && !process.env[trouve[1]]) process.env[trouve[1]] = trouve[2];
  }
}
for (const requis of ['DATABASE_URL', 'FAMILY_TOKEN_SECRET']) {
  if (!process.env[requis]) {
    console.error(`✗ ${requis} manquant. Renseignez-le dans .env — voir .env.example.`);
    process.exit(1);
  }
}

const joignable = async () => {
  try {
    await fetch(`${BASE}/bienvenue`);
    return true;
  } catch {
    return false;
  }
};

// ── L'application ──
let serveur = null;
if (!(await joignable())) {
  if (!existsSync('.next/BUILD_ID')) {
    console.error('✗ Pas de compilation. Lancez `npm run build` d’abord.');
    process.exit(1);
  }
  console.log(`· L’application ne répond pas sur ${BASE} : je la démarre.`);
  serveur = spawn('npm', ['run', 'start'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
    detached: true,
  });
  for (let essai = 0; essai < 40 && !(await joignable()); essai++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await joignable())) {
    console.error('✗ L’application n’a pas démarré.');
    process.exit(1);
  }
  console.log('· Démarrée.\n');
}

/** `long` : coûteux, sauté par `--rapide`. */
const OUTILS = [
  ['etancheite.mjs', 'Étanchéité — deux familles, lecture ET écriture croisées'],
  ['accessibilite.mjs', 'Accessibilité — axe-core, WCAG 2.1 AA, 18 pages'],
  ['clavier.mjs', 'Clavier — pièges, contour de focus, ordre de tabulation'],
  ['permissions.mjs', 'Permissions — en-têtes, micro, enregistreur de bout en bout'],
  ['hors-ecran.mjs', 'Livre imprimé et hors-ligne, réseau réellement coupé'],
  ['demarrage.mjs', 'Démarrage — étage d’exécution rejoué, migrations comprises'],
  ['possession.mts', 'Possession — aller-retour export → restauration'],
  ['stockage-s3.mts', 'Stockage — le pilote S3 contre un vrai serveur S3'],
  ['echelle.mjs', 'Échelle — 5 000 récits fabriqués, mesurés, effacés', { long: true }],
  // La panne de base exige de pouvoir arrêter PostgreSQL : sans les deux
  // commandes, l'outil saute ce contrôle et le DIT, plutôt que de le
  // compter comme réussi.
  ['pannes.mjs', 'Pannes — 404, base coupée, retour à la normale'],
  // Le seul outil qui mesure une DURÉE plutôt qu'un instant : les trois
  // manières de mal vieillir du Passeur — se tarir, se répéter, se laisser
  // manger par une seule règle — sont toutes invisibles sur un jour.
  ['passeur.mts', 'Le Passeur — 180 jours simulés, tarissement, répétition, règles'],
  // Le retrait a huit mécanismes et le produit trente-quatre sorties.
  // Chacun a été écrit là où il a été écrit ; c'est le croisement des deux
  // qui n'avait jamais été fait.
  ['oubli.mts', 'L’oubli — huit retraits confrontés à trente-quatre sorties'],
  // Deux familles identiques, un seul écart : l'une ouvre la page
  // Transmission. Le budget de visibilité de la §3.2 en dépendait.
  ['conservateur.mts', 'Le Conservateur — budget de visibilité, deux familles comparées'],
  // Un signal est daté par nature : ses défauts ne se voient pas un mardi.
  ['signaux.mts', 'Le signal temporel — une année d’écrans d’accueil'],
  // Le seul contrôle qui débranche l'application pour de bon : le coffre
  // s'ouvre en `file://`, toute requête sortante échoue, et les données
  // embarquées sont réimportées dans une famille neuve (Annexe A point 7).
  ['coffre.mts', 'Le coffre — ouvert sans l’application, puis réimporté'],
];

const bilan = [];
for (const [fichier, titre, options = {}] of OUTILS) {
  if (rapide && options.long) {
    console.log(`↷ ${titre} — sauté (--rapide)`);
    bilan.push([titre, 'sauté']);
    continue;
  }
  console.log(`\n━━ ${titre} ━━`);
  const code = await new Promise((resoudre) => {
    const commande = fichier.endsWith('.mts') ? ['npx', ['tsx', `outils/${fichier}`]] : ['node', [`outils/${fichier}`]];
    const enfant = spawn(commande[0], commande[1], {
      env: {
        ...process.env,
        BASE,
        OUT: join(tmpdir(), 'axe.json'),
        // Un port distinct : `demarrage.mjs` lève sa propre instance, et
        // elle ne doit pas se disputer le port de celle qu'on mesure.
        BASE_PORT: String(PORT + 210),
        RECITS: process.env.RECITS ?? '5000',
        ARRET_BASE: process.env.ARRET_BASE ?? '',
        DEMARRAGE_BASE: process.env.DEMARRAGE_BASE ?? '',
        JOURS: process.env.JOURS ?? '180',
        // La campagne du Conservateur est jouée DEUX fois : elle a sa
        // propre durée, sans quoi le `JOURS=180` du Passeur ci-dessus la
        // ferait tourner 360 jours pour rien.
        JOURS_CONSERVATEUR: process.env.JOURS_CONSERVATEUR ?? '60',
        RECITS_CONSERVATEUR: process.env.RECITS_CONSERVATEUR ?? '40',
        JOURS_SIGNAUX: process.env.JOURS_SIGNAUX ?? '365',
      },
      stdio: 'inherit',
    });
    enfant.on('exit', (code) => resoudre(code ?? 1));
  });
  bilan.push([titre, code === 0 ? 'vert' : 'ROUGE']);
}

if (serveur) {
  console.log('\n· J’arrête l’application que j’ai démarrée.');
  try {
    process.kill(-serveur.pid, 'SIGKILL');
  } catch {
    serveur.kill('SIGKILL');
  }
}

console.log('\n════════ BILAN ════════');
for (const [titre, etat] of bilan) {
  console.log(`${etat === 'vert' ? '✓' : etat === 'sauté' ? '↷' : '✗'} ${titre.padEnd(58)} ${etat}`);
}
const rouges = bilan.filter(([, etat]) => etat === 'ROUGE');
console.log(
  rouges.length === 0
    ? '\nTout est vert. Rappel : cela ne dit rien de la transcription locale, ' +
        'de Cloudflare R2, de l’image Docker, ni d’une famille réelle.'
    : `\n${rouges.length} outil(s) en échec.`,
);
process.exit(rouges.length === 0 ? 0 : 1);
