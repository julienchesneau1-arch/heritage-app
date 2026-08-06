/**
 * LES DEUX PROMESSES QUI NE SE VOIENT PAS À L'ÉCRAN.
 *
 * Le produit en fait deux qu'aucun test ne touchait, parce qu'aucune des
 * deux ne se vérifie en lisant du code :
 *
 *  1. LE LIVRE (Annexe A, points 1 et 7). « Un objet qu'on peut poser sur
 *     une table » — c'est-à-dire du PAPIER. La feuille de style
 *     d'impression existe depuis le premier jour ; personne n'avait jamais
 *     imprimé. Un `@media print` qui ne cache pas le menu, un saut de page
 *     qui coupe un récit en deux, une adresse imprimée entre parenthèses
 *     après chaque lien : rien de tout cela ne se voit à l'écran, et tout
 *     se voit sur la première page sortie de l'imprimante.
 *
 *  2. LE HORS-LIGNE. L'application est une PWA avec Service Worker et page
 *     de repli. Promettre à une famille qu'elle accède à sa mémoire dans
 *     un train et ne jamais couper le réseau pour vérifier, c'est la même
 *     faute que partout ailleurs ici.
 *
 * USAGE :  BASE=http://localhost:3000 FAMILY_TOKEN_SECRET=... \
 *            node outils/hors-ecran.mjs
 *
 * ARRÊTER LE SERVEUR AVANT DE RECONSTRUIRE : voir `accessibilite.mjs`.
 */

import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE;
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');

const prisma = new PrismaClient();
const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!famille) throw new Error('Base vide : lancer `npm run seed` avant le contrôle.');
const membre = await prisma.member.findFirst({
  where: { familyId: famille.id, isDeleted: false },
  orderBy: { createdAt: 'asc' },
});
const recits = await prisma.story.count({ where: { familyId: famille.id, suspendedAt: null } });
await prisma.$disconnect();
if (!membre) throw new Error('Jeu d’essai incomplet : aucun membre.');
if (recits === 0) throw new Error('Jeu d’essai sans récit : le livre serait vide, et le contrôle vide aussi.');

const resultats = [];
function verifier(nom, condition, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const ctx = await nav.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
await ctx.addCookies([
  { name: 'family_token', value: `${famille.id}.1.${sign(`${famille.id}:1`)}`, domain: 'localhost', path: '/' },
  { name: 'member_token', value: `${membre.id}.verified.${sign(`${membre.id}.verified`)}`, domain: 'localhost', path: '/' },
]);

// ─────────────────────────────────────────────────────────────────────
// 1. LE LIVRE, SUR DU PAPIER
// ─────────────────────────────────────────────────────────────────────

const page = await ctx.newPage();
const reponse = await page.goto(`${BASE}/livre`, { waitUntil: 'networkidle' });
if (!reponse || reponse.status() >= 400 || new URL(page.url()).pathname !== '/livre') {
  throw new Error(`/livre : arrivé sur ${new URL(page.url()).pathname} (${reponse?.status()})`);
}

// `emulateMedia` fait basculer le rendu en média `print` SANS produire de
// PDF : c'est le seul moyen de lire ce que la feuille d'impression calcule.
await page.emulateMedia({ media: 'print' });

const impression = await page.evaluate(() => {
  const cache = (selecteur) => {
    const element = document.querySelector(selecteur);
    return element === null || getComputedStyle(element).display === 'none';
  };
  const lien = document.querySelector('.livre a[href]') ?? document.querySelector('a[href]');
  return {
    menuCache: cache('header'),
    piedCache: cache('footer'),
    navCache: cache('nav'),
    rappelCache: cache('.rappel-impression'),
    // Un récit coupé en deux par un saut de page est un récit qu'on ne
    // lit pas. `break-inside: avoid` doit être calculé, pas seulement écrit.
    recitInsecable: getComputedStyle(document.querySelector('.livre .recit')).breakInside === 'avoid',
    // Le livre ne doit renvoyer à aucun écran : pas d'adresse imprimée.
    adresseImprimee: lien ? getComputedStyle(lien, '::after').content : 'aucun lien',
    fondBlanc: getComputedStyle(document.body).backgroundColor,
    corps: getComputedStyle(document.querySelector('.livre')).fontSize,
  };
});

verifier('le menu ne s’imprime pas', impression.menuCache);
verifier('la navigation ne s’imprime pas', impression.navCache);
verifier('le pied de page ne s’imprime pas', impression.piedCache);
verifier('le rappel d’impression ne s’imprime pas', impression.rappelCache);
verifier('un récit ne se coupe pas entre deux pages', impression.recitInsecable);
verifier(
  'aucune adresse web n’est imprimée après les liens',
  impression.adresseImprimee === 'none' || impression.adresseImprimee === 'aucun lien',
  impression.adresseImprimee,
);
verifier(
  'le fond est blanc, pas crème',
  impression.fondBlanc === 'rgb(255, 255, 255)',
  impression.fondBlanc,
);

// Et le PDF, réellement produit : c'est la seule preuve que la chaîne
// entière tient, `@page` compris.
const dossier = mkdtempSync(join(tmpdir(), 'livre-'));
const pdf = await page.pdf({ format: 'A4', printBackground: false });
const chemin = join(dossier, 'livre.pdf');
writeFileSync(chemin, pdf);

const entete = pdf.subarray(0, 5).toString('latin1');
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
verifier('le PDF est un PDF', entete === '%PDF-', entete);
verifier('il contient au moins deux pages', pages >= 2, `${pages} pages, ${pdf.length} octets`);
console.log(`  → ${chemin}`);

await page.emulateMedia({ media: 'screen' });
await page.close();

// ─────────────────────────────────────────────────────────────────────
// 2. LE HORS-LIGNE
//
// ── Pourquoi un relais, et pas `setOffline` ──
//
// Première version : `context.setOffline(true)`, puis navigation. Elle
// annonçait deux résultats, dont un « défaut ». Les deux étaient faux : un
// contrôle — `fetch('/api/health')` pendant la coupure — a répondu 404,
// c'est-à-dire que le serveur était joignable. Le réseau n'avait jamais
// été coupé. `context.route(..., abort)` ne fait pas mieux : ni l'un ni
// l'autre n'intercepte une requête émise par le SERVICE WORKER, et c'est
// précisément lui qu'on veut mettre à l'épreuve.
//
// Le navigateur passe donc par un relais que ce fichier tient lui-même et
// qu'il peut débrancher pour de bon. Et rien n'est conclu avant que le
// contrôle ait montré la coupure : un test hors ligne qui n'a pas coupé le
// réseau rend « tout va bien » sur une application qui ne marcherait pas.
// ─────────────────────────────────────────────────────────────────────

const PORT_RELAIS = 4583;
const ORIGINE = `http://127.0.0.1:${PORT_RELAIS}`;
let branche = true;

const relais = createServer((entrante, sortante) => {
  if (!branche) {
    // On coupe la connexion, comme le ferait un réseau absent.
    entrante.destroy();
    sortante.destroy();
    return;
  }
  const amont = request(
    { hostname: '127.0.0.1', port: new URL(BASE).port || 80, path: entrante.url, method: entrante.method, headers: entrante.headers },
    (reponse) => {
      sortante.writeHead(reponse.statusCode ?? 502, reponse.headers);
      reponse.pipe(sortante);
    },
  );
  amont.on('error', () => sortante.destroy());
  entrante.pipe(amont);
});
await new Promise((resoudre) => relais.listen(PORT_RELAIS, '127.0.0.1', resoudre));

const ctxHL = await nav.newContext({ viewport: { width: 390, height: 844 }, locale: 'fr-FR' });
await ctxHL.addCookies([
  { name: 'family_token', value: `${famille.id}.1.${sign(`${famille.id}:1`)}`, domain: '127.0.0.1', path: '/' },
  { name: 'member_token', value: `${membre.id}.verified.${sign(`${membre.id}.verified`)}`, domain: '127.0.0.1', path: '/' },
]);

const horsLigne = await ctxHL.newPage();
await horsLigne.goto(`${ORIGINE}/`, { waitUntil: 'networkidle' });

const actif = await horsLigne
  .waitForFunction(async () => {
    const enregistrement = await navigator.serviceWorker.getRegistration();
    return Boolean(enregistrement?.active);
  }, null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
verifier('le Service Worker s’enregistre et devient actif', actif);

if (actif) {
  // On chauffe le cache comme le ferait une famille : elle a lu ces pages.
  await horsLigne.goto(`${ORIGINE}/hors-ligne`, { waitUntil: 'networkidle' });
  await horsLigne.goto(`${ORIGINE}/recits`, { waitUntil: 'networkidle' });
  await horsLigne.goto(`${ORIGINE}/`, { waitUntil: 'networkidle' });

  branche = false;

  // ── LE CONTRÔLE, avant toute conclusion ──
  const joignable = await horsLigne.evaluate(async () => {
    try {
      await fetch('/api/sonde-hors-ligne', { cache: 'no-store' });
      return true;
    } catch {
      return false;
    }
  });
  verifier('le réseau est RÉELLEMENT coupé avant de conclure', !joignable);

  if (!joignable) {
    // 1. Une page déjà lue reste lisible : c'est la promesse de la §7.
    let deja = null;
    try {
      await horsLigne.goto(`${ORIGINE}/recits`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      deja = await horsLigne.evaluate(() => document.querySelector('main')?.innerText ?? '');
    } catch (error) {
      deja = `ÉCHEC : ${error.message.split('\n')[0]}`;
    }
    verifier(
      'une page déjà lue reste lisible sans réseau',
      typeof deja === 'string' && deja.includes('Récits') && !deja.startsWith('ÉCHEC'),
      (deja ?? '').replace(/\s+/g, ' ').slice(0, 60),
    );

    // 2. Une page JAMAIS lue ne s'invente pas : c'est le repli qui répond,
    //    et il dit qu'il ne sait pas, au lieu d'afficher une page vide.
    let jamais = null;
    try {
      await horsLigne.goto(`${ORIGINE}/traditions`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      jamais = await horsLigne.evaluate(() => document.querySelector('main')?.innerText ?? '');
    } catch (error) {
      jamais = `ÉCHEC : ${error.message.split('\n')[0]}`;
    }
    verifier(
      'une page jamais lue rend le repli, et non un contenu vide',
      typeof jamais === 'string' && /hors ligne/i.test(jamais),
      (jamais ?? '').replace(/\s+/g, ' ').slice(0, 70),
    );
  }

  branche = true;
}

await ctxHL.close();
relais.close();

await nav.close();

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
