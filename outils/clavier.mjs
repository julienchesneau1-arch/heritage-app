/**
 * LA NAVIGATION AU CLAVIER — ce qu'axe-core ne regarde pas.
 *
 * L'audit d'accessibilité analyse un arbre figé : il voit un contraste, un
 * rôle, une étiquette manquante. Il ne presse aucune touche. Or trois des
 * défauts les plus handicapants ne se voient qu'en tabulant :
 *
 *  · LE PIÈGE. Un élément qui garde le focus enferme qui n'a pas de souris
 *    dans une zone dont il ne sort plus.
 *  · LE FOCUS INVISIBLE. `:focus-visible` est déclaré dans `globals.css`,
 *    mais une règle déclarée n'est pas une règle appliquée : un `outline:
 *    none` hérité, une bordure de la même couleur que le fond, et le
 *    curseur devient invisible sans que rien ne le signale.
 *  · L'ORDRE INVENTÉ. Un `tabindex` positif réordonne la tabulation sans
 *    toucher à l'ordre visuel. Ce qui se lit dans un ordre se parcourt
 *    alors dans un autre.
 *
 * Ce fichier presse donc Tab, pour de vrai, sur chaque écran.
 *
 * USAGE — l'application doit tourner, avec des données :
 *   BASE=http://localhost:3000 FAMILY_TOKEN_SECRET=... node outils/clavier.mjs
 *
 * ARRÊTER LE SERVEUR AVANT DE RECONSTRUIRE : voir `accessibilite.mjs`.
 */

import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE;
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');

const prisma = new PrismaClient();
const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!famille) throw new Error('Base vide : lancer `npm run seed` avant le contrôle.');
const F = famille.id;

const [membres, recit, entite] = await Promise.all([
  prisma.member.findMany({ where: { familyId: F, isDeleted: false }, orderBy: { createdAt: 'asc' }, take: 2 }),
  prisma.story.findFirst({ where: { familyId: F, suspendedAt: null }, orderBy: { createdAt: 'asc' } }),
  prisma.entity.findFirst({ where: { familyId: F }, orderBy: { createdAt: 'asc' } }),
]);
await prisma.$disconnect();
if (!membres[1] || !recit || !entite) throw new Error('Jeu d’essai incomplet.');
const M = membres[0].id;

const PAGES = [
  ['/', 'Aujourd’hui'],
  ['/recits', 'Récits'],
  [`/recits/${recit.id}`, 'Un récit'],
  ['/recits/nouveau', 'Raconter'],
  [`/graphe?entite=${entite.id}`, 'Le graphe'],
  ['/famille', 'Famille'],
  ['/traditions', 'Traditions'],
  ['/entretien', 'Entretien — avant'],
  [`/entretien/parler?relecteur=${membres[1].id}`, 'Entretien — parler'],
  ['/veillee?etape=1', 'La veillée'],
  ['/qui', 'Qui êtes-vous'],
];

/** Au-delà, on considère qu'on tourne en rond plutôt qu'on avance. */
const COUPS_MAX = 120;

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
await ctx.addCookies([
  { name: 'family_token', value: `${F}.1.${sign(`${F}:1`)}`, domain: 'localhost', path: '/' },
  { name: 'member_token', value: `${M}.verified.${sign(`${M}.verified`)}`, domain: 'localhost', path: '/' },
]);

const defauts = [];

for (const [url, nom] of PAGES) {
  const page = await ctx.newPage();
  const reponse = await page.goto(BASE + url, { waitUntil: 'networkidle' });
  if (!reponse || reponse.status() >= 400 || (await page.$('#__next_error__'))) {
    throw new Error(`${nom} (${url}) ne se rend pas — contrôle interrompu.`);
  }
  // ── Et l'adresse doit être celle qu'on a demandée ──
  // Un cookie invalide renvoie sur `/bienvenue`, qui répond 200 et se rend
  // parfaitement. L'outil visitait alors onze fois le même écran d'accueil
  // et annonçait « 0 défaut sur 11 pages ». Le code HTTP ne dit rien d'une
  // redirection réussie ; seule l'adresse d'arrivée le dit.
  const arrivee = new URL(page.url()).pathname;
  const demande = new URL(BASE + url).pathname;
  if (arrivee !== demande) {
    throw new Error(`${nom} : demandé ${demande}, arrivé sur ${arrivee} — contrôle interrompu.`);
  }

  // ── L'ordre n'est jamais réinventé ──
  const positifs = await page.$$eval('[tabindex]', (elements) =>
    elements.filter((e) => Number(e.getAttribute('tabindex')) > 0).map((e) => e.outerHTML.slice(0, 80)),
  );
  for (const exemple of positifs) {
    defauts.push({ page: nom, quoi: 'tabindex positif', exemple });
  }

  await page.evaluate(() => document.body.focus());
  const vus = [];
  let precedent = null;
  let bloque = 0;

  for (let coup = 0; coup < COUPS_MAX; coup++) {
    await page.keyboard.press('Tab');
    const actuel = await page.evaluate(() => {
      const e = document.activeElement;
      if (!e || e === document.body) return null;
      const style = getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      return {
        // L'IDENTITÉ de l'élément, pas son apparence. Une signature faite
        // du tag et des classes confondait les huit liens du menu, qui les
        // partagent tous : la détection de piège se déclenchait sur une
        // navigation parfaitement normale. On prend donc sa position réelle
        // dans le document.
        signature: String([...document.querySelectorAll('*')].indexOf(e)),
        ou: `${e.tagName}.${e.className}`.slice(0, 90),
        // Un champ de date garde le focus pendant que Tab passe d'un
        // segment à l'autre (jour, mois, année). Ce n'est pas un piège,
        // c'est le contrôle natif — le compter en serait un faux.
        segmente: e.tagName === 'INPUT' && ['date', 'time', 'datetime-local'].includes(e.type),
        texte: (e.textContent ?? '').trim().slice(0, 40),
        // `:focus-visible` pose un contour dans `globals.css`. On lit ce que
        // le navigateur CALCULE, pas ce que la feuille déclare.
        contour: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
        // Un élément de taille nulle reçoit le focus sans que personne ne
        // puisse voir où il est — le lien d'évitement mis à part, qui se
        // déplie précisément quand on l'atteint.
        hauteur: Math.round(rect.height),
      };
    });

    if (actuel === null) break; // on est sorti du document : pas de piège.

    if (precedent && actuel.signature === precedent) {
      bloque++;
      if (bloque >= (actuel.segmente ? 6 : 3)) {
        defauts.push({ page: nom, quoi: 'piège au clavier', exemple: `${actuel.ou} « ${actuel.texte} »` });
        break;
      }
    } else {
      bloque = 0;
    }
    precedent = actuel.signature;

    // ── La seule exception, et elle est nommée ──
    // `<input type="date">` délègue le focus à un segment de son DOM
    // fantôme : l'élément est `document.activeElement` sans correspondre à
    // `:focus`, donc aucune feuille de style ne peut lui poser de contour.
    // Le repère existe bien — Chromium éclaire le segment — mais il est
    // hors d'atteinte de la mesure. On l'exempte ici plutôt que de
    // l'ignorer en silence, et on ne l'exempte que lui.
    if (!actuel.contour && !actuel.segmente) {
      defauts.push({
        page: nom,
        quoi: 'focus sans contour visible',
        exemple: `${actuel.ou} « ${actuel.texte} »`,
      });
    }
    if (actuel.hauteur === 0) {
      defauts.push({ page: nom, quoi: 'focus sur un élément de hauteur nulle', exemple: actuel.ou });
    }
    vus.push(actuel);
  }

  // ── L'outil doit avoir vu quelque chose ──
  // Une boucle qui sort au premier coup rend « 0 défaut » sur chaque page,
  // et c'est arrivé : des cookies périmés renvoyaient tout sur l'accueil,
  // sept arrêts partout, onze coches vertes. Le contrôle d'adresse plus
  // haut ferme ce cas précis ; ce plancher ferme les autres.
  if (vus.length < 5) {
    defauts.push({ page: nom, quoi: 'parcours anormalement court', exemple: `${vus.length} arrêts` });
  }

  // Le lien d'évitement doit venir en premier : c'est tout son intérêt.
  const premier = vus[0]?.texte ?? '';
  if (!premier.startsWith('Aller au contenu')) {
    defauts.push({ page: nom, quoi: 'le lien d’évitement n’est pas le premier arrêt', exemple: premier });
  }

  const mauvais = defauts.filter((d) => d.page === nom).length;
  console.log(`${mauvais === 0 ? '✓' : '✗'} ${nom.padEnd(22)} ${vus.length} arrêts, ${mauvais} défaut(s)`);
  await page.close();
}

await nav.close();

if (defauts.length > 0) {
  console.log('\nDÉFAUTS :');
  for (const d of defauts) console.log(` · ${d.page} — ${d.quoi} : ${d.exemple}`);
}
console.log('\nTOTAL :', defauts.length, 'défauts sur', PAGES.length, 'pages');
