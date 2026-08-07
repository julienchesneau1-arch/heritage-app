/**
 * LE CONSERVATEUR — le gardien dont personne n'a vérifié qu'il était de garde.
 *
 * Sa mission, §3.2, mot pour mot : « garantir que rien ne devient
 * inaccessible par effet d'algorithme ». Et son seul mécanisme ACTIF — le
 * budget de visibilité — dit ceci :
 *
 *   « Aucune histoire ne dépasse le seuil des impressions sur 12 mois.
 *     Au-delà, elle sort des suggestions. »
 *
 * C'est une promesse de DURÉE. Elle a été testée règle par règle, jamais
 * dans le temps, et jamais sur un corpus où le seuil ait un sens.
 *
 * ── CE QU'ON CHERCHE ──
 *
 * `isOverexposed()` lit une clé du magasin. Cette clé n'a qu'un seul
 * écrivain : `checkOverexposure()`. Et `checkOverexposure()` n'est appelé
 * par aucun chemin du produit — sinon depuis `report()`, c'est-à-dire
 * quand quelqu'un ouvre la page Transmission ou appelle `/metrics`.
 *
 * Si c'est exact, le budget de visibilité de la Constitution n'est pas
 * appliqué par le produit : il est appliqué par l'habitude qu'aurait une
 * famille de visiter une page de statistiques. Une famille qui n'y va
 * jamais — c'est-à-dire la plupart — n'a pas de Conservateur.
 *
 * On ne l'affirme pas en lisant les appels : deux familles identiques,
 * mêmes récits, mêmes lectures, même hasard. Un seul écart : l'une ouvre
 * Transmission chaque jour, l'autre jamais. Si le Passeur ne se comporte
 * pas pareil, la démonstration est faite.
 *
 * ── POURQUOI LE JOURNAL EST ÉCRIT DIRECTEMENT ──
 *
 * `registerView()` ne prend pas de date : `shownAt` vient du défaut SQL et
 * `lastViewedAt` de `new Date()`. Le Passeur, lui, reçoit son horloge en
 * paramètre. Le Conservateur ne peut donc pas être joué dans le temps par
 * sa propre porte d'entrée — ce contrôle écrit les lignes du journal comme
 * `registerView` les écrirait, à une date choisie, et le dit plutôt que de
 * faire passer ça pour un appel de service.
 *
 * La famille fabriquée est effacée à la fin, quoi qu'il arrive.
 *
 * USAGE :  JOURS_CONSERVATEUR=60 npx tsx outils/conservateur.mts
 */

import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ConservateurService, overexposureThreshold } from '../src/services/conservateur.service';
import { PasseurService } from '../src/services/passeur.service';
import { LLMOperatorService } from '../src/services/llm-operator.service';
import { ThreadService } from '../src/services/thread.service';
import type { KeyValueStore } from '../src/lib/redis';

/*
 * Sa propre variable, et non `JOURS` : le lanceur pose `JOURS=180` pour le
 * Passeur, et cette campagne-ci est jouée DEUX FOIS. On ferait 360 jours
 * simulés pour établir ce que 120 établissent déjà — le seuil est franchi
 * dès le premier jour.
 */
const JOURS = Number(process.env.JOURS_CONSERVATEUR ?? 60);
const RECITS = Number(process.env.RECITS_CONSERVATEUR ?? 40);

/** Un magasin dont le temps est celui de la simulation. */
class MagasinSimule implements KeyValueStore {
  maintenant = Date.now();
  private entrees = new Map<string, { valeur: string; expire: number }>();

  async get(cle: string): Promise<string | null> {
    const e = this.entrees.get(cle);
    if (!e) return null;
    if (e.expire <= this.maintenant) {
      this.entrees.delete(cle);
      return null;
    }
    return e.valeur;
  }
  async setex(cle: string, secondes: number, valeur: string): Promise<void> {
    this.entrees.set(cle, { valeur, expire: this.maintenant + secondes * 1000 });
  }
  async incr(cle: string): Promise<number> {
    const actuel = Number((await this.get(cle)) ?? '0') + 1;
    await this.setex(cle, 86_400, String(actuel));
    return actuel;
  }
  async expire(): Promise<void> {}
  async del(cle: string): Promise<void> {
    this.entrees.delete(cle);
  }
}

const prisma = new PrismaClient();
const resultats: Array<[string, boolean]> = [];
function verifier(nom: string, condition: boolean, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

const familles: string[] = [];

/** Une famille de contrôle : des récits, des membres, une entité commune. */
async function fabriquer(nom: string) {
  const famille = await prisma.family.create({ data: { name: `${nom} ${randomBytes(3).toString('hex')}` } });
  familles.push(famille.id);

  const membres = [];
  for (let i = 0; i < 5; i++) {
    membres.push(
      await prisma.member.create({
        data: { familyId: famille.id, name: `Lecteur ${i + 1}`, generation: 2, birthDate: new Date(1960, 0, 1) },
      }),
    );
  }

  const entite = await prisma.entity.create({
    data: { familyId: famille.id, type: 'PERSON', name: 'La maison', normalizedName: 'la maison' },
  });

  const recits = [];
  for (let i = 0; i < RECITS; i++) {
    recits.push(
      await prisma.story.create({
        data: {
          familyId: famille.id,
          authorId: membres[i % membres.length]!.id,
          title: `Récit ${i + 1}`,
          // Une tension explicite : sans elle le Passeur n'a rien à dire,
          // et un Passeur muet ne prouverait rien sur les exclusions.
          content:
            `On en a parlé souvent. Il refusait d'expliquer pourquoi. ` +
            `Personne n'a jamais su ce qui s'était passé cette année-là. Récit ${i + 1}.`,
          searchText: `recit ${i + 1}`,
          structureType: 'evenement-marquant',
          tone: 'factuel',
          length: 'standard',
          createdAt: new Date(Date.now() - (i + 1) * 30 * 86_400_000),
          eventDate: new Date(1980 + (i % 30), i % 12, 1),
          linkedEntities: { connect: [{ id: entite.id }] },
        },
      }),
    );
  }

  return { famille, membres, recits };
}

/**
 * Une journée de lecture. La vedette capte l'essentiel de l'attention —
 * c'est le cas que le budget de visibilité existe pour traiter, et c'est
 * aussi ce que fait une vraie famille avec le récit qui l'a marquée.
 */
async function lire(
  familyId: string,
  membres: Array<{ id: string }>,
  recits: Array<{ id: string }>,
  vedette: { id: string },
  date: Date,
) {
  const lignes: Array<{ familyId: string; storyId: string; memberId: string; context: string; shownAt: Date }> = [];
  for (const membre of membres) {
    lignes.push({ familyId, storyId: vedette.id, memberId: membre.id, context: 'graph', shownAt: date });
    const autre = recits[Math.floor(Math.random() * recits.length)]!;
    lignes.push({ familyId, storyId: autre.id, memberId: membre.id, context: 'graph', shownAt: date });
  }
  await prisma.visibilityLog.createMany({ data: lignes });
  await prisma.story.update({ where: { id: vedette.id }, data: { lastViewedAt: date } });
}

try {
  console.log(`Deux familles de ${RECITS} récits, 5 lecteurs, ${JOURS} jours.`);
  console.log(`Seuil de sur-exposition à ${RECITS} récits : ${overexposureThreshold(RECITS).toFixed(2)} %.\n`);

  /**
   * Une campagne. `ouvreTransmission` est le SEUL écart entre les deux.
   */
  async function campagne(nom: string, ouvreTransmission: boolean) {
    const { famille, membres, recits } = await fabriquer(nom);
    const vedette = recits[0]!;

    const magasin = new MagasinSimule();
    const conservateur = new ConservateurService(prisma, magasin);
    const passeur = new PasseurService(
      prisma,
      magasin,
      new LLMOperatorService(undefined),
      conservateur,
      new ThreadService(prisma),
    );

    let signalee = 0;
    let proposeeApresSeuil = 0;
    let depassementAtteintLe: number | null = null;

    const depart = new Date();
    for (let jour = 0; jour < JOURS; jour++) {
      const date = new Date(depart.getTime() + jour * 86_400_000);
      magasin.maintenant = date.getTime();

      await lire(famille.id, membres, recits, vedette, date);

      // À partir de quand la vedette dépasse-t-elle réellement le seuil ?
      if (depassementAtteintLe === null) {
        const total = await prisma.visibilityLog.count({ where: { familyId: famille.id } });
        const sienne = await prisma.visibilityLog.count({
          where: { familyId: famille.id, storyId: vedette.id },
        });
        if (total > 0 && (sienne / total) * 100 > overexposureThreshold(recits.length)) {
          depassementAtteintLe = jour;
        }
      }

      // Le seul écart entre les deux campagnes.
      if (ouvreTransmission) await conservateur.report(famille.id, date);

      if (await conservateur.isOverexposed(vedette.id)) signalee += 1;

      // Le Passeur propose-t-il encore la vedette une fois le seuil franchi ?
      const question = await passeur.generateQuestion(famille.id, membres[0]!.id, date);
      if (depassementAtteintLe !== null && question?.storyId === vedette.id) proposeeApresSeuil += 1;
    }

    const total = await prisma.visibilityLog.count({ where: { familyId: famille.id } });
    const sienne = await prisma.visibilityLog.count({ where: { familyId: famille.id, storyId: vedette.id } });
    const part = total > 0 ? (sienne / total) * 100 : 0;

    return { famille, membres, magasin, conservateur, vedette, part, signalee, proposeeApresSeuil, depassementAtteintLe };
  }

  console.log('── A. La famille qui n’ouvre jamais la page Transmission ──');
  const a = await campagne('Conservateur sans Transmission', false);
  console.log(
    `  la vedette capte ${a.part.toFixed(1)} % des impressions` +
      ` · seuil franchi au jour ${a.depassementAtteintLe ?? '—'}` +
      ` · signalée sur-exposée ${a.signalee} jours sur ${JOURS}` +
      ` · encore proposée par le Passeur ${a.proposeeApresSeuil} fois après le seuil`,
  );

  console.log('\n── B. La même, mais quelqu’un ouvre Transmission chaque jour ──');
  const b = await campagne('Conservateur avec Transmission', true);
  console.log(
    `  la vedette capte ${b.part.toFixed(1)} % des impressions` +
      ` · seuil franchi au jour ${b.depassementAtteintLe ?? '—'}` +
      ` · signalée sur-exposée ${b.signalee} jours sur ${JOURS}` +
      ` · encore proposée par le Passeur ${b.proposeeApresSeuil} fois après le seuil`,
  );

  console.log('\n── Ce que cela établit ──');

  // D'abord : a-t-on seulement fabriqué une sur-exposition ?
  verifier(
    'les deux campagnes ont bien produit un récit au-delà du seuil',
    a.depassementAtteintLe !== null && b.depassementAtteintLe !== null,
    `A : jour ${a.depassementAtteintLe ?? '—'} · B : jour ${b.depassementAtteintLe ?? '—'}`,
  );

  verifier(
    'chez la famille qui ouvre Transmission, le récit sur-exposé EST signalé',
    b.signalee > 0,
    `${b.signalee} jours sur ${JOURS}`,
  );

  /*
   * Le contrôle central. S'il échoue, le budget de visibilité de la §3.2
   * n'est pas une garantie du produit : c'est un effet de bord d'une
   * visite de page.
   */
  verifier(
    'le budget de visibilité s’applique SANS qu’on ouvre la page Transmission',
    a.signalee > 0,
    a.signalee > 0
      ? `${a.signalee} jours sur ${JOURS}`
      : `jamais signalé en ${JOURS} jours, alors que la vedette capte ${a.part.toFixed(1)} % ` +
        `pour un seuil de ${overexposureThreshold(RECITS).toFixed(2)} %`,
  );

  /*
   * ── LE REDÉMARRAGE ──
   *
   * En production `REDIS_URL` est absent : le magasin vit dans la mémoire
   * du processus, et un redéploiement efface tous les signalements. Exiger
   * qu'ils SURVIVENT serait exiger Redis, que la §7 écarte volontairement
   * pour une instance unique.
   *
   * La bonne question n'est donc pas « le drapeau survit-il » mais « se
   * repose-t-il tout seul » : un conteneur qui vient de démarrer, personne
   * n'ouvre Transmission, et la première question posée doit suffire à
   * rétablir le budget.
   */
  const magasinNeuf = new MagasinSimule();
  const conservateurNeuf = new ConservateurService(prisma, magasinNeuf);
  verifier(
    'après un redémarrage, rien n’est signalé tant que rien ne l’a demandé',
    !(await conservateurNeuf.isOverexposed(b.vedette.id)),
    'le magasin est vide, c’est attendu',
  );

  const passeurNeuf = new PasseurService(
    prisma,
    magasinNeuf,
    new LLMOperatorService(undefined),
    conservateurNeuf,
    new ThreadService(prisma),
  );
  await passeurNeuf.generateQuestion(b.famille.id, b.membres[0]!.id, new Date());
  verifier(
    'et une seule question suffit à rétablir le budget, sans page Transmission',
    await conservateurNeuf.isOverexposed(b.vedette.id),
    'le Conservateur recalcule quand on a besoin de son verdict',
  );

  // Ce que le Conservateur mesure sans corriger, lui, doit rester mesuré.
  const rapport = await b.conservateur.report(b.famille.id);
  verifier(
    'la distorsion reste MESURÉE et non corrigée (amendement 5)',
    rapport.distortionScore !== null && rapport.impressions > 0,
    `distorsion ${rapport.distortionScore}, ${rapport.impressions} impressions`,
  );
  verifier(
    'et « 0 récit sur-exposé » n’est jamais rendu sans impressions',
    rapport.overexposedStories !== null,
    `${rapport.overexposedStories} sur-exposé(s) sur ${rapport.totalStories} récits`,
  );
} finally {
  for (const id of familles) {
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
