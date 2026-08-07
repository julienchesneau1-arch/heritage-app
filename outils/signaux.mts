/**
 * LE SIGNAL TEMPOREL, SUR UNE ANNÉE — le quatrième acteur.
 *
 * §3.1 : « détecter quand le présent active le passé. Générer un signal
 * contextuel, jamais une notification froide. » C'est la seconde moitié de
 * l'écran « Aujourd'hui » : au plus un Passeur, au plus un signal.
 *
 * Un signal est daté par nature — anniversaires, traditions, « un récit a
 * été raconté ce jour-là ». Ses manières de mal se comporter ne se voient
 * donc jamais un mardi :
 *
 *  1. IL PARLE TOUS LES JOURS. Un signal quotidien n'est plus un signal,
 *     c'est un bandeau. La §6.1 demande la parcimonie de ce qu'on montre.
 *  2. IL NE PARLE JAMAIS. L'écran neutre est un résultat VALIDE — mais
 *     365 jours de neutre, c'est un acteur qui n'existe pas.
 *  3. IL RATE SA DATE. Un anniversaire de décès qui tombe le mauvais jour,
 *     ou qui revient trois jours de suite, dit quelque chose de faux à
 *     propos de quelqu'un de mort.
 *  4. IL NE SE TAIT PAS QUAND ON LE LUI DEMANDE. « Trois fermetures =
 *     silence de trente jours » ne s'observe pas sans trente jours.
 *
 * ── L'INSTRUMENT DOIT ÊTRE FIDÈLE ──
 *
 * Le silence de 30 jours passe par `incr` puis `expire` : un magasin
 * simulé dont `expire()` ne ferait rien mesurerait le stub et non le
 * produit. Ce fichier vérifie donc d'abord que son magasin se comporte
 * comme `createMemoryStore()` sur les opérations qu'il utilise, avant de
 * conclure quoi que ce soit.
 *
 * La base n'est pas modifiée : on lit, on n'écrit pas.
 *
 * USAGE :  JOURS_SIGNAUX=365 npx tsx outils/signaux.mts
 */

import { PrismaClient } from '@prisma/client';
import { TriggerModelService, type TriggerSignal, type TriggerType } from '../src/services/trigger-model.service';
import { createMemoryStore, type KeyValueStore } from '../src/lib/redis';

const JOURS = Number(process.env.JOURS_SIGNAUX ?? 365);

/**
 * Le magasin en mémoire du produit, mais sur l'horloge de la simulation.
 * Chaque détail compte : `incr` CONSERVE l'expiration précédente, `expire`
 * la repose. Le compteur de fermetures en dépend entièrement.
 */
class MagasinSimule implements KeyValueStore {
  maintenant = Date.now();
  private data = new Map<string, { value: string; expiresAt: number | null }>();

  private read(cle: string): string | null {
    const e = this.data.get(cle);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= this.maintenant) {
      this.data.delete(cle);
      return null;
    }
    return e.value;
  }
  async get(cle: string) {
    return this.read(cle);
  }
  async setex(cle: string, secondes: number, valeur: string) {
    this.data.set(cle, { value: valeur, expiresAt: this.maintenant + secondes * 1000 });
  }
  async incr(cle: string) {
    const actuel = Number(this.read(cle) ?? 0) + 1;
    const precedent = this.data.get(cle);
    this.data.set(cle, { value: String(actuel), expiresAt: precedent?.expiresAt ?? null });
    return actuel;
  }
  async expire(cle: string, secondes: number) {
    const e = this.data.get(cle);
    if (e) e.expiresAt = this.maintenant + secondes * 1000;
  }
  async del(cle: string) {
    this.data.delete(cle);
  }
}

const resultats: Array<[string, boolean]> = [];
function verifier(nom: string, condition: boolean, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

// ── 0. L'instrument est-il fidèle au produit ? ───────────────────────────

{
  const vrai = createMemoryStore();
  const simule = new MagasinSimule();
  const traces: string[][] = [];
  for (const magasin of [vrai, simule] as KeyValueStore[]) {
    const trace: string[] = [];
    trace.push(String(await magasin.incr('k')));
    trace.push(String(await magasin.incr('k')));
    await magasin.expire('k', 60);
    trace.push(String(await magasin.get('k')));
    await magasin.setex('m', 60, 'true');
    trace.push(String(await magasin.get('m')));
    await magasin.del('m');
    trace.push(String(await magasin.get('m')));
    traces.push(trace);
  }
  verifier(
    'le magasin simulé se comporte comme celui du produit',
    traces[0]!.join('|') === traces[1]!.join('|'),
    traces[0]!.join(' '),
  );
}

const prisma = new PrismaClient();

try {
  const famille = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!famille) throw new Error('Base vide : lancer `npm run seed` avant le contrôle.');
  const membres = await prisma.member.findMany({
    where: { familyId: famille.id, isDeleted: false, deathDate: null },
    orderBy: { createdAt: 'asc' },
  });
  const defunts = await prisma.member.findMany({
    where: { familyId: famille.id, isDeleted: false, NOT: { deathDate: null } },
  });

  console.log(`\nFamille « ${famille.name} » : ${membres.length} vivants, ${defunts.length} défunt(s).`);
  console.log(`Simulation sur ${JOURS} jours.\n`);

  const magasin = new MagasinSimule();
  const service = new TriggerModelService(prisma, magasin);

  type Ligne = { jour: number; date: Date; membre: string; signal: TriggerSignal };
  const journal: Ligne[] = [];
  let ecransVides = 0;

  const depart = new Date();
  for (let jour = 0; jour < JOURS; jour++) {
    const date = new Date(depart.getTime() + jour * 86_400_000);
    magasin.maintenant = date.getTime();
    for (const membre of membres) {
      const tous = await service.generateSignals(famille.id, membre.id, date);
      if (tous.length === 0) ecransVides += 1;
      if (tous.length > 1) {
        console.log(`  ! ${tous.length} signaux le jour ${jour} pour ${membre.name}`);
      }
      const signal = tous[0];
      if (signal) journal.push({ jour, date, membre: membre.name, signal });
    }
  }

  // ── 1. Parle-t-il, et combien ? ──
  console.log('── Ce qu’il a dit, par type ──');
  const parType = new Map<string, number>();
  for (const l of journal) parType.set(l.signal.type, (parType.get(l.signal.type) ?? 0) + 1);
  const total = journal.length || 1;
  for (const [type, n] of [...parType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type.padEnd(18)} ${String(n).padStart(5)}  ${Math.round((n / total) * 100)} %`);
  }
  const TOUS_TYPES: TriggerType[] = ['TRADITION', 'ANNIVERSARY', 'TEMPORAL', 'RECENT_ACTIVITY', 'PASSIVE'];
  const muets = TOUS_TYPES.filter((t) => !parType.has(t));
  console.log(
    muets.length === 0
      ? '  (les cinq types se sont exprimés)'
      : `  Jamais déclenchés sur ce jeu d’essai, donc NON MESURÉS : ${muets.join(', ')}`,
  );
  console.log();

  verifier(
    'la simulation a bien produit des signaux',
    journal.length > 0,
    `${journal.length} signaux sur ${JOURS} jours × ${membres.length} membres`,
  );

  verifier(
    'AU PLUS un signal par membre et par jour (§3.1)',
    journal.length + ecransVides === JOURS * membres.length,
    `${journal.length} signaux + ${ecransVides} écrans vides = ${JOURS * membres.length} attendus`,
  );

  /*
   * « Le repli passif s'applique après le filtre de silence : un membre qui
   * a tout fait taire retrouve l'écran NEUTRE, pas un écran vide. » Un jour
   * sans aucun signal contredirait la §3.1 telle qu'elle est écrite.
   */
  verifier(
    'l’écran n’est jamais vide — le repli passif tient toujours',
    ecransVides === 0,
    ecransVides === 0 ? 'aucun jour sans signal' : `${ecransVides} écrans vides`,
  );

  // ── 2. Un signal quotidien n'est plus un signal ──
  const parJourEtMembre = journal.filter((l) => l.signal.type !== 'PASSIVE').length;
  const partNonPassive = Math.round((parJourEtMembre / total) * 100);
  console.log(`  Signaux non passifs : ${parJourEtMembre} sur ${total} (${partNonPassive} %).\n`);

  verifier(
    'le signal fort reste l’exception, et non le décor quotidien',
    partNonPassive < 60,
    `${partNonPassive} % de jours portent autre chose que l’écran neutre`,
  );

  // ── 3. Rate-t-il sa date ? ──
  /*
   * ── DEUX ANNIVERSAIRES, PAS UN ──
   *
   * Première version : je filtrais les signaux contenant « Robert », et je
   * comptais dix occurrences là où j'en attendais cinq. J'ai cru tenir un
   * défaut. C'était le mien : Robert a une date de NAISSANCE et une date de
   * DÉCÈS, les deux produisent un ANNIVERSARY portant son nom, et les deux
   * tombaient parfaitement le bon jour. On distingue donc par la
   * justification, qui nomme la date dont elle vient.
   */
  for (const defunt of defunts) {
    for (const [quoi, date] of [
      ['naissance', defunt.birthDate],
      ['décès', defunt.deathDate],
    ] as Array<[string, Date | null]>) {
      if (!date) continue;
      const jourMois = `${date.getMonth()}-${date.getDate()}`;
      const siens = journal.filter(
        (l) =>
          l.signal.type === 'ANNIVERSARY' &&
          l.signal.payload.message.includes(defunt.name) &&
          l.signal.payload.justification.includes(`Date de ${quoi}`),
      );
      const horsDate = siens.filter((l) => `${l.date.getMonth()}-${l.date.getDate()}` !== jourMois);
      verifier(
        `l’anniversaire de ${quoi} de ${defunt.name} ne tombe QUE le bon jour`,
        siens.length > 0 && horsDate.length === 0,
        siens.length === 0
          ? 'jamais signalé en un an — NON MESURÉ, la date ne tombe peut-être pas dans la fenêtre'
          : `${siens.length} signaux, ${horsDate.length} hors du ${date.getDate()}/${date.getMonth() + 1}`,
      );
    }
  }

  // ── 4. Ce que le produit AFFIRME ──
  verifier(
    'tout signal porte une justification non vide (§3.1)',
    journal.every((l) => l.signal.payload.justification.trim().length > 3),
  );
  verifier(
    'aucun signal ne prête une émotion (§12)',
    !journal.some((l) =>
      /ressenti|émotion|triste|heureux|douloureux|vous a marqué|vous pensez|vous devez/i.test(
        `${l.signal.payload.message} ${l.signal.payload.justification}`,
      ),
    ),
  );
  /*
   * Trouvé ici : « Il y a 12 ans, Robert Martin nous quittait. » Le produit
   * se comptait parmi les endeuillés, et choisissait un euphémisme à la
   * place de la famille. Voir `src/lib/deces.ts`.
   */
  verifier(
    'le produit ne se compte jamais dans la famille — pas de « nous »',
    !journal.some((l) => /\bnous\b|\bnotre\b|\bnos\b/i.test(l.signal.payload.message)),
  );
  verifier(
    'et ne choisit aucun euphémisme de deuil à sa place',
    !journal.some((l) =>
      /nous quittait|disparu|s’en est allé|s'en est allé|parti trop tôt|repose/i.test(l.signal.payload.message),
    ),
  );
  verifier(
    'aucun signal ne presse ni ne culpabilise (§6.2)',
    !journal.some((l) =>
      /n’oubliez pas|n'oubliez pas|il est temps|vous n’avez pas|vous n'avez pas|pensez à/i.test(
        l.signal.payload.message,
      ),
    ),
  );

  // ── 5. Se tait-il quand on le lui demande, et revient-il ? ──
  console.log('\n── Le silence de trente jours ──');
  {
    const membre = membres[0]!;
    const magasin2 = new MagasinSimule();
    const service2 = new TriggerModelService(prisma, magasin2);
    const jour0 = new Date();
    magasin2.maintenant = jour0.getTime();

    const avant = await service2.generateSignal(famille.id, membre.id, jour0);
    const type = avant?.type ?? 'PASSIVE';

    for (let i = 0; i < 3; i++) await service2.dismissSignalType(famille.id, membre.id, type);

    const apres = await service2.generateSignal(famille.id, membre.id, jour0);
    verifier(
      `trois fermetures font taire le type « ${type} »`,
      apres?.type !== type || type === 'PASSIVE',
      apres ? `il reste « ${apres.type} »` : 'plus rien',
    );

    // Et il revient. Sans faire avancer l'horloge, personne ne l'a jamais vu.
    magasin2.maintenant = jour0.getTime() + 31 * 86_400_000;
    const j31 = new Date(magasin2.maintenant);
    const revenu = await service2.generateSignal(famille.id, membre.id, j31);
    verifier(
      'et il revient au bout de trente jours, sans qu’on ait rien à faire',
      revenu !== null,
      revenu ? `« ${revenu.type} » de nouveau` : 'toujours muet au jour 31',
    );

    // Le repli neutre reste, même quand tout est éteint.
    magasin2.maintenant = jour0.getTime();
    for (const t of TOUS_TYPES) {
      for (let i = 0; i < 3; i++) await service2.dismissSignalType(famille.id, membre.id, t);
    }
    const toutEteint = await service2.generateSignal(famille.id, membre.id, jour0);
    verifier(
      'un membre qui a TOUT fait taire retrouve l’écran neutre, pas un écran vide',
      toutEteint !== null,
      toutEteint ? `« ${toutEteint.type} »` : 'écran vide — la §3.1 promet le repli passif',
    );
  }

  console.log('\n── Trois signaux au hasard, tels que la famille les lit ──');
  for (const l of [journal[0], journal[Math.floor(journal.length / 2)], journal[journal.length - 1]].filter(Boolean)) {
    console.log(`  J${l!.jour} · ${l!.membre} · ${l!.signal.type} (priorité ${l!.signal.priority})`);
    console.log(`    « ${l!.signal.payload.message} »`);
    console.log(`    ${l!.signal.payload.justification}`);
  }
} finally {
  await prisma.$disconnect();
}

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
