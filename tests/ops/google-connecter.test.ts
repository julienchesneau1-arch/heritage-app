/**
 * L'ASSISTANT DE CONNEXION GOOGLE — ADR-108.
 *
 * ⚠ CE QUE CE FICHIER PEUT ÉPROUVER, ET CE QU'IL NE PEUT PAS
 * ---------------------------------------------------------------------------
 * Le script n'a **jamais tourné contre Google** : aucun compte n'est connecté
 * dans l'environnement où il a été écrit. Ce qui suit éprouve donc la partie
 * PURE — l'URL de consentement, la réécriture de `.env` — et les propriétés de
 * sûreté qui se lisent dans la source.
 *
 * Ce qui reste non vérifié est écrit en toutes lettres dans l'en-tête du
 * script, comme ADR-078 l'a fait pour l'adaptateur lui-même.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sansCommentaires } from '../helpers/source.js';
import {
  ouvrirLaBoucleLocale,
  poserDansEnv,
  urlDeConsentement,
} from '../../ops/google/connecter.js';

const SOURCE = readFileSync('ops/google/connecter.ts', 'utf8');

/* ====================================================================== *
 * 1. LA PORTÉE — l'agenda, et rien d'autre
 * ====================================================================== */

describe('⚠ la portée demandée est minimale', () => {
  it('l’URL ne demande QUE l’agenda', () => {
    const url = new URL(
      urlDeConsentement({
        identifiant: 'client-de-test',
        redirection: 'http://127.0.0.1:12345',
        defi: 'defi',
        etat: 'etat',
      }),
    );
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/calendar',
    );
  });

  it('⚠ ni Gmail, ni Drive, ni Contacts — même en commentaire de la source', () => {
    /* Un jeton porte ce qu'on lui a accordé. Demander large « au cas où » est
       la façon la plus simple de perdre plus qu'on ne voulait le jour où il
       fuit — et une portée s'ajoute en une ligne, sans que rien ne le
       signale. */
    const nu = sansCommentaires(SOURCE);
    for (const trop of ['gmail', 'drive', 'contacts', 'userinfo', 'auth/cloud']) {
      expect(nu.toLowerCase(), `portée « ${trop} » demandée`).not.toContain(trop);
    }
  });

  it('⚠ `access_type=offline` ET `prompt=consent` — les deux, ou rien', () => {
    /* Sans les deux, Google ne rend PAS de jeton de rafraîchissement au
       deuxième passage : il considère que l'application en a déjà un. On se
       retrouve avec un accès qui expire en une heure, et un script qui a l'air
       d'avoir marché. */
    const url = new URL(
      urlDeConsentement({
        identifiant: 'c',
        redirection: 'http://127.0.0.1:1',
        defi: 'd',
        etat: 'e',
      }),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

/* ====================================================================== *
 * 2. PKCE ET ÉTAT — les deux gardes de la boucle locale
 * ====================================================================== */

describe('⚠ la boucle locale est gardée', () => {
  it('PKCE en S256, jamais `plain`', () => {
    /* Sans PKCE, un code intercepté sur la boucle locale suffit à obtenir le
       jeton. `plain` transmet le vérificateur en clair et n'apporte rien. */
    const url = new URL(
      urlDeConsentement({
        identifiant: 'c',
        redirection: 'http://127.0.0.1:1',
        defi: 'd',
        etat: 'e',
      }),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(sansCommentaires(SOURCE)).not.toContain("'plain'");
  });

  it('⚠ l’ÉTAT est vérifié au retour', () => {
    /* Sans lui, n'importe quelle page ouverte dans ce navigateur pourrait
       appeler la boucle locale avec son propre code — et on échangerait le
       code de quelqu'un d'autre contre un jeton rangé dans le `.env` de
       Julien. */
    expect(sansCommentaires(SOURCE)).toContain('etat !== etatAttendu');
  });

  it('⚠ l’écoute est sur 127.0.0.1, pas sur toutes les interfaces', () => {
    /* Cette porte ne doit pas être ouverte au réseau, même pour les quelques
       secondes de l'échange. */
    const nu = sansCommentaires(SOURCE);
    expect(nu).toContain("serveur.listen(0, '127.0.0.1')");
    expect(nu).not.toContain("'0.0.0.0'");
  });
});

/* ====================================================================== *
 * 2 bis. LA BOUCLE LOCALE, POUR DE VRAI
 * ----------------------------------------------------------------------
 * Les épreuves ci-dessus lisent la source. Celles-ci OUVRENT le serveur et
 * lui parlent, parce qu'une garde qu'on lit n'est pas une garde qu'on a vue
 * refuser. C'est la seule partie du script qui peut tourner ici : elle ne
 * contacte pas Google.
 * ====================================================================== */

/** Appelle la boucle locale comme le navigateur le ferait, et rend la page. */
async function frapper(redirection: string, parametres: Record<string, string>): Promise<string> {
  const url = new URL(redirection);
  for (const [cle, valeur] of Object.entries(parametres)) url.searchParams.set(cle, valeur);
  const reponse = await fetch(url);
  return await reponse.text();
}

describe('⚠ la boucle locale refuse, et le dit dans l’onglet', () => {
  it('un état qui ne correspond pas : la promesse est rejetée', async () => {
    const boucle = await ouvrirLaBoucleLocale('le-bon-etat');
    const attendu = expect(boucle.code).rejects.toThrow(/État OAuth inattendu/u);
    const page = await frapper(boucle.redirection, {
      code: 'code-de-quelqu-un-d-autre',
      state: 'un-autre-etat',
    });
    await attendu;
    expect(page).toContain('Abandonné');
  });

  it('⚠ et l’onglet n’annonce PAS un succès quand l’échange est abandonné', async () => {
    /* LE DÉFAUT QUE CE TEST FIGE. La première rédaction écrivait la page avant
       de vérifier quoi que ce soit, et affichait « C'est fait » dès qu'un
       paramètre `code` était présent — donc aussi quand l'état était faux.
       L'onglet affirmait un succès pendant que le terminal affichait un refus.
       `CLAUDE.md` : jamais de succès non vérifié. */
    const boucle = await ouvrirLaBoucleLocale('le-bon-etat');
    const attendu = expect(boucle.code).rejects.toThrow();
    const page = await frapper(boucle.redirection, { code: 'x', state: 'faux' });
    await attendu;
    expect(page).not.toContain('C’est fait');
    expect(page).toContain('Rien n’a été enregistré');
  });

  it('un refus de Google est relayé tel quel', async () => {
    const boucle = await ouvrirLaBoucleLocale('e');
    const attendu = expect(boucle.code).rejects.toThrow(/access_denied/u);
    const page = await frapper(boucle.redirection, { error: 'access_denied', state: 'e' });
    await attendu;
    expect(page).toContain('Refusé');
  });

  it('⚠ un code valide n’est annoncé que comme REÇU, pas comme enregistré', async () => {
    /* À cet instant, l'échange contre le jeton n'a pas encore eu lieu. Dire
       « c'est fait » ici, c'est annoncer un résultat qu'on ne connaît pas. */
    const boucle = await ouvrirLaBoucleLocale('etat-partagé');
    const page = await frapper(boucle.redirection, {
      code: 'le-code',
      state: 'etat-partagé',
    });
    await expect(boucle.code).resolves.toBe('le-code');
    expect(page).toContain('Code reçu');
    expect(page).toContain('terminal');
  });

  it('l’écoute est bien sur la boucle locale, et elle se referme', async () => {
    const boucle = await ouvrirLaBoucleLocale('e');
    expect(boucle.redirection).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    await frapper(boucle.redirection, { code: 'c', state: 'e' });
    await boucle.code;
    /* Le serveur se ferme après le premier retour : un port qui reste ouvert
       après l'échange est une porte que plus personne ne surveille. */
    await expect(frapper(boucle.redirection, { code: 'c', state: 'e' })).rejects.toThrow();
  });
});

/* ====================================================================== *
 * 3. LE JETON NE S'AFFICHE JAMAIS
 * ====================================================================== */

describe('⚠ le jeton ne traverse ni le terminal ni un log', () => {
  it('aucune écriture ne porte le jeton', () => {
    /* Un jeton affiché reste dans l'historique du terminal, dans le tampon de
       défilement, et dans la capture d'écran qu'on enverra pour demander de
       l'aide. `docs/03 §9` : un secret ne traverse ni un log, ni un prompt, ni
       un contexte de modèle. */
    const nu = sansCommentaires(SOURCE);
    const ecritures = [...nu.matchAll(/stdout\.write\([\s\S]*?\);/gu)].map((m) => m[0]);
    expect(ecritures.length, 'le script doit bien écrire quelque chose').toBeGreaterThan(0);
    for (const e of ecritures) {
      expect(e, 'une écriture porte le jeton').not.toMatch(/\bjeton\b\s*[,)}]|\$\{jeton\}/u);
    }
  });

  it('⚠ et le corps de la réponse Google n’est pas recopié dans l’erreur', () => {
    /* Il peut contenir le jeton d'accès en cas de réponse partielle, et ce
       message finira dans un terminal. */
    const nu = sansCommentaires(SOURCE);
    expect(nu).not.toContain('JSON.stringify(corps)');
    expect(nu).not.toContain('${brut}');
  });

  it('le fichier `.env` est resserré à 600 après écriture', () => {
    expect(sansCommentaires(SOURCE)).toContain('chmodSync(CHEMIN_ENV, 0o600)');
  });
});

/* ====================================================================== *
 * 4. LA RÉÉCRITURE DE `.env`
 * ====================================================================== */

describe('poserDansEnv', () => {
  it('remplace la ligne existante plutôt que d’en ajouter une seconde', () => {
    /* Deux lignes portant la même clé donnent un fichier dont la valeur
       effective dépend du lecteur — et le jour où elles divergent, aucune ne
       fait autorité (ADR-041). */
    const avant = 'A=1\nGOOGLE_OAUTH_REFRESH_TOKEN=ancien\nB=2';
    const apres = poserDansEnv(avant, 'GOOGLE_OAUTH_REFRESH_TOKEN', 'nouveau');
    expect(apres.split('\n').filter((l) => l.startsWith('GOOGLE_OAUTH_REFRESH_TOKEN='))).toEqual(
      ['GOOGLE_OAUTH_REFRESH_TOKEN=nouveau'],
    );
    expect(apres).toContain('A=1');
    expect(apres).toContain('B=2');
  });

  it('ajoute la ligne quand elle n’existe pas', () => {
    const apres = poserDansEnv('A=1', 'GOOGLE_OAUTH_REFRESH_TOKEN', 'x');
    expect(apres).toContain('GOOGLE_OAUTH_REFRESH_TOKEN=x');
  });

  it('⚠ ne touche pas une ligne COMMENTÉE qui porte la même clé', () => {
    /* `.env.example` commente les clés pour les documenter. Écraser un
       commentaire ferait disparaître l'explication, et laisserait la vraie
       ligne intacte ailleurs : le pire des deux. */
    const avant = '# GOOGLE_OAUTH_REFRESH_TOKEN=exemple\nGOOGLE_OAUTH_REFRESH_TOKEN=vrai';
    const apres = poserDansEnv(avant, 'GOOGLE_OAUTH_REFRESH_TOKEN', 'neuf');
    expect(apres).toContain('# GOOGLE_OAUTH_REFRESH_TOKEN=exemple');
    expect(apres).toContain('GOOGLE_OAUTH_REFRESH_TOKEN=neuf');
  });
});

/* ====================================================================== *
 * 5. CE SCRIPT N'EST PAS JARVIS
 * ====================================================================== */

describe('⚠ il n’emprunte rien au noyau', () => {
  it('aucun import de `src/core` — ce n’est pas une action de Jarvis', () => {
    /* `CLAUDE.md` interdit un appel réseau sortant hors Data Firewall. La
       règle gouverne ce que JARVIS envoie. Ici l'opérateur échange ses propres
       identifiants contre son propre jeton, sur sa machine, parce qu'il vient
       de taper la commande.

       La distinction ne tient que tant que ce script ne lit rien du produit.
       Le jour où il importerait la base, la mémoire ou la passerelle, il
       devrait passer par le Firewall comme tout le reste. */
    const nu = sansCommentaires(SOURCE);
    for (const interdit of ['src/core', 'createDb', 'ToolGateway', 'assistant']) {
      expect(nu, `le script ne doit pas connaître « ${interdit} »`).not.toContain(interdit);
    }
  });

  it('⚠ il n’ÉMET qu’un seul appel réseau, vers le serveur de jetons', () => {
    /* La première version de ce test comptait les URL de la source et exigeait
       qu'il y en ait trois. Il est devenu rouge le jour où le script s'est mis
       à IMPRIMER deux liens de documentation pour l'opérateur — deux liens
       qu'il n'ouvre pas, qu'il ne contacte pas, et qui ne sortent pas de son
       terminal.

       Compter les URL mesurait la mauvaise chose : une source peut nommer un
       lien sans jamais l'appeler, et peut appeler une adresse qu'elle
       construit. Ce qui compte ici est le nombre d'APPELS SORTANTS, et leur
       destination. */
    const nu = sansCommentaires(SOURCE);
    const appels = [...nu.matchAll(/\bfetch\(\s*([A-Za-z_$][\w$]*|['"`][^'"`]*['"`])/gu)].map(
      (m) => m[1],
    );
    expect(appels).toEqual(['JETON']);
    expect(nu).toContain("const JETON = 'https://oauth2.googleapis.com/token';");
  });

  it('et aucun hôte étranger n’apparaît dans la source', () => {
    /* Les deux liens `console.cloud.google.com` sont AFFICHÉS à l'opérateur
       quand il manque des identifiants : ils lui disent où aller les chercher.
       Le script ne les ouvre pas. Ils sont listés ici pour qu'un sixième lien
       — vers un service tiers, un webhook, un « télémètre » — fasse rougir ce
       test au lieu de passer inaperçu. */
    const nu = sansCommentaires(SOURCE);
    const hotes = new Set(
      [...nu.matchAll(/https:\/\/([^/'"`\s)]+)/gu)].map((m) => m[1]),
    );
    expect(hotes).toEqual(
      new Set([
        'www.googleapis.com', // la portée demandée
        'accounts.google.com', // la page de consentement, ouverte par l'humain
        'oauth2.googleapis.com', // le seul appel sortant
        'console.cloud.google.com', // deux liens imprimés, jamais ouverts
      ]),
    );
  });

  it('⚠ et `.env.example` annonce la commande — sinon personne ne la trouve', () => {
    /* ADR-094 : une capacité que rien n'annonce est, du siège de
       l'utilisateur, une capacité absente. Les trois variables Google
       manquaient à ce fichier depuis ADR-078. */
    const exemple = readFileSync('.env.example', 'utf8');
    expect(exemple).toContain('GOOGLE_OAUTH_CLIENT_ID=');
    expect(exemple).toContain('GOOGLE_OAUTH_CLIENT_SECRET=');
    expect(exemple).toContain('GOOGLE_OAUTH_REFRESH_TOKEN=');
    expect(exemple).toContain('pnpm google:connecter');
  });
});
