/**
 * LES PANNES — ce que la famille lit quand quelque chose casse.
 *
 * Un produit se juge aussi sur ses mauvais jours. Trois pannes ont été
 * essayées pour de vrai sur une application en marche, et deux d'entre
 * elles n'avaient jamais été regardées :
 *
 *  · LA BASE TOMBE. L'application échoue FERMÉE — elle ne dit pas « aucun
 *    récit », elle ne renvoie personne sur l'écran d'accueil comme si la
 *    personne n'appartenait à aucune famille. C'est le bon comportement, et
 *    c'est le contraire du défaut corrigé côté stockage. Mais l'écran
 *    affiché était celui de Next, en anglais, sans un mot sur ce qu'il
 *    advient de la mémoire.
 *
 *  · UNE ADRESSE QUI N'EXISTE PAS. Aucune page 404 : encore celle de Next.
 *
 *  · LE SECRET DE PRODUCTION MAL RENSEIGNÉ. Là, tout allait déjà bien :
 *    `/api/sante` répond 503 et chaque page échoue, plutôt que de servir
 *    une application dont les cookies ne signeraient rien.
 *
 * ── POURQUOI UN NAVIGATEUR, ET PAS `curl` ──
 *
 * `curl` sur une page en erreur rend `<html id="__next_error__">` : le
 * repli statique de Next, envoyé AVANT que la limite d'erreur côté client
 * ne prenne la main. J'ai d'abord conclu de là que `error.tsx` ne
 * fonctionnait pas, et j'ai failli aller réécrire ce qui marchait. Un vrai
 * navigateur hydrate, la limite s'installe, et le texte français s'affiche.
 * On mesure donc ce que quelqu'un VOIT, pas ce que le premier octet dit.
 *
 * USAGE :  BASE=http://localhost:3000 FAMILY_TOKEN_SECRET=... \
 *            ARRET_BASE="service postgresql stop" \
 *            DEMARRAGE_BASE="service postgresql start" \
 *            node outils/pannes.mjs
 *
 * Sans `ARRET_BASE`, la panne de base est sautée et DITE comme sautée —
 * jamais comptée comme réussie.
 */

import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE;
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');
const ARRET = process.env.ARRET_BASE;
const DEMARRAGE = process.env.DEMARRAGE_BASE;

const prisma = new PrismaClient();
const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!famille) throw new Error('Base vide : lancer `npm run seed` avant le contrôle.');
const membre = await prisma.member.findFirst({
  where: { familyId: famille.id, isDeleted: false },
  orderBy: { createdAt: 'asc' },
});
await prisma.$disconnect();

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

/** Ce que quelqu'un LIT, une fois la page hydratée. */
async function lire(url) {
  const page = await ctx.newPage();
  let statut = 0;
  try {
    const reponse = await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 20000 });
    statut = reponse?.status() ?? 0;
    await page.waitForTimeout(900);
  } catch {
    /* la page peut ne pas se rendre du tout : c'est un résultat */
  }
  const texte = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  await page.close();
  return { statut, texte: texte.replace(/\s+/g, ' ') };
}

// ── 1. Une adresse qui n'existe pas ──
const introuvable = await lire('/recits/cette-adresse-nexiste-pas');
verifier(
  'une adresse inconnue rend une page en français',
  /Introuvable/i.test(introuvable.texte),
  introuvable.texte.slice(0, 60),
);
verifier(
  'et elle ne dit pas SI le récit existe ailleurs',
  !/autre famille|appartient à|supprimé par/i.test(introuvable.texte) ||
    /volontaire/i.test(introuvable.texte),
  'ne distingue pas les trois causes',
);

// ── 2. La base tombe ──
if (!ARRET || !DEMARRAGE) {
  console.log('↷ panne de base — sautée : ARRET_BASE / DEMARRAGE_BASE non fournis');
} else {
  execSync(ARRET, { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3000));
  try {
    const sante = await fetch(`${BASE}/api/sante`).then((r) => r.status).catch(() => 0);
    verifier(
      '/api/sante passe en 503 : l’orchestrateur voit le conteneur malade',
      sante === 503,
      `HTTP ${sante}`,
    );

    const casse = await lire('/recits');
    verifier(
      'la page dit en français que quelque chose n’a pas répondu',
      /n’a pas répondu|ne répond pas/i.test(casse.texte),
      casse.texte.slice(0, 70),
    );
    verifier(
      'elle dit d’abord que rien n’est perdu',
      /ne sont pas perdus/i.test(casse.texte),
    );
    verifier(
      'elle ne fait JAMAIS passer la panne pour une absence',
      !/aucun récit|aucune mémoire|vous n’appartenez/i.test(casse.texte),
    );
    verifier(
      'elle propose de réessayer',
      /Réessayer/i.test(casse.texte),
    );
  } finally {
    execSync(DEMARRAGE, { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ── 3. Et tout revient ──
  const revenu = await lire('/recits');
  verifier(
    'la base revenue, l’application repart sans intervention',
    revenu.statut === 200 && /Récits/.test(revenu.texte),
    `HTTP ${revenu.statut}`,
  );
}

await nav.close();

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
