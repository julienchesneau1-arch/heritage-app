/**
 * OBTENIR LE JETON DE RAFRAÎCHISSEMENT GOOGLE — ADR-108.
 *
 * `pnpm google:connecter`
 *
 * ⚠ CE SCRIPT N'EST PAS JARVIS. C'EST TOI QUI T'ÉQUIPES.
 * ---------------------------------------------------------------------------
 * `CLAUDE.md` interdit « un appel réseau sortant sans passer par le Data
 * Firewall ». La règle gouverne ce que **Jarvis** envoie : des données de
 * Julien, décidées par une politique, journalisées.
 *
 * Ici, rien de tout cela ne circule. L'opérateur échange **ses propres
 * identifiants de client OAuth** contre **son propre jeton**, avec le serveur
 * de jetons de Google, sur sa machine, parce qu'il vient de taper la commande.
 * Aucune mémoire, aucune note, aucune tâche n'est lue.
 *
 * La distinction n'est pas une commodité : si ce script lisait la base ou
 * envoyait autre chose que le code d'autorisation, il devrait passer par le
 * Firewall comme tout le reste. Un test vérifie qu'il n'importe rien du noyau.
 *
 * ⚠ LE JETON NE S'AFFICHE JAMAIS
 * ---------------------------------------------------------------------------
 * Il est écrit directement dans `.env`, et le script n'imprime qu'une
 * confirmation. Un jeton affiché reste dans l'historique du terminal, dans le
 * tampon de défilement, et dans la capture d'écran qu'on enverra pour demander
 * de l'aide. C'est la même discipline que `docs/03 §9` : un secret ne traverse
 * ni un log, ni un prompt, ni un contexte de modèle.
 *
 * ⚠ PORTÉE DEMANDÉE : L'AGENDA, ET RIEN D'AUTRE
 * ---------------------------------------------------------------------------
 * `calendar` seul. Pas Gmail, pas Drive, pas Contacts. Un jeton porte ce qu'on
 * lui a accordé ; demander large « au cas où » est la façon la plus simple de
 * perdre plus qu'on ne voulait le jour où il fuit.
 *
 * ⚠ CE QUI N'A PAS ÉTÉ ÉPROUVÉ
 * ---------------------------------------------------------------------------
 * **Ce script n'a jamais tourné contre Google.** Aucun compte n'est connecté
 * dans l'environnement où il a été écrit. Ce qui est éprouvé : la construction
 * de l'URL de consentement, la vérification PKCE, la réécriture de `.env`, et
 * chaque refus. Ce qui ne l'est pas : la réponse réelle du serveur de jetons.
 *
 * Même réserve qu'ADR-078 pour l'adaptateur lui-même, et elle se lève de la
 * même façon : en le lançant une fois.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

/** L'unique portée demandée. Écrite ici, et nulle part ailleurs. */
const PORTEE = 'https://www.googleapis.com/auth/calendar';

const AUTORISATION = 'https://accounts.google.com/o/oauth2/v2/auth';
const JETON = 'https://oauth2.googleapis.com/token';

const CHEMIN_ENV = '.env';
const CLE_JETON = 'GOOGLE_OAUTH_REFRESH_TOKEN';

/**
 * PKCE — `S256`, jamais `plain`.
 *
 * Sans lui, un code d'autorisation intercepté sur la boucle locale suffit à
 * obtenir le jeton. Avec lui, il faut aussi le vérificateur, qui n'a jamais
 * quitté ce processus.
 */
function pkce(): { verificateur: string; defi: string } {
  const verificateur = randomBytes(32).toString('base64url');
  const defi = createHash('sha256').update(verificateur).digest('base64url');
  return { verificateur, defi };
}

/** Lit une variable de `.env`. Le fichier, pas l'environnement du processus. */
function depuisEnv(cle: string): string | null {
  if (!existsSync(CHEMIN_ENV)) return null;
  for (const ligne of readFileSync(CHEMIN_ENV, 'utf8').split('\n')) {
    const nu = ligne.trim();
    if (nu.startsWith('#')) continue;
    const separateur = nu.indexOf('=');
    if (separateur < 0) continue;
    if (nu.slice(0, separateur).trim() !== cle) continue;
    const valeur = nu.slice(separateur + 1).trim();
    return valeur.length > 0 ? valeur : null;
  }
  return null;
}

/**
 * Écrit la valeur dans `.env`, en remplaçant la ligne existante.
 *
 * ⚠ ON RÉÉCRIT LA LIGNE, ON N'EN AJOUTE PAS UNE SECONDE. Deux lignes portant
 * la même clé donnent un fichier dont la valeur effective dépend du lecteur —
 * et le jour où les deux divergent, aucune ne fait autorité (ADR-041).
 */
export function poserDansEnv(contenu: string, cle: string, valeur: string): string {
  const lignes = contenu.split('\n');
  let trouve = false;
  const sortie = lignes.map((ligne) => {
    const nu = ligne.trim();
    if (nu.startsWith('#')) return ligne;
    const separateur = nu.indexOf('=');
    if (separateur < 0) return ligne;
    if (nu.slice(0, separateur).trim() !== cle) return ligne;
    trouve = true;
    return `${cle}=${valeur}`;
  });
  if (!trouve) sortie.push(`${cle}=${valeur}`);
  return sortie.join('\n');
}

/** L'URL de consentement. Pure, pour être éprouvable sans réseau. */
export function urlDeConsentement(options: {
  identifiant: string;
  redirection: string;
  defi: string;
  etat: string;
}): string {
  const p = new URLSearchParams({
    client_id: options.identifiant,
    redirect_uri: options.redirection,
    response_type: 'code',
    scope: PORTEE,
    /* `offline` + `consent` : sans les deux, Google ne rend PAS de jeton de
       rafraîchissement au deuxième passage — il considère que l'application
       en a déjà un. On se retrouve alors avec un accès qui expire en une
       heure, et un script qui a l'air d'avoir marché. */
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: options.defi,
    code_challenge_method: 'S256',
    state: options.etat,
  });
  return `${AUTORISATION}?${p.toString()}`;
}

interface ReponseJeton {
  readonly refresh_token?: string;
  readonly error?: string;
  readonly error_description?: string;
}

async function echanger(options: {
  identifiant: string;
  cleClient: string;
  code: string;
  verificateur: string;
  redirection: string;
}): Promise<string> {
  const reponse = await fetch(JETON, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: options.identifiant,
      client_secret: options.cleClient,
      code: options.code,
      code_verifier: options.verificateur,
      grant_type: 'authorization_code',
      redirect_uri: options.redirection,
    }).toString(),
  });

  const brut: unknown = await reponse.json();
  const corps = brut as ReponseJeton;

  if (!reponse.ok || typeof corps.refresh_token !== 'string') {
    /* ⚠ ON NE RECOPIE PAS LE CORPS DE LA RÉPONSE. Il peut contenir le jeton
       d'accès en cas de réponse partielle, et ce message finira dans un
       terminal. On rend le code d'erreur de Google, qui suffit à diagnostiquer
       et ne porte aucun secret. */
    throw new Error(
      `Google a refusé l'échange (${String(reponse.status)}) : `
        + `${corps.error ?? 'réponse inattendue'}`
        + `${corps.error_description === undefined ? '' : ` — ${corps.error_description}`}`
        + (typeof corps.refresh_token === 'string'
          ? ''
          : '\n  Aucun jeton de rafraîchissement rendu : vérifie que le type de'
            + " client OAuth est « Application de bureau », et relance."),
    );
  }
  return corps.refresh_token;
}

/**
 * Ouvre la boucle locale et rend le port AVANT d'attendre le code.
 *
 * ⚠ L'ORDRE EST UN DÉFAUT QUE J'AI ÉCRIT PUIS CORRIGÉ. La première rédaction
 * attendait le code, PUIS construisait l'URL de consentement — qui contient le
 * port. L'utilisateur n'avait donc jamais de lien à ouvrir, et le script
 * attendait indéfiniment une réponse qu'il rendait impossible.
 *
 * Le port est une entrée de l'URL : il faut l'obtenir d'abord, et c'est
 * pourquoi cette fonction rend une paire plutôt qu'une promesse.
 */
export function ouvrirLaBoucleLocale(etatAttendu: string): Promise<{
  redirection: string;
  code: Promise<string>;
}> {
  return new Promise((pret, echec) => {
    let resoudreCode: (c: string) => void = () => undefined;
    let rejeterCode: (e: Error) => void = () => undefined;
    const code = new Promise<string>((r, j) => {
      resoudreCode = r;
      rejeterCode = j;
    });

    const serveur = createServer((requete, reponse) => {
      const url = new URL(requete.url ?? '/', 'http://127.0.0.1');
      const recu = url.searchParams.get('code');
      const etat = url.searchParams.get('state');
      const erreur = url.searchParams.get('error');

      /* ⚠ ON DÉCIDE AVANT D'ANNONCER, ET L'ANNONCE NE PROMET PAS LE JETON.
         La première rédaction écrivait la page d'abord, et disait « C'est
         fait » dès qu'un paramètre `code` était présent — donc AUSSI quand
         l'état était faux et que l'échange allait être abandonné. L'onglet
         affirmait un succès pendant que le terminal affichait un refus : deux
         registres du même fait, qui divergent (ADR-041).

         Même avec un code valide, rien n'est « fait » à cet instant :
         l'échange contre le jeton n'a pas encore eu lieu. La page dit donc ce
         qu'elle sait — le code est arrivé — et renvoie au terminal, seul
         endroit qui verra la réponse de Google. */
      type Verdict =
        | { titre: string; texte: string; echec: Error; code?: undefined }
        | { titre: string; texte: string; echec: null; code: string };

      const verdict: Verdict =
        erreur !== null
          ? {
              titre: 'Refusé',
              texte: 'Google a refusé l’autorisation. Rien n’a été enregistré.',
              echec: new Error(`Google a refusé l'autorisation : ${erreur}`),
            }
          : /* ⚠ L'ÉTAT EST VÉRIFIÉ. Sans lui, n'importe quelle page ouverte
               dans ce navigateur pourrait appeler cette boucle locale avec son
               propre code — et on échangerait le code de quelqu'un d'autre
               contre un jeton rangé dans le `.env` de Julien. */
            etat !== etatAttendu
            ? {
                titre: 'Abandonné',
                texte: 'Cette réponse ne correspond pas à la demande en cours. Rien n’a été enregistré.',
                echec: new Error('État OAuth inattendu : échange abandonné.'),
              }
            : recu === null
              ? {
                  titre: 'Incomplet',
                  texte: 'Aucun code d’autorisation reçu. Rien n’a été enregistré.',
                  echec: new Error('Aucun code reçu.'),
                }
              : {
                  titre: 'Code reçu',
                  texte:
                    'L’échange contre le jeton se fait maintenant dans le terminal. '
                    + 'C’est lui qui dira s’il a abouti.',
                  echec: null,
                  code: recu,
                };

      reponse.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      reponse.end(
        '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">'
          + `<h1>${verdict.titre}</h1><p>${verdict.texte}</p>`
          + '</body>',
      );

      serveur.close();

      if (verdict.echec !== null) {
        rejeterCode(verdict.echec);
        return;
      }
      resoudreCode(verdict.code);
    });

    /* PORT ÉPHÉMÈRE, sur la boucle locale UNIQUEMENT. `127.0.0.1` et non
       `0.0.0.0` : cette porte ne doit pas être ouverte au réseau, même pour
       les quelques secondes de l'échange. */
    serveur.listen(0, '127.0.0.1');
    serveur.on('error', echec);
    serveur.on('listening', () => {
      const adresse = serveur.address();
      const port = typeof adresse === 'object' && adresse !== null ? adresse.port : 0;
      if (port === 0) {
        echec(new Error('Port local introuvable.'));
        return;
      }
      pret({ redirection: `http://127.0.0.1:${String(port)}`, code });
    });
  });
}

async function main(): Promise<void> {
  const identifiant = depuisEnv('GOOGLE_OAUTH_CLIENT_ID');
  const cleClient = depuisEnv('GOOGLE_OAUTH_CLIENT_SECRET');

  if (identifiant === null || cleClient === null) {
    stdout.write(
      '\n  Il manque GOOGLE_OAUTH_CLIENT_ID et/ou GOOGLE_OAUTH_CLIENT_SECRET dans .env\n'
        + '\n  Où les obtenir : https://console.cloud.google.com/apis/credentials\n'
        + '    → « Créer des identifiants » → « ID client OAuth »\n'
        + '    → Type : « Application de bureau »\n'
        + '\n  Puis active l\'API Agenda pour ce projet :\n'
        + '    https://console.cloud.google.com/apis/library/calendar-json.googleapis.com\n\n',
    );
    process.exit(1);
  }

  const { verificateur, defi } = pkce();
  const etat = randomBytes(16).toString('base64url');

  /* L'écoute d'abord : le port fait partie de l'URL de consentement. */
  const boucle = await ouvrirLaBoucleLocale(etat);
  const lien = urlDeConsentement({
    identifiant,
    redirection: boucle.redirection,
    defi,
    etat,
  });

  stdout.write(
    '\n  JARVIS — connexion de l\'agenda Google\n'
      + '\n  Portée demandée : l\'agenda, et rien d\'autre.\n'
      + '  Le jeton sera écrit dans .env et ne sera jamais affiché.\n'
      + '\n  Ouvre ce lien dans ton navigateur :\n\n'
      + `    ${lien}\n\n`
      + '  (j\'attends le retour de Google sur la boucle locale…)\n',
  );

  const code = await boucle.code;
  const redirection = boucle.redirection;

  const jeton = await echanger({
    identifiant,
    cleClient,
    code,
    verificateur,
    redirection,
  });

  const contenu = existsSync(CHEMIN_ENV) ? readFileSync(CHEMIN_ENV, 'utf8') : '';
  writeFileSync(CHEMIN_ENV, poserDansEnv(contenu, CLE_JETON, jeton), 'utf8');
  /* Le `.env` porte désormais trois secrets. On resserre les droits plutôt que
     de supposer qu'ils l'étaient. */
  chmodSync(CHEMIN_ENV, 0o600);

  stdout.write(
    `\n  ✓ Jeton enregistré dans ${CHEMIN_ENV} (droits 600).\n`
      + '    Il n\'a pas été affiché, et il ne doit jamais l\'être.\n'
      + '\n  Relance Jarvis : « qu\'ai-je de prévu demain ? »\n\n',
  );
}

/* ON NE LANCE L'ÉCHANGE QUE SI C'EST LA COMMANDE QU'ON A TAPÉE.
   Sans cette garde, importer ce fichier — ce que font ses propres tests —
   ouvrait un port, imprimait un lien, ou sortait en `process.exit(1)` parce
   qu'il manquait des identifiants. Un module qui agit à l'import est un module
   qu'on ne peut pas éprouver. */
const lancePourDeVrai =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (lancePourDeVrai) {
  await main();
}
