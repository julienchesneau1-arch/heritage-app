/**
 * L'ÉTANCHÉITÉ ENTRE FAMILLES — le seul défaut qui serait irréparable.
 *
 * Tout le reste de ce dossier traite de choses qu'on peut corriger : une
 * page lente, un contraste faible, une sauvegarde qui ment. Une famille qui
 * lit la mémoire d'une autre, non. C'est la seule promesse du produit dont
 * la rupture ne se répare pas — on ne peut pas faire oublier ce qui a été lu.
 *
 * Compter les appels à `authorizeFamily` dans les fichiers ne prouve rien :
 * un garde peut être présent et poser la mauvaise question. Ce contrôle
 * fabrique donc DEUX familles réelles, chacune avec ses récits, ses fils,
 * ses archives et ses traditions, puis essaie d'atteindre la seconde avec
 * les identifiants de la première.
 *
 * Deux attaques, et la seconde est celle qu'on oublie :
 *
 *  1. L'IDENTIFIANT DE FAMILLE DANS L'ADRESSE. `/api/family/<B>/export`
 *     avec le cookie de A. C'est le cas évident, et c'est celui que tout le
 *     monde protège.
 *  2. L'OBJET D'UNE AUTRE FAMILLE DANS SA PROPRE ADRESSE.
 *     `/api/family/<A>/stories/<récit de B>` avec le cookie de A. Le garde
 *     de famille passe — l'adresse est bien celle de A — et il faut que la
 *     REQUÊTE, elle, vérifie que l'objet appartient à A. C'est la faute la
 *     plus facile à commettre et la plus difficile à voir.
 *
 * Les deux familles sont effacées à la fin, quoi qu'il arrive.
 *
 * USAGE :  BASE=http://localhost:3000 FAMILY_TOKEN_SECRET=... \
 *            node outils/etancheite.mjs
 */

import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');
const prisma = new PrismaClient();

const resultats = [];
/**
 * Toutes les requêtes de ce fichier partent de la MÊME IP, et la §8.2
 * limite à 100 par minute. Sans compter ce qu'on a déjà dépensé, la rafale
 * de la fin donne un chiffre incompréhensible — et elle a fini par
 * empoisonner le dernier contrôle du fichier, qui a reçu un 429.
 */
let requetesEmises = 0;

/**
 * Une adresse propre à cette exécution.
 *
 * Sans elle, toutes les requêtes du fichier tombent dans le même seau que
 * celles de l'exécution précédente : au deuxième lancement dans la même
 * minute, la moitié des contrôles recevaient un 429 et se déclaraient en
 * échec. Un outil qui ne peut pas être relancé deux fois de suite finit
 * par ne plus être lancé du tout.
 *
 * `X-Real-IP` n'est cru que si `TRUST_PROXY=1` — c'est tout l'objet de la
 * correction de `clientIp`. Sans ce réglage, le seau reste commun et la
 * section 8 le dit au lieu de rendre un chiffre faux.
 */
const MON_ADRESSE = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
const ENTETE_ADRESSE = { 'X-Real-IP': MON_ADRESSE };
function verifier(nom, condition, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

async function fabriquer(nom, secret) {
  const famille = await prisma.family.create({ data: { name: nom } });
  const membre = await prisma.member.create({
    data: { familyId: famille.id, name: `${nom} — quelqu’un`, generation: 1 },
  });
  const entite = await prisma.entity.create({
    data: { familyId: famille.id, type: 'PERSON', name: `${nom}-entité`, normalizedName: `${nom}-entite` },
  });
  const recit = await prisma.story.create({
    data: {
      familyId: famille.id,
      authorId: membre.id,
      title: `SECRET DE ${nom}`,
      content: secret,
      structureType: 'evenement-marquant',
      searchText: secret.toLowerCase(),
      tone: 'factuel',
      length: 'standard',
      linkedEntities: { connect: [{ id: entite.id }] },
    },
  });
  const fil = await prisma.thread.create({
    data: { familyId: famille.id, storyId: recit.id, openedById: membre.id, messageCount: 1, lastMessageAt: new Date() },
  });
  await prisma.message.create({
    data: { threadId: fil.id, familyId: famille.id, authorId: membre.id, body: secret, isQuestion: false },
  });
  const tradition = await prisma.tradition.create({
    data: { familyId: famille.id, name: `Tradition de ${nom}`, description: secret, periodicity: 'annual', monthDay: '12-24' },
  });
  const archive = await prisma.archive.create({
    data: {
      familyId: famille.id,
      uploaderId: membre.id,
      storyId: recit.id,
      type: 'DOCUMENT',
      title: `Document de ${nom}`,
      storageKey: `${famille.id}/faux.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: 10,
    },
  });
  return { famille, membre, entite, recit, fil, tradition, archive, secret };
}

const SECRET_B = 'CECI-EST-LE-SECRET-DE-B-QUE-A-NE-DOIT-JAMAIS-LIRE';
const A = await fabriquer('AAA', 'Le secret de la famille A.');
const B = await fabriquer('BBB', SECRET_B);

const cookieDe = (f, m) =>
  `family_token=${f.id}.1.${sign(`${f.id}:1`)}; member_token=${m.id}.verified.${sign(`${m.id}.verified`)}`;
const COOKIE_A = cookieDe(A.famille, A.membre);

try {
  /**
   * Une réponse est une FUITE si elle rend 200 **et** contient le secret de
   * B. Un 200 vide ou un 404 ne fuient rien ; un 403 non plus. On regarde
   * donc le contenu, pas seulement le code — c'est la différence entre
   * « la porte est fermée » et « la porte a l'air fermée ».
   */
  const essayer = async (nom, url) => {
    let corps = '';
    let statut = 0;
    try {
      requetesEmises += 1;
      const reponse = await fetch(BASE + url, {
        headers: { Cookie: COOKIE_A, ...ENTETE_ADRESSE },
        redirect: 'manual',
      });
      statut = reponse.status;
      corps = await reponse.text();
    } catch (error) {
      corps = `ERREUR ${error.cause?.message ?? error.message}`;
    }
    /*
     * ── UNE PORTE QU'ON N'A PAS POUSSÉE N'EST PAS UNE PORTE FERMÉE ──
     *
     * Ce contrôle ne cherchait que le secret dans le corps. Quand `fetch`
     * échouait — `BASE` non renseigné, application arrêtée — le corps
     * valait « ERREUR … », ne contenait donc pas le secret, et les ONZE
     * lectures croisées se déclaraient étanches sans qu'une seule requête
     * soit partie. C'est la faute que ce dépôt poursuit, dans l'outil qui
     * garde la promesse la plus grave du produit.
     */
    const fuite = corps.includes(SECRET_B) || corps.includes('SECRET DE BBB');
    const joignable = statut > 0;
    verifier(
      nom,
      joignable && !fuite,
      joignable ? `HTTP ${statut}${fuite ? ' — FUITE' : ''}` : `NON MESURÉ — ${corps}`,
    );
  };

  console.log('\n── 1. L’identifiant de B dans l’adresse, avec le cookie de A ──');
  const F = B.famille.id;
  for (const [nom, url] of [
    ['export', `/api/family/${F}/export`],
    ['récits', `/api/family/${F}/stories`],
    ['un récit', `/api/family/${F}/stories/${B.recit.id}`],
    ['accueil', `/api/family/${F}/home`],
    ['graphe', `/api/family/${F}/graph`],
    ['fils', `/api/family/${F}/fils`],
    ['un fil', `/api/family/${F}/fils/${B.fil.id}`],
    ['traditions', `/api/family/${F}/traditions`],
    ['archives', `/api/family/${F}/archives`],
    ['fichier d’archive', `/api/family/${F}/archives/${B.archive.id}/file`],
    ['mesures', `/api/family/${F}/metrics`],
  ]) {
    await essayer(`API ${nom}`, url);
  }

  console.log('\n── 2. L’objet de B dans l’adresse de A (le garde de famille passe) ──');
  const MOI = A.famille.id;
  for (const [nom, url] of [
    ['un récit de B', `/api/family/${MOI}/stories/${B.recit.id}`],
    ['un fil de B', `/api/family/${MOI}/fils/${B.fil.id}`],
    ['une archive de B', `/api/family/${MOI}/archives/${B.archive.id}/file`],
    ['une tradition de B', `/api/family/${MOI}/traditions/${B.tradition.id}`],
  ]) {
    await essayer(`API ${nom}`, url);
  }

  console.log('\n── 3. ÉCRIRE chez B, avec le cookie de A ──');
  //
  // Ma première version ne testait que la LECTURE. Une écriture croisée
  // serait pourtant pire : lire la mémoire d'une autre famille est
  // irréparable, la modifier l'est deux fois. Et le contrôle avait un
  // second trou — il interrogeait la route des traditions en GET, qui
  // n'expose que PATCH : le « 405 » que je comptais comme une réussite ne
  // testait rien du tout.
  const muter = async (nom, url, methode, corpsEnvoye) => {
    let statut = 0;
    let detail = '';
    try {
      requetesEmises += 1;
      const reponse = await fetch(BASE + url, {
        method: methode,
        headers: { Cookie: COOKIE_A, 'Content-Type': 'application/json', ...ENTETE_ADRESSE },
        body: corpsEnvoye ? JSON.stringify(corpsEnvoye) : undefined,
        redirect: 'manual',
      });
      statut = reponse.status;
    } catch (error) {
      // « HTTP -1 » ne dit rien : sept contrôles rouges et aucune piste.
      // La cause du rejet de `fetch` est la seule information utile ici.
      statut = -1;
      detail = ` (${error?.cause?.message ?? error?.message ?? error})`;
    }
    verifier(`${nom} est refusé`, statut === 403 || statut === 404, `HTTP ${statut}${detail}`);
  };

  await muter('PATCH sur le récit de B', `/api/family/${F}/stories/${B.recit.id}`, 'PATCH', {
    title: 'PIRATÉ',
  });
  await muter(
    'PATCH sur le récit de B via l’adresse de A',
    `/api/family/${A.famille.id}/stories/${B.recit.id}`,
    'PATCH',
    { title: 'PIRATÉ' },
  );
  await muter('DELETE sur le récit de B', `/api/family/${F}/stories/${B.recit.id}`, 'DELETE');
  await muter(
    'DELETE sur le récit de B via l’adresse de A',
    `/api/family/${A.famille.id}/stories/${B.recit.id}`,
    'DELETE',
  );
  await muter(
    'PATCH sur la tradition de B',
    `/api/family/${F}/traditions/${B.tradition.id}`,
    'PATCH',
    { action: 'sleep' },
  );
  await muter(
    'PATCH sur la tradition de B via l’adresse de A',
    `/api/family/${A.famille.id}/traditions/${B.tradition.id}`,
    'PATCH',
    { action: 'sleep' },
  );
  await muter('POST d’un récit chez B', `/api/family/${F}/stories`, 'POST', {
    authorId: B.membre.id,
    title: 'INTRUS',
    content: 'Un récit déposé par une autre famille.',
  });

  // Et l'on VÉRIFIE en base que rien n'a bougé : un refus annoncé qui aurait
  // tout de même écrit serait le pire des deux mondes.
  const apres = await prisma.story.findUnique({ where: { id: B.recit.id } });
  verifier(
    'le récit de B est intact en base après toutes ces tentatives',
    apres !== null && apres.title === `SECRET DE BBB` && apres.suspendedAt === null,
    apres ? apres.title : 'DÉTRUIT',
  );
  const combien = await prisma.story.count({ where: { familyId: F } });
  verifier('aucun récit n’a été ajouté chez B', combien === 1, `${combien} récit(s)`);
  const traditionApres = await prisma.tradition.findUnique({ where: { id: B.tradition.id } });
  verifier(
    'la tradition de B n’a pas été endormie par A',
    traditionApres !== null && traditionApres.isAsleep === false,
    traditionApres ? `endormie=${traditionApres.isAsleep}` : 'DÉTRUITE',
  );

  console.log('\n── 4. Les PAGES, avec le cookie de A ──');
  for (const [nom, url] of [
    ['le récit de B', `/recits/${B.recit.id}`],
    ['le fil de B', `/fils/${B.fil.id}`],
    ['le graphe sur l’entité de B', `/graphe?entite=${B.entite.id}`],
    ['la modification du récit de B', `/recits/${B.recit.id}/modifier`],
    ['la recherche sur le secret de B', `/recits?q=${encodeURIComponent('secret')}`],
  ]) {
    await essayer(`page ${nom}`, url);
  }

  console.log('\n── 5. Le calendrier : un jeton ne vaut que pour son membre ──');
  const jetonDeA = sign(`cal:${A.membre.id}:1`);
  await essayer(
    'le calendrier de B avec le jeton de A',
    `/api/calendrier/${B.membre.id}/${jetonDeA}/heritage.ics`,
  );
  await essayer(
    'le calendrier de B avec un jeton inventé',
    `/api/calendrier/${B.membre.id}/0000000000000000/heritage.ics`,
  );

  console.log('\n── 6. Sans aucun cookie ──');
  for (const [nom, url] of [
    ['export', `/api/family/${F}/export`],
    ['récits', `/api/family/${F}/stories`],
    ['fichier d’archive', `/api/family/${F}/archives/${B.archive.id}/file`],
  ]) {
    let corps = '';
    let statut = 0;
    try {
      requetesEmises += 1;
      const reponse = await fetch(BASE + url, { headers: ENTETE_ADRESSE, redirect: 'manual' });
      statut = reponse.status;
      corps = await reponse.text();
    } catch (error) {
      corps = `ERREUR ${error.cause?.message ?? error.message}`;
    }
    // Même règle qu'en section 1 : injoignable ≠ étanche.
    verifier(
      `anonyme : ${nom}`,
      statut > 0 && !corps.includes(SECRET_B),
      statut > 0 ? `HTTP ${statut}` : `NON MESURÉ — ${corps}`,
    );
  }

  console.log('\n── 8. Le contrôle vérifie-t-il quelque chose ? ──');
  // Sans cette ligne, un `fetch` cassé rendrait tout vert : chaque réponse
  // serait vide, donc sans secret, donc « étanche ».
  // Ce `fetch`-ci n'était pas gardé : application injoignable, l'outil
  // mourait sur une pile Node au lieu de rendre son bilan.
  let statutTemoin = 0;
  let contenu = '';
  try {
    requetesEmises += 1;
    const chezSoi = await fetch(`${BASE}/api/family/${B.famille.id}/export`, {
      headers: { Cookie: cookieDe(B.famille, B.membre), ...ENTETE_ADRESSE },
    });
    statutTemoin = chezSoi.status;
    contenu = await chezSoi.text();
  } catch (error) {
    contenu = `ERREUR ${error.cause?.message ?? error.message}`;
  }
  verifier(
    'B lit bien SA propre mémoire — le secret est atteignable quand on y a droit',
    statutTemoin === 200 && contenu.includes(SECRET_B),
    statutTemoin > 0 ? `HTTP ${statutTemoin}, ${contenu.length} octets` : `NON MESURÉ — ${contenu}`,
  );

  // ── 8. LA LIMITE PAR IP (§8.2), EN DERNIER ──
  //
  // Elle vient après tout le reste : la rafale sature le quota, et le
  // contrôle placé derrière recevait un 429 au lieu de sa réponse. Un
  // contrôle qui casse le suivant ne mesure plus rien.
  //
  // Chaque exécution prend une adresse à elle, sans quoi deux lancements
  // dans la même minute se marcheraient dessus — c'est exactement ce qui
  // s'est produit au premier essai, et j'ai cru un instant que la limite
  // était cassée.
  //
  // Cela suppose `TRUST_PROXY=1` : sans lui, l'application ignore
  // délibérément les en-têtes d'adresse (voir `clientIp`). On le DIT plutôt
  // que de rendre un chiffre incompréhensible.
  {
    const COOKIE_B = cookieDe(B.famille, B.membre);
    // Distincte de celle de la campagne : les 40 requêtes déjà émises ne
    // doivent pas décaler la bascule qu'on cherche à situer.
    const monAdresse = `198.51.100.${Math.floor(Math.random() * 250) + 1}9`;
    // `0` quand la requête n'est même pas partie : la rafale se saute
    // alors au lieu de tuer l'outil sur une pile Node.
    const frapper = async (entetes) => {
      try {
        const reponse = await fetch(`${BASE}/api/family/${B.famille.id}/stories`, {
          headers: { Cookie: COOKIE_B, ...entetes },
          redirect: 'manual',
        });
        await reponse.arrayBuffer();
        return reponse.status;
      } catch {
        return 0;
      }
    };

    const distingue = (await frapper({ 'X-Real-IP': monAdresse })) === 200;
    if (!distingue) {
      console.log('↷ limite par IP — sautée : la première requête ne passe pas');
    } else {
      let servis = 1;
      let refuses = 0;
      for (let i = 0; i < 139; i++) {
        const code = await frapper({ 'X-Real-IP': monAdresse });
        if (code === 200) servis += 1;
        if (code === 429) refuses += 1;
      }
      const applique = refuses > 0;
      verifier(
        'au-delà de la limite, la route répond 429',
        applique,
        applique ? `${servis} servies, ${refuses} refusées` : 'aucun refus — TRUST_PROXY est-il posé ?',
      );

      /*
       * ── LE SEAU EST-IL BIEN LE NÔTRE ? ──
       *
       * `TRUST_PROXY` est lu par le SERVEUR, pas par cet outil : lire
       * `process.env` ici renseignerait sur le mauvais processus. On le
       * mesure donc. Une adresse jamais vue, juste après la rafale : si
       * elle est servie, chaque adresse a son seau et le chiffre ci-dessus
       * a un sens ; si elle est refusée, le seau est commun, la rafale a
       * compté les requêtes de tous les outils, et « 73 servies sur 100 »
       * ne dit rien de la §8.2.
       *
       * C'est ce chiffre-là qui rendait cet outil rouge sans qu'aucune
       * ligne du produit ne soit en cause.
       */
      const vierge = await frapper({ 'X-Real-IP': `192.0.2.${Math.floor(Math.random() * 250) + 1}` });
      const seauPropre = vierge === 200;

      if (applique && !seauPropre) {
        console.log(
          `↷ la bascule — NON MESURÉE : une adresse neuve reçoit ${vierge}, le seau est donc\n` +
            '  commun (TRUST_PROXY n’est pas posé côté serveur). Le chiffre serait faux.',
        );
      } else if (applique) {
        verifier(
          'la bascule tombe sur les 100 requêtes annoncées par la §8.2',
          servis >= 95 && servis <= 105,
          `${servis} servies`,
        );

        // ── LE CONTOURNEMENT QUI MARCHAIT ──
        //
        // `clientIp` lisait `X-Forwarded-For` et prenait la valeur de
        // GAUCHE, c'est-à-dire celle que le CLIENT envoie. Mesuré avant
        // correction : 120 requêtes avec une adresse inventée à chaque
        // fois, 120 servies. La limite était appliquée à la lettre et ne
        // protégeait de rien.
        let servisAvecFaux = 0;
        for (let i = 0; i < 130; i++) {
          const faux = `10.0.0.${Math.floor(Math.random() * 250)}`;
          if ((await frapper({ 'X-Forwarded-For': faux })) === 200) servisAvecFaux += 1;
        }
        verifier(
          'inventer son adresse ne rend pas la limite inopérante',
          servisAvecFaux <= 105,
          `${servisAvecFaux} servies sur 130 avec une adresse différente à chaque appel`,
        );
      }
    }
  }

} finally {
  for (const f of [A.famille.id, B.famille.id]) {
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { familyId: f } }),
      prisma.thread.deleteMany({ where: { familyId: f } }),
      prisma.archive.deleteMany({ where: { familyId: f } }),
      prisma.tradition.deleteMany({ where: { familyId: f } }),
      prisma.visibilityLog.deleteMany({ where: { familyId: f } }),
      prisma.passage.deleteMany({ where: { familyId: f } }),
      prisma.story.deleteMany({ where: { familyId: f } }),
      prisma.entity.deleteMany({ where: { familyId: f } }),
      prisma.member.deleteMany({ where: { familyId: f } }),
      prisma.family.delete({ where: { id: f } }),
    ]);
  }
  await prisma.$disconnect();
}

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);