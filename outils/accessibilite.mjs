/**
 * AUDIT D'ACCESSIBILITÉ — axe-core sur l'application qui tourne.
 *
 * La §6.4 pose des règles ; elles étaient appliquées à la main et vérifiées
 * à l'œil depuis le premier jour. C'est-à-dire affirmées, jamais établies —
 * exactement ce que l'amendement 6 interdit.
 *
 * Premier passage, 16 pages : 17 violations, dont trois classes réelles.
 *   · `color-contrast` sur 15 pages. La barre de navigation appliquait
 *     `opacity-80` à une couleur mesurée à 4,84:1, ce qui la ramène à
 *     3,28:1. Mon test de contraste mesurait le JETON ; l'écran affichait
 *     le jeton MULTIPLIÉ par une opacité. C'est le piège que j'avais
 *     reproché à la maquette, posé de ma main.
 *   · `nested-interactive` sur le graphe : `role="img"` déclarait l'image
 *     atomique alors qu'elle contient des liens.
 *   · `label` sur le champ audio de l'entretien : invisible à l'œil, bien
 *     réel pour un lecteur d'écran.
 * Après correction : 0 violation sur 16 pages.
 *
 * USAGE — l'application doit tourner, avec des données :
 *   BASE=http://localhost:3000 FAMILY_TOKEN_SECRET=... OUT=/tmp/axe.json \
 *     node outils/accessibilite.mjs
 *
 * ARRÊTER LE SERVEUR AVANT DE RECONSTRUIRE. `npm run build` réécrit `.next`
 * sous le serveur en cours, qui se met alors à rendre au hasard des pages
 * dont les fragments ont disparu. Le symptôme est le pire possible : une
 * page en erreur porte peu de violations, donc l'audit passe au vert sur
 * une application cassée. Le contrôle `#__next_error__` plus bas existe
 * pour ça, et c'est ainsi qu'on a trouvé le cas.
 *
 * Les identifiants ci-dessous sont ceux du jeu d'essai (`npm run seed`).
 * Sur une autre base, les remplacer — une page en 404 ne signale rien, et
 * un audit qui ne visite rien rend « 0 violation ».
 *
 * Non intégré à `npm test` : axe-core exige un vrai navigateur et une base
 * peuplée. Un test qui ne peut pas s'exécuter partout finit par être
 * désactivé, et un test désactivé est pire qu'un outil qu'on lance.
 */

import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE;
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');
const AXE = readFileSync('./node_modules/axe-core/axe.min.js', 'utf8');

/**
 * ── Les identifiants viennent de la base, jamais du code ──
 *
 * Ils étaient écrits en dur, copiés d'un `npm run seed` d'un jour donné.
 * Une base re-semée les change tous : l'audit visitait alors seize pages en
 * 404, chacune sans violation, et concluait « 0 violation sur 16 pages ».
 * C'est le défaut que ce fichier existe pour empêcher, retourné contre
 * lui-même — le produit affirmait ce qu'il n'avait pas établi.
 *
 * On les lit donc dans la base, et on refuse de commencer s'il manque quoi
 * que ce soit : mieux vaut un outil qui s'arrête qu'un rapport qui ment.
 */
const prisma = new PrismaClient();
const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!famille) throw new Error('Base vide : lancer `npm run seed` avant l’audit.');
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
if (manque.length) throw new Error(`Jeu d’essai incomplet, audit impossible : ${manque.join(', ')}.`);

const M = membres[0].id;
const RELECTEUR = membres[1].id;

const PAGES = [
  ['/', 'Aujourd’hui'],
  ['/recits', 'Récits'],
  [`/recits/${recit.id}`, 'Un récit'],
  ['/recits/nouveau', 'Raconter'],
  [`/fils/${fil.id}`, 'Un fil'],
  ['/veillee?etape=1', 'La veillée'],
  [`/graphe?entite=${entite.id}`, 'Le graphe'],
  ['/graphe', 'Le graphe — entrée'],
  ['/traditions', 'Traditions'],
  ['/archives', 'Archives'],
  ['/brouillons', 'À mettre au propre'],
  ['/famille', 'Famille'],
  ['/transmission', 'Reddition de comptes'],
  ['/importer', 'Importer'],
  ['/livre', 'Le livre'],
  ['/entretien', 'Entretien — avant'],
  [`/entretien/parler?relecteur=${RELECTEUR}`, 'Entretien — parler'],
  ['/qui', 'Qui êtes-vous'],
];

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
await ctx.addCookies([
  { name: 'family_token', value: `${F}.1.${sign(`${F}:1`)}`, domain: 'localhost', path: '/' },
  { name: 'member_token', value: `${M}.verified.${sign(`${M}.verified`)}`, domain: 'localhost', path: '/' },
]);

const tout = [];
for (const [url, nom] of PAGES) {
  const page = await ctx.newPage();
  const reponse = await page.goto(BASE + url, { waitUntil: 'networkidle' });
  // Une page en erreur ne porte aucune violation : la compter comme
  // « conforme » est précisément le mensonge qu'on veut empêcher.
  if (!reponse || reponse.status() >= 400) {
    throw new Error(`${nom} (${url}) répond ${reponse?.status() ?? 'rien'} — audit interrompu.`);
  }
  // Next rend sa page d'erreur en 200 : le code HTTP seul ne suffit pas.
  // Une page plantée porte peu de violations — elle n'affiche presque rien —
  // et se présente donc comme un bon résultat. Vu de mes propres yeux : un
  // build écrasé sous un serveur en cours a rendu trois écrans en erreur, et
  // le rapport les a comptés comme des pages auditées.
  if (await page.$('#__next_error__')) {
    throw new Error(`${nom} (${url}) rend la page d’erreur de Next — audit interrompu.`);
  }
  await page.addScriptTag({ content: AXE });
  const r = await page.evaluate(async () =>
    // WCAG 2.1 AA : c'est le niveau que la §6.4 décrit sans le nommer.
    await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } }),
  );
  for (const v of r.violations) {
    tout.push({ page: nom, url, id: v.id, impact: v.impact, help: v.help, n: v.nodes.length,
                exemple: v.nodes[0]?.html?.slice(0, 140), cible: v.nodes[0]?.target?.join(' ') });
  }
  console.log(`${r.violations.length === 0 ? '✓' : '✗'} ${nom.padEnd(24)} ${r.violations.length} violation(s), ${r.passes.length} règles passées`);
  await page.close();
}
writeFileSync(process.env.OUT, JSON.stringify(tout, null, 1));
console.log('\nTOTAL :', tout.length, 'violations sur', PAGES.length, 'pages');
await nav.close();
