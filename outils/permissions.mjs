/**
 * LES PERMISSIONS DU NAVIGATEUR — et l'enregistrement, de bout en bout.
 *
 * ── Le défaut que ce fichier existe pour avoir trouvé ──
 *
 * `next.config.mjs` servait `Permissions-Policy: microphone=()`. Le
 * commentaire à côté disait « pas de micro sans action explicite ». Ce
 * n'est pas ce que la valeur signifie : une liste vide n'autorise PERSONNE,
 * l'origine elle-même comprise.
 *
 * Conséquence, en production et nulle part ailleurs : le mode entretien —
 * un écran, une question, un bouton, tout le chemin construit pour ceux qui
 * n'écrivent pas — ne pouvait enregistrer aucun mot. Le bouton s'affichait,
 * on appuyait, il ne se passait rien. Aucune erreur applicative, aucun test
 * rouge, aucune trace : le navigateur refusait avant de demander.
 *
 * Une chaîne de caractères dans un fichier de configuration ne se relit
 * pas, elle s'exécute. Ce fichier l'exécute.
 *
 * USAGE :  BASE=http://localhost:3000 FAMILY_TOKEN_SECRET=... \
 *            node outils/permissions.mjs
 */

import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE;
const sign = (p) => createHmac('sha256', process.env.FAMILY_TOKEN_SECRET).update(p).digest('hex');

const prisma = new PrismaClient();
const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!famille) throw new Error('Base vide : lancer `npm run seed` avant le contrôle.');
const membres = await prisma.member.findMany({
  where: { familyId: famille.id, isDeleted: false },
  orderBy: { createdAt: 'asc' },
  take: 2,
});
await prisma.$disconnect();
if (!membres[1]) throw new Error('Il faut deux membres : quelqu’un parle, quelqu’un relit.');

const resultats = [];
function verifier(nom, condition, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

// ── Les en-têtes, tels qu'ils sortent du serveur ──
const entetes = (await fetch(`${BASE}/bienvenue`)).headers;
const ATTENDUS = {
  'strict-transport-security': /max-age=\d{7,}/,
  'x-content-type-options': /^nosniff$/,
  'x-frame-options': /^DENY$/,
  'referrer-policy': /strict-origin/,
  'permissions-policy': /microphone=\(self\)/,
};
for (const [nom, motif] of Object.entries(ATTENDUS)) {
  const valeur = entetes.get(nom);
  verifier(`en-tête ${nom}`, Boolean(valeur) && motif.test(valeur), valeur ?? 'absent');
}
verifier('aucun en-tête ne trahit la pile', !entetes.get('x-powered-by'));

// Un micro fictif : le contrôle ne dépend d'aucun matériel.
const nav = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const ctx = await nav.newContext({
  viewport: { width: 390, height: 844 },
  locale: 'fr-FR',
  permissions: ['microphone'],
});
await ctx.addCookies([
  { name: 'family_token', value: `${famille.id}.1.${sign(`${famille.id}:1`)}`, domain: 'localhost', path: '/' },
  { name: 'member_token', value: `${membres[0].id}.verified.${sign(`${membres[0].id}.verified`)}`, domain: 'localhost', path: '/' },
]);

const page = await ctx.newPage();
await page.goto(`${BASE}/entretien/parler?relecteur=${membres[1].id}`, { waitUntil: 'networkidle' });
verifier(
  'l’écran où l’on parle se rend',
  new URL(page.url()).pathname === '/entretien/parler' && !(await page.$('#__next_error__')),
);

// ── Ce que la POLITIQUE autorise ──
const politique = await page.evaluate(() => ({
  micro: document.featurePolicy?.allowsFeature('microphone') ?? null,
  geo: document.featurePolicy?.allowsFeature('geolocation') ?? null,
  camera: document.featurePolicy?.allowsFeature('camera') ?? null,
}));
verifier('le micro est autorisé à l’application', politique.micro === true);
verifier('la géolocalisation reste fermée — §3.1', politique.geo === false);
verifier(
  'la caméra reste fermée : les photos passent par un champ de fichier',
  politique.camera === false,
);

// ── Et ce que le navigateur DONNE réellement ──
const flux = await page.evaluate(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pistes = stream.getAudioTracks().length;
    stream.getTracks().forEach((piste) => piste.stop());
    return { ok: true, pistes };
  } catch (error) {
    return { ok: false, erreur: `${error.name} — ${error.message}` };
  }
});
verifier(
  'getUserMedia rend un flux audio, pour de vrai',
  flux.ok && flux.pistes > 0,
  flux.ok ? `${flux.pistes} piste(s)` : flux.erreur,
);

// ── L'enregistreur, de bout en bout ──
//
// Le seul contrôle qui prouve que quelqu'un peut parler : on appuie sur le
// bouton, on attend, on arrête, et on regarde si des octets sont arrivés
// dans le champ de fichier que le formulaire enverra.
const bouton = page.getByRole('button', { name: /enregistrer une voix/i });
if (await bouton.count()) {
  await bouton.first().click();
  await page.waitForTimeout(1200);
  const arret = page.getByRole('button', { name: /arrêter|terminer l.enregistrement|stop/i });
  if (await arret.count()) {
    await arret.first().click();
    await page.waitForTimeout(800);
  }
  const depose = await page.evaluate(() => {
    const champ = document.querySelector('input[type="file"][name="audio"]');
    const fichier = champ?.files?.[0];
    return fichier ? { nom: fichier.name, octets: fichier.size, type: fichier.type } : null;
  });
  verifier(
    'appuyer sur « Enregistrer une voix » dépose vraiment des octets',
    Boolean(depose) && depose.octets > 0,
    depose ? `${depose.octets} octets, ${depose.type}` : 'aucun fichier dans le champ',
  );
} else {
  verifier('le bouton d’enregistrement est présent', false, 'introuvable sur l’écran');
}

await nav.close();

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
