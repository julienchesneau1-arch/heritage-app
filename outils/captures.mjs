/**
 * LES CAPTURES — `redesign/captures/`.
 *
 * Elles ont d'abord été prises à la main, écran par écran, avec un script
 * jeté après usage. Résultat : personne ne pouvait les refaire, et une
 * planche de captures qu'on ne peut pas régénérer devient un document
 * périmé qui ressemble à un document à jour — la pire des deux.
 *
 * Comme `accessibilite.mjs`, cet outil lit les identifiants dans la base :
 * un identifiant écrit en dur produirait seize captures de pages 404, et
 * elles auraient l'air parfaitement normales dans un dossier.
 *
 * USAGE — l'application doit tourner, avec des données :
 *   BASE=http://localhost:3000 node outils/captures.mjs
 *
 * Le format est WebP : une planche de dix-huit captures en PNG pèse dix
 * fois plus pour le même dépôt, et ces images sont versionnées.
 */

import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE;
const SORTIE = process.env.SORTIE ?? 'redesign/captures';
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');

const prisma = new PrismaClient();
const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!famille) throw new Error('Base vide : lancer `npm run seed` avant les captures.');
const F = famille.id;

const [membres, recit, fil, entite] = await Promise.all([
  prisma.member.findMany({ where: { familyId: F, isDeleted: false }, orderBy: { createdAt: 'asc' }, take: 2 }),
  prisma.story.findFirst({ where: { familyId: F, suspendedAt: null }, orderBy: { createdAt: 'asc' } }),
  prisma.thread.findFirst({ where: { familyId: F }, orderBy: { createdAt: 'asc' } }),
  prisma.entity.findFirst({ where: { familyId: F }, orderBy: { createdAt: 'asc' } }),
]);
await prisma.$disconnect();

const manque = Object.entries({ membre: membres[0], relecteur: membres[1], recit, fil, entite })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (manque.length) throw new Error(`Jeu d’essai incomplet : ${manque.join(', ')}.`);

const M = membres[0].id;

/** `nu` : sans cookie de membre — c'est ainsi que se voit le premier jour. */
const ECRANS = [
  ['00-premier-jour', '/', { nu: true }],
  ['01-aujourdhui', '/'],
  ['02-recits', '/recits'],
  ['03-un-recit', `/recits/${recit.id}`],
  ['04-fil', `/fils/${fil.id}`],
  ['05-veillee', '/veillee?etape=1'],
  ['06-graphe', `/graphe?entite=${entite.id}`],
  ['07-traditions', '/traditions'],
  ['08-famille', '/famille'],
  ['09-reddition', '/transmission'],
  ['10-importer', '/importer'],
  ['11-raconter', '/recits/nouveau'],
  ['12-livre', '/livre'],
  ['13-entretien-avant', '/entretien'],
  ['13-entretien-parler', `/entretien/parler?relecteur=${membres[1].id}`],
  ['14-brouillons', '/brouillons'],
  ['15-archives', '/archives'],
  ['16-qui', '/qui'],
];

mkdirSync(SORTIE, { recursive: true });

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// Un téléphone, pas un écran de bureau : c'est l'objet sur lequel cette
// application est tenue, et le seul cadrage où les arbitrages se jugent.
const cadre = { viewport: { width: 390, height: 844 }, locale: 'fr-FR', deviceScaleFactor: 2 };
const famille_ck = { name: 'family_token', value: `${F}.1.${sign(`${F}:1`)}`, domain: 'localhost', path: '/' };
const membre_ck = { name: 'member_token', value: `${M}.verified.${sign(`${M}.verified`)}`, domain: 'localhost', path: '/' };

/**
 * Playwright n'écrit que du PNG. C'est Chromium lui-même qui encode le
 * WebP, via un canevas — aucune dépendance native à installer, et donc
 * aucune raison pour que cet outil cesse de tourner sur une autre machine.
 */
const encodeur = await nav.newContext();
const atelier = await encodeur.newPage();
async function enWebp(png, qualite) {
  const b64 = png.toString('base64');
  const sortie = await atelier.evaluate(
    async ([donnees, q]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${donnees}`;
      await image.decode();
      const canevas = document.createElement('canvas');
      canevas.width = image.naturalWidth;
      canevas.height = image.naturalHeight;
      canevas.getContext('2d').drawImage(image, 0, 0);
      return canevas.toDataURL('image/webp', q).split(',')[1];
    },
    [b64, qualite],
  );
  return Buffer.from(sortie, 'base64');
}

for (const [nom, url, options = {}] of ECRANS) {
  const ctx = await nav.newContext(cadre);
  await ctx.addCookies(options.nu ? [famille_ck] : [famille_ck, membre_ck]);
  const page = await ctx.newPage();
  const reponse = await page.goto(BASE + url, { waitUntil: 'networkidle' });
  if (!reponse || reponse.status() >= 400) {
    throw new Error(`${nom} (${url}) répond ${reponse?.status() ?? 'rien'} — captures interrompues.`);
  }
  // Next rend sa page d'erreur en 200. Une capture d'écran plantée ressemble
  // à une capture d'écran, et c'est ainsi qu'un dossier périmé se constitue.
  if (await page.$('#__next_error__')) {
    throw new Error(`${nom} (${url}) rend la page d’erreur de Next — captures interrompues.`);
  }
  const png = await page.screenshot({ fullPage: true });
  writeFileSync(`${SORTIE}/${nom}.webp`, await enWebp(png, 0.82));
  console.log(`✓ ${nom.padEnd(22)} ${url}`);
  await ctx.close();
}

await nav.close();
console.log(`\n${ECRANS.length} captures dans ${SORTIE}/`);
