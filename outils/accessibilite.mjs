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

const BASE = process.env.BASE;
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');
const F = 'cmsdzwxe90000w8cjgx06wtq1';
const M = 'cmsdzwxed0002w8cj92d9kf9z';
const AXE = readFileSync('./node_modules/axe-core/axe.min.js', 'utf8');

const PAGES = [
  ['/', 'Aujourd’hui'],
  ['/recits', 'Récits'],
  ['/recits/cmsdzwxfv000uw8cjspd9q6b6', 'Un récit'],
  ['/recits/nouveau', 'Raconter'],
  ['/fils/cmsdzwxge0014w8cjel4a98ev', 'Un fil'],
  ['/veillee?etape=1', 'La veillée'],
  ['/graphe?entite=cmsdzwxfe000ew8cjdlluto2r', 'Le graphe'],
  ['/traditions', 'Traditions'],
  ['/archives', 'Archives'],
  ['/famille', 'Famille'],
  ['/transmission', 'Reddition de comptes'],
  ['/importer', 'Importer'],
  ['/livre', 'Le livre'],
  ['/entretien', 'Entretien — avant'],
  ['/entretien/parler?relecteur=cmsdzwxex0004w8cj7e02l5cv', 'Entretien — parler'],
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
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
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
