/**
 * LE COFFRE SURVIT-IL À L'APPLICATION ? — le seul contrôle qui débranche tout.
 *
 * L'Annexe A point 7 dit : « le succès ultime est que la famille continue
 * de transmettre SANS l'app ». Le produit a longtemps tenu cette phrase à
 * moitié — le livre s'imprime, l'export rend le JSON, et les deux exigent
 * que le serveur réponde. Le jour où il ne répond plus, il n'y a rien.
 *
 * Le coffre est le fichier qui doit rendre cette phrase littérale. Le
 * vérifier en lisant son code ne prouve rien : un `<img>` oublié, une
 * police distante, un `</script>` dans un récit, et le fichier se dégrade —
 * silencieusement, chez quelqu'un, dans dix ans.
 *
 * On le met donc dans la seule situation qui compte :
 *
 *  1. On le télécharge depuis l'application, comme une famille le ferait.
 *  2. On l'ouvre en `file://` — l'application n'est PAS dans la boucle.
 *  3. On fait ÉCHOUER toute requête qui ne serait pas `file:` et on les
 *     compte. Une seule suffit à dire que le fichier n'est pas autonome.
 *  4. On lit le texte réellement RENDU à l'écran, pas le source : un récit
 *     présent dans les octets mais non affiché ne transmet rien.
 *  5. On extrait le JSON embarqué du DOM et on le RÉIMPORTE dans une
 *     famille neuve. C'est le vrai test du point 7 : le coffre ne doit pas
 *     seulement se lire, il doit permettre de repartir ailleurs.
 *  6. On l'imprime en PDF, puisque le papier est ce qui dure le plus.
 *
 * La famille de contrôle est effacée à la fin, quoi qu'il arrive.
 *
 * USAGE :  BASE=http://localhost:3000 npx tsx outils/coffre.mts
 */

import { chromium } from 'playwright';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { ImportService } from '../src/services/import.service';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const SECRET = process.env.FAMILY_TOKEN_SECRET;
if (!SECRET) throw new Error('FAMILY_TOKEN_SECRET manquant.');
const sign = (p: string) => createHmac('sha256', SECRET).update(p).digest('hex');

const prisma = new PrismaClient();
const resultats: Array<[string, boolean]> = [];
function verifier(nom: string, condition: boolean, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

const aEffacer: string[] = [];

/*
 * Un récit qui contient `</script>` et des chevrons : c'est le contenu qui
 * casse un fichier autonome, et c'est exactement celui qu'une famille
 * finira par écrire — un carnet, une balise recopiée, un bout de code.
 */
const PIEGE = 'Il avait écrit </script> et <b>ceci</b> sur le carnet, en grand.';
const CANARI = `canari${randomBytes(4).toString('hex')}`;

try {
  // ── 1. Une famille, et son coffre ──────────────────────────────────────
  const famille = await prisma.family.create({ data: { name: `Coffre ${randomBytes(3).toString('hex')}` } });
  aEffacer.push(famille.id);
  const membre = await prisma.member.create({
    data: { familyId: famille.id, name: 'Témoin Coffre', generation: 2 },
  });
  const parent = await prisma.story.create({
    data: {
      familyId: famille.id,
      authorId: membre.id,
      title: `La montre ${CANARI}`,
      content: PIEGE,
      searchText: `la montre ${CANARI}`,
      structureType: 'evenement-marquant',
      tone: 'factuel',
      length: 'standard',
      eventDate: new Date(1971, 2, 3),
    },
  });
  const enfant = await prisma.story.create({
    data: {
      familyId: famille.id,
      authorId: membre.id,
      title: `Ce qu’elle a fait naître ${CANARI}`,
      content: 'Un second récit, né du premier.',
      searchText: 'ce quelle a fait naitre',
      structureType: 'evenement-marquant',
      tone: 'factuel',
      length: 'standard',
    },
  });
  await prisma.passage.create({
    data: {
      familyId: famille.id,
      parentStoryId: parent.id,
      childStoryId: enfant.id,
      triggerType: 'manual',
      latencyDays: 0,
    },
  });

  const cookie = `family_token=${famille.id}.1.${sign(`${famille.id}:1`)}; member_token=${membre.id}.verified.${sign(`${membre.id}.verified`)}`;
  const reponse = await fetch(`${BASE}/api/family/${famille.id}/coffre`, {
    headers: { Cookie: cookie, 'X-Real-IP': `192.0.2.${Math.floor(Math.random() * 250) + 1}` },
  });
  const html = await reponse.text();

  verifier(
    'l’application sert bien un coffre',
    reponse.status === 200 && html.startsWith('<!doctype html>'),
    `HTTP ${reponse.status}, ${html.length} octets`,
  );

  const dossier = mkdtempSync(join(tmpdir(), 'coffre-'));
  const fichier = join(dossier, 'memoire.html');
  writeFileSync(fichier, html, 'utf8');
  console.log(`  → ${fichier} (${Math.round(statSync(fichier).size / 1024)} Ko)\n`);

  // ── 2. On l'ouvre SANS l'application ───────────────────────────────────
  const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const contexte = await nav.newContext();

  /*
   * Toute requête qui n'est pas `file:` échoue, et on la compte. C'est plus
   * dur qu'une coupure réseau : ici il n'y a AUCUN serveur derrière, et la
   * moindre police, image ou feuille de style distante se voit.
   */
  const sorties: string[] = [];
  await contexte.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file:')) return route.continue();
    sorties.push(url);
    return route.abort();
  });

  const page = await contexte.newPage();
  const erreurs: string[] = [];
  page.on('pageerror', (e) => erreurs.push(e.message));
  await page.goto(`file://${fichier}`);

  verifier(
    'le fichier n’émet AUCUNE requête vers l’extérieur',
    sorties.length === 0,
    sorties.length === 0 ? 'aucune sortie réseau' : `${sorties.length} : ${sorties.slice(0, 3).join(', ')}`,
  );

  verifier('et il ne lève aucune erreur', erreurs.length === 0, erreurs.join(' · ') || 'aucune');

  // ── 3. Ce qui est réellement RENDU, pas ce qui est dans les octets ─────
  const texteVu = await page.evaluate(() => document.body.innerText);

  verifier(
    'les récits sont lisibles à l’écran, application éteinte',
    texteVu.includes(`La montre ${CANARI}`) && texteVu.includes(`Ce qu’elle a fait naître ${CANARI}`),
    `${texteVu.length} caractères rendus`,
  );

  verifier(
    'la filiation est visible — ce qu’aucun autre livre de famille ne montre (§5.2 ter)',
    texteVu.includes('Ce récit en a fait naître'),
  );

  verifier(
    'le récit piégé s’affiche comme du TEXTE, sans être interprété',
    texteVu.includes('</script>') && texteVu.includes('<b>ceci</b>'),
    'les chevrons sont des caractères, pas des balises',
  );

  // ── 4. Le JSON embarqué se relit, et se RÉIMPORTE ──────────────────────
  const brut = await page.evaluate(() => document.getElementById('heritage-donnees')?.textContent ?? '');
  let charge: { format?: string; donnees?: unknown } = {};
  let lisible = true;
  try {
    charge = JSON.parse(brut);
  } catch {
    lisible = false;
  }

  verifier(
    'un programme retrouve les données dans le fichier',
    lisible && typeof charge.format === 'string',
    lisible ? `format ${charge.format}` : 'JSON illisible — le fichier est tronqué',
  );

  /*
   * Le contrôle qui compte. Un fichier qu'on lit mais dont on ne peut rien
   * refaire n'affranchit de rien : c'est une photographie de la mémoire,
   * pas la mémoire. On la remet donc dans une application NEUVE.
   */
  const restaure = await new ImportService(prisma).importFamily(charge.donnees);
  if ('error' in restaure) {
    verifier('la mémoire du coffre se remet dans une application neuve', false, restaure.error);
  } else {
    aEffacer.push(restaure.familyId);
    const recitsRestaures = await prisma.story.findMany({
      where: { familyId: restaure.familyId },
      select: { title: true, content: true },
    });
    verifier(
      'la mémoire du coffre se remet dans une application neuve',
      recitsRestaures.length === 2,
      `${recitsRestaures.length} récits restaurés`,
    );
    verifier(
      'et le récit piégé revient intact, caractère pour caractère',
      recitsRestaures.some((r) => r.content === PIEGE),
      'y compris le « </script> » qui aurait tronqué le fichier',
    );
  }

  // ── 5. Le papier, qui dure plus que tout le reste ──────────────────────
  const pdf = join(dossier, 'memoire.pdf');
  await page.pdf({ path: pdf, format: 'A4' });
  const octets = statSync(pdf).size;
  verifier(
    'il s’imprime — un PDF sort du fichier seul, sans serveur',
    octets > 5_000,
    `${Math.round(octets / 1024)} Ko`,
  );
  console.log(`  → ${pdf}`);

  await nav.close();
} finally {
  for (const id of aEffacer) {
    const chez = { where: { familyId: id } };
    await prisma.visibilityLog.deleteMany(chez);
    await prisma.suspensionRequest.deleteMany(chez);
    await prisma.reserve.deleteMany(chez);
    await prisma.storyMute.deleteMany(chez);
    await prisma.transcriptionDraft.deleteMany(chez);
    await prisma.messageMark.deleteMany({ where: { message: { familyId: id } } });
    await prisma.message.deleteMany(chez);
    await prisma.thread.deleteMany(chez);
    await prisma.passage.deleteMany(chez);
    await prisma.archive.deleteMany(chez);
    await prisma.tradition.deleteMany(chez);
    await prisma.story.deleteMany(chez);
    await prisma.entity.deleteMany(chez);
    await prisma.member.deleteMany(chez);
    await prisma.family.delete({ where: { id } });
  }
  await prisma.$disconnect();
  console.log('\n· Familles de contrôle effacées.');
}

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
