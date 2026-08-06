/**
 * L'OUBLI EST UN DROIT — et c'est la seule règle que la Constitution
 * qualifie d'ABSOLUE.
 *
 *   « Oubli = droit : archivage, silence, suppression sont des décisions
 *     familiales absolues. » — Annexe A, point 6
 *
 * Le produit a maintenant HUIT manières de retirer quelque chose, ajoutées
 * une par une, chacune sur plusieurs mois : `archived`, `quarantined`,
 * `suspendedAt`, `StoryMute`, `Reserve`, `Member.isDeleted`,
 * `calendarOptOut`, et la suppression pure. Chacune a été écrite avec ses
 * tests, à l'endroit où elle a été écrite.
 *
 * Personne n'a jamais fait l'inverse : énumérer toutes les SORTIES du
 * produit — les pages, les routes, le livre, le calendrier, l'export, la
 * recherche, le graphe — et les confronter à chaque mécanisme. C'est
 * exactement l'angle mort qu'avait le Passeur : un invariant qui tient là
 * où on l'a regardé, et dont personne ne sait s'il tient ailleurs.
 *
 * Un retrait qui fuit ne lève aucune erreur. Il ne casse aucun test. Il
 * rend simplement, sur une seule page oubliée, ce que quelqu'un avait
 * demandé de ne plus voir — et cette page-là est celle qu'un membre de la
 * famille finira par ouvrir.
 *
 * ── COMMENT ON MESURE ──
 *
 * Chaque objet retiré porte un CANARI : un mot inventé, unique, introuvable
 * ailleurs dans le produit. On applique le retrait, puis on parcourt toutes
 * les sorties et on cherche les canaris dans les octets rendus — HTML,
 * charge React, JSON, `.ics`. Un canari trouvé là où il ne devrait pas
 * être est une fuite, sans interprétation possible.
 *
 * Le HTML brut, et non le texte visible : ce qui voyage dans la charge
 * React arrive dans le navigateur, qu'un composant l'affiche ou non.
 *
 * ── CE QUI EST ATTENDU, ET POURQUOI ──
 *
 * Les mécanismes ne promettent PAS la même chose, et un contrôle qui les
 * traiterait pareil serait faux dans les deux sens. Le tableau `ATTENDUS`
 * plus bas énonce chaque promesse, avec la ligne du produit qui la fonde.
 *
 * ── LE TÉMOIN ──
 *
 * Un récit sans aucun retrait porte lui aussi un canari, et il DOIT se
 * trouver partout. Sans lui, une page en 500 rendrait tous les contrôles
 * verts : on n'aurait pas prouvé que rien ne fuit, seulement qu'on n'a rien
 * regardé.
 *
 * La famille fabriquée est effacée à la fin, quoi qu'il arrive.
 *
 * USAGE :  BASE=http://localhost:3000 npx tsx outils/oubli.mts
 */

import { createHmac, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const SECRET = process.env.FAMILY_TOKEN_SECRET;
if (!SECRET) throw new Error('FAMILY_TOKEN_SECRET manquant.');
const sign = (p: string) => createHmac('sha256', SECRET).update(p).digest('hex');

const prisma = new PrismaClient();

/*
 * Une adresse par exécution : sinon la §8.2 fait échouer le second
 * lancement. Et une PLAGE distincte de celle de `etancheite.mjs`
 * (198.51.100.0/24) : les deux tiraient au hasard dans la même, si bien
 * qu'une collision faisait compter les 68 requêtes de ce fichier dans le
 * seau de l'autre. L'étanchéité mesurait alors 72 requêtes servies là où
 * la §8.2 en promet 100, et se déclarait en échec sans rien avoir de
 * cassé. Un outil ne doit pas pouvoir en faire échouer un autre.
 */
const ENTETES = { 'X-Real-IP': `203.0.113.${Math.floor(Math.random() * 250) + 1}` };

const resultats: Array<[string, boolean]> = [];
function verifier(nom: string, condition: boolean, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

/** Un mot que rien d'autre au monde ne contient. */
const jeton = (quoi: string) => `canari${quoi}${randomBytes(4).toString('hex')}`;

// ─── 1. La famille de contrôle ───────────────────────────────────────────

const famille = await prisma.family.create({ data: { name: `Contrôle oubli ${randomBytes(3).toString('hex')}` } });

try {
  async function creerMembre(nom: string) {
    return prisma.member.create({ data: { familyId: famille.id, name: nom, generation: 2 } });
  }

  const temoin = await creerMembre('Témoin Oubli');
  const autre = await creerMembre('Autre Oubli');
  const CANARI_MEMBRE = jeton('membre');
  const partant = await creerMembre(`${CANARI_MEMBRE} Parti`);

  const entite = await prisma.entity.create({
    data: { familyId: famille.id, type: 'PERSON', name: 'Sujet du contrôle', normalizedName: 'sujet du controle' },
  });

  /*
   * ── DEUX MOTS, ET NON UN : L'INSTRUMENT NE DOIT PAS SE CONTAMINER ──
   *
   * La première version ne plantait qu'un mot et interrogeait la recherche
   * avec lui. Résultat : `/recits?q=<canari>` renvoyait le canari — non pas
   * parce qu'un récit retiré ressortait, mais parce que le champ de
   * recherche RÉAFFICHE ce qu'on vient de taper. Trois « fuites » sur
   * quatre étaient de ma main. C'est exactement la faute que ce dépôt
   * poursuit, commise par l'outil qui la cherche.
   *
   * Chaque récit porte donc :
   *  · un CANARI, dans le titre et le texte — la sonde, ce qu'on cherche ;
   *  · un MOT, dans le seul texte de recherche — ce qu'on tape.
   *
   * L'écho renvoie le MOT, qui n'est jamais grepé. Si le canari sort, c'est
   * que le récit est sorti.
   */
  async function creerRecit(canari: string, mot: string, auteur = temoin) {
    return prisma.story.create({
      data: {
        familyId: famille.id,
        authorId: auteur.id,
        title: `Le récit ${canari}`,
        // Le mot est dans le texte ET dans le texte de recherche : la page
        // `/recits` cherche dans `searchText`, la route d'API cherche dans
        // `title`/`content`. N'en servir qu'un rendrait l'autre sortie
        // muette, et une sortie muette se compte à tort comme étanche.
        content: `Ce texte contient ${canari}, et rien d'autre ne le contient. ${mot}`,
        searchText: `le recit ${canari} ${mot}`,
        structureType: 'evenement-marquant',
        tone: 'factuel',
        length: 'standard',
        // Une date d'événement, sans quoi le calendrier n'est pas une sortie
        // pour ce récit et on croirait l'avoir mesuré.
        eventDate: new Date(1990, 5, 12),
        linkedEntities: { connect: [{ id: entite.id }] },
      },
    });
  }

  const SUJETS = ['temoin', 'archive', 'suspendu', 'quarantaine', 'sourdine', 'supprime', 'partant'] as const;
  type Sujet = (typeof SUJETS)[number];

  const CANARIS = Object.fromEntries(SUJETS.map((s) => [s, jeton(s)])) as Record<Sujet, string>;
  const MOTS = Object.fromEntries(SUJETS.map((s) => [s, jeton(`mot${s}`)])) as Record<Sujet, string>;
  // Le nom du membre qui s'en va est lui-même un canari : c'est LUI qui ne
  // doit plus apparaître, et non son récit.
  CANARIS.partant = CANARI_MEMBRE;

  const recits: Record<Sujet, { id: string }> = {} as Record<Sujet, { id: string }>;
  for (const sujet of SUJETS) {
    // Le récit du partant reste (§2.1 règle 1 : les histoires restent,
    // l'auteur s'anonymise) ; son titre porte donc son propre canari, et
    // c'est le NOM de l'auteur qu'on traque.
    recits[sujet] = await creerRecit(
      sujet === 'partant' ? jeton('recitdupartant') : CANARIS[sujet],
      MOTS[sujet],
      sujet === 'partant' ? partant : temoin,
    );
  }

  /*
   * Le partant a fait autre chose qu'écrire un récit : il a ouvert un fil,
   * y a parlé, et déposé une archive. La §2.1 règle 1 précise que c'est
   * dans les FILS qu'un nom avait survécu la première fois — une sortie
   * qu'on n'énumère pas est une sortie qu'on déclare étanche sans l'avoir
   * regardée.
   */
  const fil = await prisma.thread.create({
    data: {
      familyId: famille.id,
      storyId: recits.partant.id,
      openedById: partant.id,
      messageCount: 1,
      lastMessageAt: new Date(),
    },
  });
  await prisma.message.create({
    data: {
      familyId: famille.id,
      threadId: fil.id,
      authorId: partant.id,
      body: `Un message du partant, avec ${MOTS.partant}.`,
    },
  });
  await prisma.archive.create({
    data: {
      familyId: famille.id,
      uploaderId: partant.id,
      storyId: recits.partant.id,
      type: 'PHOTO',
      title: `Une photo déposée par le partant`,
      storageKey: `controle/${MOTS.partant}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1,
    },
  });

  // ─── 2. Les huit retraits ────────────────────────────────────────────────

  await prisma.story.update({ where: { id: recits.archive.id }, data: { archived: true } });
  await prisma.story.update({
    where: { id: recits.suspendu.id },
    data: { suspendedAt: new Date(), suspendedForId: autre.id },
  });
  await prisma.story.update({ where: { id: recits.quarantaine.id }, data: { quarantined: true } });
  await prisma.storyMute.create({
    data: { familyId: famille.id, storyId: recits.sourdine.id, memberId: temoin.id, reason: 'contrôle' },
  });
  await prisma.story.delete({ where: { id: recits.supprime.id } });
  await prisma.member.update({ where: { id: partant.id }, data: { isDeleted: true } });

  // ─── 3. Les sorties ──────────────────────────────────────────────────────

  const cookie = (m: { id: string }) =>
    `family_token=${famille.id}.1.${sign(`${famille.id}:1`)}; member_token=${m.id}.verified.${sign(`${m.id}.verified`)}`;

  const jetonCalendrier = sign(`member:${temoin.id}:1`);

  /**
   * Toutes les sorties du produit qui rendent du texte de la famille. La
   * liste est écrite à la main et non déduite du système de fichiers : un
   * parcours automatique aurait sauté les VARIANTES, et ce sont elles qui
   * portent le risque — `?archivees=1` et `?includeArchived=1` demandent
   * explicitement à voir plus.
   */
  const SORTIES: Array<[string, string]> = [
    ['/', 'Aujourd’hui'],
    ['/recits', 'Récits'],
    ['/recits?archivees=1', 'Récits, archives comprises'],
    [`/recits?q=${MOTS.temoin}`, 'Récits, recherche du témoin'],
    ['/graphe', 'Graphe'],
    ['/livre', 'Livre'],
    ['/veillee', 'Veillée'],
    ['/traditions', 'Traditions'],
    ['/transmission', 'Transmission'],
    ['/archives', 'Archives'],
    ['/famille', 'Famille'],
    ['/entretien', 'Entretien'],
    [`/api/family/${famille.id}/stories`, 'API récits'],
    [`/api/family/${famille.id}/stories?includeArchived=1`, 'API récits, archives comprises'],
    [`/api/family/${famille.id}/stories/${recits.partant.id}`, 'API récit, détail'],
    [`/api/family/${famille.id}/archives`, 'API archives'],
    [`/api/family/${famille.id}/fils`, 'API fils'],
    [`/fils/${fil.id}`, 'Fil'],
    [`/recits/${recits.partant.id}`, 'Récit du partant'],
    [`/api/family/${famille.id}/graph`, 'API graphe'],
    [`/api/family/${famille.id}/export`, 'Export'],
    [`/api/calendrier/${temoin.id}/${jetonCalendrier}/heritage.ics`, 'Calendrier .ics'],
  ];

  // La recherche : la sortie la plus directe, et celle qu'un membre curieux
  // essaiera en premier. On interroge avec le MOT, on traque le CANARI.
  for (const sujet of SUJETS) {
    if (sujet === 'temoin') continue;
    SORTIES.push([`/recits?q=${MOTS[sujet]}`, `Récits, recherche « ${sujet} »`]);
    SORTIES.push([
      `/api/family/${famille.id}/stories?search=${MOTS[sujet]}`,
      `API récits, recherche « ${sujet} »`,
    ]);
  }

  async function parcourir(membre: { id: string }): Promise<Map<string, string>> {
    const pages = new Map<string, string>();
    for (const [chemin, nom] of SORTIES) {
      const reponse = await fetch(`${BASE}${chemin}`, { headers: { Cookie: cookie(membre), ...ENTETES } });
      const corps = await reponse.text();
      if (reponse.status >= 500 || reponse.status === 429) {
        console.log(`  ! ${nom} a répondu ${reponse.status} — cette sortie n’est PAS mesurée.`);
        continue;
      }
      pages.set(nom, corps);
    }
    return pages;
  }

  console.log(`Famille de contrôle « ${famille.name} », ${SORTIES.length} sorties.\n`);
  const vues = await parcourir(temoin);
  const vuesAutre = await parcourir(autre);

  const ou = (pages: Map<string, string>, canari: string) =>
    [...pages.entries()].filter(([, corps]) => corps.includes(canari)).map(([nom]) => nom);

  // ─── 4. Le témoin : a-t-on mesuré quelque chose ? ────────────────────────

  console.log('── D’abord : le contrôle mesure-t-il quelque chose ? ──');
  const ouTemoin = ou(vues, CANARIS.temoin);
  const ATTENDU_TEMOIN = ['Récits', 'Livre', 'API récits', 'Récits, recherche du témoin'];
  verifier(
    'un récit que personne n’a retiré se trouve bien sur les sorties principales',
    ATTENDU_TEMOIN.every((s) => ouTemoin.includes(s)),
    `trouvé sur ${ouTemoin.length} sorties : ${ouTemoin.join(', ') || 'aucune'}`,
  );
  verifier(
    'toutes les sorties ont répondu',
    vues.size === SORTIES.length,
    `${vues.size} sur ${SORTIES.length}`,
  );

  // ─── 5. Chaque promesse de retrait ───────────────────────────────────────

  /**
   * Ce que chaque mécanisme promet, et où il ne promet rien.
   *
   * `interdites` : les sorties où le canari serait une FUITE.
   * `tolerees`   : les sorties où sa présence est le comportement voulu, et
   *                pourquoi. Écrire cette colonne est la moitié du travail :
   *                sans elle, on interdit tout et on finit par débrancher le
   *                contrôle au premier faux positif.
   */
  const ATTENDUS: Array<{
    nom: string;
    canari: string;
    fondement: string;
    interdites: string[];
    tolerees: Record<string, string>;
  }> = [
    {
      nom: 'ARCHIVÉ — retiré des vues courantes, retrouvable exprès',
      canari: CANARIS.archive,
      fondement: 'Annexe A point 6 · §6.3 « Archiver visible sur chaque récit »',
      interdites: ['Récits', 'Livre', 'Veillée', 'Aujourd’hui', 'Calendrier .ics', 'API récits'],
      tolerees: {
        'Récits, archives comprises': 'la famille demande explicitement à les voir',
        'API récits, archives comprises': 'idem, par le paramètre includeArchived',
        'Export': 'amendement 3 : la famille possède ses données, archives comprises',
        'Récits, recherche « archive »': 'une recherche nommant le récit archivé le trouve — c’est le « retrouvable exprès »',
        'API récits, recherche « archive »': 'idem',
        'Graphe': 'à vérifier — voir le rapport',
        'API graphe': 'à vérifier — voir le rapport',
      },
    },
    {
      nom: 'SUSPENDU — l’auteur a retiré ses mots',
      canari: CANARIS.suspendu,
      fondement: '§2.1 règle 2 amendée · Annexe A point 6',
      // Le plus fort des retraits sur un récit qui existe encore : il ne se
      // rattrape par AUCUN paramètre. « Voir les archives » n'est pas
      // « voir ce que l'auteur a retiré ».
      interdites: [
        'Récits',
        'Récits, archives comprises',
        'Livre',
        'Veillée',
        'Aujourd’hui',
        'Calendrier .ics',
        'API récits',
        'API récits, archives comprises',
        'Graphe',
        'API graphe',
        'Récits, recherche « suspendu »',
        'API récits, recherche « suspendu »',
      ],
      tolerees: {
        'Export': 'sans le drapeau, une restauration le republierait (commit 46)',
      },
    },
    {
      nom: 'EN QUARANTAINE',
      canari: CANARIS.quarantaine,
      fondement: '§3.2 · §2.6',
      interdites: ['Livre', 'Veillée', 'Aujourd’hui', 'Calendrier .ics'],
      tolerees: {
        'Récits': 'la liste exhaustive le montre, marqué « en quarantaine »',
        'Récits, archives comprises': 'idem',
        'API récits': 'idem',
        'API récits, archives comprises': 'idem',
        'Récits, recherche « quarantaine »': 'idem',
        'API récits, recherche « quarantaine »': 'idem',
        'Export': 'amendement 3',
        'Graphe': 'à vérifier — voir le rapport',
        'API graphe': 'à vérifier — voir le rapport',
      },
    },
    {
      nom: 'SUPPRIMÉ — il n’en reste rien, nulle part',
      canari: CANARIS.supprime,
      fondement: '§2.1 règle 2 · Annexe A point 6',
      interdites: SORTIES.map(([, nom]) => nom),
      tolerees: {},
    },
    {
      nom: 'MEMBRE RETIRÉ — son nom ne survit nulle part (§2.1 règle 1)',
      canari: CANARIS.partant,
      fondement: '§2.1 règle 1 : « la règle ne dit pas anonymisé dans les récits, elle dit anonymisé »',
      interdites: SORTIES.map(([, nom]) => nom).filter((nom) => nom !== 'Export'),
      /*
       * ── LA SEULE SORTIE OÙ LE NOM DEMEURE, ET C'EST VOULU ──
       *
       * L'export porte `members: true` : les lignes de la base, telles
       * quelles. Retirer un membre est un SOFT-DELETE — la §2.1 règle 1
       * l'impose — donc une décision que la famille peut annuler. Anonymiser
       * l'export ferait de chaque restauration une perte définitive : on
       * rendrait irréversible ce que la règle a explicitement voulu
       * réversible, et l'amendement 3 dit que la famille possède ses
       * données, pas une version expurgée.
       *
       * Ce n'est donc pas un oubli, c'est un arbitrage — et il a un coût,
       * qu'on écrit plutôt que de le taire : quiconque détient le lien
       * familial peut télécharger l'export et y lire ce nom. La ligne
       * ci-dessous existe pour que cet arbitrage soit relu à chaque
       * passage, au lieu de dormir dans un `select`.
       */
      tolerees: {
        Export: 'le retrait est réversible ; anonymiser l’export le rendrait définitif (amendement 3)',
      },
    },
  ];

  console.log('\n── Ce que chaque retrait promet, et ce qui sort vraiment ──');
  for (const attendu of ATTENDUS) {
    const trouve = ou(vues, attendu.canari);
    const fuites = trouve.filter((s) => attendu.interdites.includes(s));
    verifier(
      attendu.nom,
      fuites.length === 0,
      fuites.length === 0
        ? `${attendu.fondement} · sorti sur : ${trouve.join(', ') || 'aucune sortie'}`
        : `FUITE sur ${fuites.length} sortie(s) : ${fuites.join(', ')}`,
    );
    const inattendues = trouve.filter(
      (s) => !attendu.interdites.includes(s) && !(s in attendu.tolerees),
    );
    if (inattendues.length > 0) {
      console.log(`    · sorties non classées, à trancher : ${inattendues.join(', ')}`);
    }
  }

  // ─── 6. La sourdine : une promesse PAR MEMBRE ────────────────────────────

  /*
   * La §2.6 est la seule promesse asymétrique du produit : « un membre peut
   * décider de ne plus voir un récit ; il ne peut pas décider à la place des
   * autres. » Elle se casse donc dans les DEUX sens, et un contrôle qui ne
   * regarderait qu'un seul membre en manquerait la moitié.
   */
  console.log('\n── La sourdine, qui ne vaut que pour celui qui l’a posée (§2.6) ──');
  const chezTemoin = ou(vues, CANARIS.sourdine);
  const chezAutre = ou(vuesAutre, CANARIS.sourdine);
  verifier(
    'le récit mis en sourdine ne revient pas chez celui qui l’a fait taire',
    !chezTemoin.includes('Aujourd’hui') && !chezTemoin.includes('Veillée'),
    chezTemoin.length === 0 ? 'nulle part' : `sorti sur : ${chezTemoin.join(', ')}`,
  );
  verifier(
    'et il reste entier pour les autres, qui n’ont rien demandé',
    chezAutre.includes('Récits') && chezAutre.includes('Livre'),
    `chez l’autre membre : ${chezAutre.join(', ') || 'aucune sortie'}`,
  );

// ─── 7. Nettoyage — il doit survivre à l'échec ──────────────────────────
//
// Sans `finally`, chaque plantage de ce fichier laissait une famille de
// contrôle en base, avec ses canaris. Un outil qui salit la base à chaque
// erreur est un outil qu'on finit par ne plus lancer.
} finally {
  // L'ordre suit les clés étrangères, et la liste vient de `schema.prisma`
  // et non de mémoire : `VisibilityLog` manquait, et le nettoyage échouait
  // en laissant derrière lui exactement ce qu'il devait effacer.
  const chez = { where: { familyId: famille.id } };
  await prisma.visibilityLog.deleteMany(chez);
  await prisma.suspensionRequest.deleteMany(chez);
  await prisma.reserve.deleteMany(chez);
  await prisma.storyMute.deleteMany(chez);
  await prisma.transcriptionDraft.deleteMany(chez);
  await prisma.messageMark.deleteMany({ where: { message: { familyId: famille.id } } });
  await prisma.message.deleteMany(chez);
  await prisma.thread.deleteMany(chez);
  await prisma.passage.deleteMany(chez);
  await prisma.archive.deleteMany(chez);
  await prisma.tradition.deleteMany(chez);
  await prisma.story.deleteMany(chez);
  await prisma.entity.deleteMany(chez);
  await prisma.member.deleteMany(chez);
  await prisma.family.delete({ where: { id: famille.id } });
  await prisma.$disconnect();
  console.log('\n· Famille de contrôle effacée.');
}

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);

