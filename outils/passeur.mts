/**
 * LE PASSEUR, SUR SIX MOIS — l'acteur que personne n'a regardé durer.
 *
 * C'est la seule chose que la famille rencontre TOUS LES JOURS : au plus une
 * question sur l'écran « Aujourd'hui » (§5.1). Il a été testé règle par
 * règle, et jamais dans la durée. Or ses trois manières de mal vieillir sont
 * silencieuses — aucune ne lève d'erreur, aucune ne casse un test :
 *
 *  1. IL SE TARIT. Au bout de N jours, il n'a plus rien à demander et
 *     l'écran d'accueil devient vide pour toujours. Un accueil vide est un
 *     résultat VALIDE (§5.1 : « si les deux manquent, il ne reste que le nom
 *     de la famille »), mais vide dès le cinquième jour, c'est un produit
 *     mort. Personne n'avait jamais compté.
 *  2. IL SE RÉPÈTE. Le délai de 14 jours porte sur une paire (sujet, règle)
 *     et par membre. Rien ne garantit qu'il tourne : il peut marteler le
 *     même récit sous cinq règles différentes.
 *  3. UNE RÈGLE MANGE LES AUTRES. La sélection se fait par confiance × poids.
 *     Si `UNANSWERED_QUESTION` gagne toujours, les quatre autres n'existent
 *     que sur le papier.
 *
 * ── COMMENT ON FAIT AVANCER LE TEMPS ──
 *
 * Le service prend son horloge en paramètre et son magasin en injection. On
 * lui fournit donc un magasin dont les expirations suivent une horloge
 * SIMULÉE : sans cela, la parcimonie « une question par heure » bloquerait
 * tout après le premier appel, et le délai de 14 jours ne s'écoulerait
 * jamais. Rien n'est modifié dans le produit pour ce contrôle.
 *
 * La base n'est pas touchée : on lit, on ne écrit pas.
 *
 * USAGE :   JOURS=180 npx tsx outils/passeur.mts
 */

import { PrismaClient } from '@prisma/client';
import { PasseurService, PASSEUR_RULES, subjectOf } from '../src/services/passeur.service';
import type { KeyValueStore } from '../src/lib/redis';

const JOURS = Number(process.env.JOURS ?? 180);

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
const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!famille) throw new Error('Base vide : lancer `npm run seed` avant le contrôle.');
const membres = await prisma.member.findMany({
  where: { familyId: famille.id, isDeleted: false },
  orderBy: { createdAt: 'asc' },
});
const recits = await prisma.story.count({ where: { familyId: famille.id } });

const resultats: Array<[string, boolean]> = [];
function verifier(nom: string, condition: boolean, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

console.log(`Famille « ${famille.name} » : ${membres.length} membres, ${recits} récits.`);
console.log(`Simulation sur ${JOURS} jours.\n`);

const magasin = new MagasinSimule();
const passeur = new PasseurService(prisma, magasin);

type Journal = { jour: number; membre: string; regle: string; sujet: string; justification: string; texte: string };
const journal: Journal[] = [];
const silences = new Map<string, number>();
const silenceMax = new Map<string, number>();

const depart = new Date();
for (let jour = 0; jour < JOURS; jour++) {
  const date = new Date(depart.getTime() + jour * 86_400_000);
  magasin.maintenant = date.getTime();

  for (const membre of membres) {
    const question = await passeur.generateQuestion(famille.id, membre.id, date);
    if (!question) {
      const n = (silences.get(membre.id) ?? 0) + 1;
      silences.set(membre.id, n);
      silenceMax.set(membre.id, Math.max(silenceMax.get(membre.id) ?? 0, n));
      continue;
    }
    silences.set(membre.id, 0);
    journal.push({
      jour,
      membre: membre.name,
      regle: question.ruleId,
      sujet: subjectOf(question),
      justification: question.justification,
      texte: question.text,
    });
  }
}

await prisma.$disconnect();

// ── 1. Se tarit-il ? ──
console.log('── Ce qu’il a dit, par membre ──');
for (const membre of membres) {
  const siennes = journal.filter((l) => l.membre === membre.name);
  console.log(
    `  ${membre.name.padEnd(16)} ${String(siennes.length).padStart(3)} questions sur ${JOURS} jours` +
      ` · plus long silence : ${silenceMax.get(membre.id) ?? JOURS} jours`,
  );
}
console.log();

/*
 * ── LA BONNE POPULATION ──
 *
 * Ces deux contrôles portaient sur TOUS les membres. Après la correction du
 * Passeur, ils sont passés au rouge sur le défunt : 0 question, 180 jours de
 * silence. C'est le comportement voulu, et mes contrôles le comptaient comme
 * une panne — la même erreur que celle qu'ils venaient de trouver, à
 * l'envers. Un mort est silencieux par construction ; le mesurer revient à
 * chronométrer un comptage sur zéro ligne.
 */
const vivants = membres.filter((m) => m.deathDate === null);

verifier(
  'le Passeur a quelque chose à dire au moins une fois par membre vivant',
  vivants.every((m) => journal.some((l) => l.membre === m.name)),
  `${vivants.length} vivants sur ${membres.length}`,
);

const silenceLePlusLong = Math.max(...vivants.map((m) => silenceMax.get(m.id) ?? JOURS));
verifier(
  'aucun vivant ne reste plus de 60 jours sans une seule question',
  silenceLePlusLong <= 60,
  `${silenceLePlusLong} jours pour le plus mal servi`,
);

// ── 2. Se répète-t-il ? ──
const collisions = journal.filter((ligne, i) =>
  journal.some(
    (autre, j) =>
      j < i &&
      autre.membre === ligne.membre &&
      autre.sujet === ligne.sujet &&
      autre.regle === ligne.regle &&
      ligne.jour - autre.jour < 14,
  ),
);
verifier(
  'la même paire (sujet, règle) ne revient jamais avant 14 jours',
  collisions.length === 0,
  collisions.length === 0 ? 'délai respecté' : `${collisions.length} répétitions`,
);

// Deux jours de suite le même récit, sous une règle différente : le délai
// est respecté à la lettre, et l'effet ressenti est celui du martèlement.
const martelage = journal.filter((ligne, i) =>
  journal.some(
    (autre, j) =>
      j < i && autre.membre === ligne.membre && autre.sujet === ligne.sujet && ligne.jour - autre.jour <= 1,
  ),
);
verifier(
  'et le même SUJET ne revient pas deux jours d’affilée, fût-ce sous une autre règle',
  martelage.length === 0,
  martelage.length === 0 ? 'aucun martèlement' : `${martelage.length} fois`,
);

// ── 3. Une règle mange-t-elle les autres ? ──
console.log('\n── Quelles règles ont parlé ──');
const parRegle = new Map<string, number>();
for (const ligne of journal) parRegle.set(ligne.regle, (parRegle.get(ligne.regle) ?? 0) + 1);
const total = journal.length || 1;
for (const [regle, n] of [...parRegle.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${regle.padEnd(22)} ${String(n).padStart(4)}  ${Math.round((n / total) * 100)} %`);
}

/*
 * ── LES MUETTES SE NOMMENT ──
 *
 * Un tableau qui ne liste que ce qui a parlé laisse croire que tout a
 * parlé. Une règle absente de ce jeu d'essai n'est pas une règle en panne —
 * `RARE_PATRIMONY` cherche un patrimoine ancien, et les récits semés sont
 * trop récents — mais c'est une règle NON MESURÉE, et la différence est
 * tout l'objet de ce dossier. On l'écrit plutôt que de la laisser se
 * confondre avec un contrôle réussi.
 */
/*
 * `UNANSWERED_QUESTION` n'est PAS dans `PASSEUR_RULES` : c'est un chemin
 * qui passe avant elles — une question qu'un humain a réellement posée
 * l'emporte sur toute règle déduite d'un texte. Prendre `PASSEUR_RULES`
 * pour l'ensemble des sources donnait « 4 règles sur 4 » alors qu'une
 * cinquième n'avait rien dit : un dénominateur qui se rétrécit à la taille
 * de ce qu'on a mesuré, soit exactement le défaut que ce dépôt poursuit.
 */
const SOURCES = [...PASSEUR_RULES.map((r) => r.id), 'UNANSWERED_QUESTION'];
const muettes = SOURCES.filter((id) => !parRegle.has(id));
console.log(
  muettes.length === 0
    ? `  (les ${SOURCES.length} sources de question se sont exprimées)`
    : `  Jamais déclenchées sur ce jeu d’essai, donc NON MESURÉES : ${muettes.join(', ')}`,
);
console.log();

verifier(
  'au moins deux règles différentes se sont exprimées',
  parRegle.size >= 2,
  `${parRegle.size} règles sur ${SOURCES.length}`,
);
const dominante = Math.max(...parRegle.values());
verifier(
  'aucune règle n’accapare la totalité des questions',
  dominante < total,
  `la plus fréquente pèse ${Math.round((dominante / total) * 100)} %`,
);

// ── 4. Ce que le produit AFFIRME ──
verifier(
  'toute question porte une justification non vide (§6.2)',
  journal.every((l) => l.justification.trim().length > 10),
);
verifier(
  'aucune justification ne compare ce récit aux autres',
  !journal.some((l) => /les moins|le plus|davantage que|moins que les/i.test(l.justification)),
);
verifier(
  'aucune question ne prête une émotion (§12)',
  !journal.some((l) => /ressenti|émotion|triste|heureux|douloureux|vous a marqué/i.test(l.texte)),
);

// ── 5. Et la doctrine de la mort tient-elle ici aussi ? ──
const defunts = membres.filter((m) => m.deathDate !== null).map((m) => m.name);
if (defunts.length > 0) {
  verifier(
    'aucune question n’est POSÉE à quelqu’un qui est mort',
    !journal.some((l) => defunts.includes(l.membre)),
    `défunts : ${defunts.join(', ')}`,
  );
  verifier(
    'et aucune ne réclame le point de vue d’un mort',
    !journal.some((l) => defunts.some((d) => l.texte.includes(d.split(' ')[0]!) && l.regle === 'MISSING_VIEWPOINT')),
  );
}

// ── 6. Le contrôle vérifie-t-il quelque chose ? ──
verifier(
  'la simulation a bien produit des questions',
  journal.length > 0,
  `${journal.length} questions au total`,
);

console.log('\n── Trois questions au hasard, telles que la famille les lit ──');
for (const ligne of [journal[0], journal[Math.floor(journal.length / 2)], journal[journal.length - 1]].filter(Boolean)) {
  console.log(`  J${ligne!.jour} · ${ligne!.membre} · ${ligne!.regle}`);
  console.log(`    « ${ligne!.texte} »`);
  console.log(`    ${ligne!.justification}`);
}

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
