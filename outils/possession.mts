/**
 * LA POSSESSION — l'aller-retour complet, contre une vraie base.
 *
 * L'amendement 3 dit que la famille possède ses données. Toute la
 * Constitution s'appuie dessus : c'est parce qu'on peut partir avec tout
 * qu'on peut accepter le reste — l'algorithme qui choisit, le Conservateur
 * qui mesure, le Passeur qui interroge. La §6.3 met « Exporter » au pied de
 * chaque page.
 *
 * Et rien ne vérifiait cet aller-retour. `export.service.ts` et
 * `import.service.ts` existaient chacun de leur côté ; aucun test ne
 * prenait un export pour le remettre. Une mémoire qu'on peut emporter mais
 * pas remettre n'appartient pas vraiment à la famille — la page
 * `/restaurer` le dit en toutes lettres, et personne ne l'avait essayé.
 *
 * Ce contrôle exporte la famille d'essai, la restaure dans une famille
 * NEUVE, et compare. Puis il efface la famille restaurée : un outil qui
 * laisse des doubles derrière lui pollue toutes les mesures suivantes.
 *
 * Il exige une vraie base — d'où sa place ici plutôt que dans `npm test`.
 *
 * USAGE :   npx tsx outils/possession.mts
 */

import { PrismaClient } from '@prisma/client';
import { ExportService } from '../src/services/export.service';
import { ImportService } from '../src/services/import.service';

const prisma = new PrismaClient();

const resultats: Array<[string, boolean]> = [];
function verifier(nom: string, condition: boolean, detail = '') {
  resultats.push([nom, condition]);
  console.log(`${condition ? '✓' : '✗'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

const origine = await prisma.family.findFirst({ orderBy: { createdAt: 'asc' } });
if (!origine) throw new Error('Base vide : lancer `npm run seed` avant le contrôle.');

const exporte = await new ExportService(prisma).exportFamily(origine.id);
if (!exporte) throw new Error('L’export a rendu null sur une famille qui existe.');

console.log(`Famille « ${exporte.family.name} » — ${JSON.stringify(exporte.counts)}\n`);

// Un export vide passerait toutes les comparaisons ci-dessous : deux zéros
// sont égaux. On refuse donc de conclure sur une famille sans contenu.
const total = Object.values(exporte.counts).reduce((somme, n) => somme + n, 0);
if (total === 0) throw new Error('Export vide : ce contrôle ne prouverait rien.');

// ── L'export ne filtre rien : c'est la moitié de l'amendement 3 ──
const [archivees, suspendues, quarantaine] = await Promise.all([
  prisma.story.count({ where: { familyId: origine.id, archived: true } }),
  prisma.story.count({ where: { familyId: origine.id, suspendedAt: { not: null } } }),
  prisma.story.count({ where: { familyId: origine.id, quarantined: true } }),
]);
const toutesLesHistoires = await prisma.story.count({ where: { familyId: origine.id } });
verifier(
  'l’export emporte TOUS les récits, y compris ceux que l’app cache',
  exporte.counts.stories === toutesLesHistoires,
  `${exporte.counts.stories}/${toutesLesHistoires} — dont ${archivees} archivés, ${quarantaine} en quarantaine, ${suspendues} suspendus`,
);
verifier(
  'l’export emporte le journal de visibilité, qui accuse le produit',
  exporte.counts.visibilityLogs > 0,
  `${exporte.counts.visibilityLogs} lignes`,
);

// ── La remise ──
//
// On passe par le JSON, pas par l'objet en mémoire : c'est ce qui traverse
// réellement le disque de la famille, et `JSON.stringify` est l'endroit où
// une `Date` devient une chaîne — donc l'endroit où un import mal écrit
// casse.
const surLeDisque = JSON.parse(JSON.stringify(exporte));

// ── ON FABRIQUE L'ÉTAT QU'ON PRÉTEND VÉRIFIER ──
//
// Première version de ce fichier : « un récit suspendu le reste après
// restauration ✓ (aucun dans le jeu d'essai) ». Trois contrôles verts sur
// des ensembles VIDES — la coche disait « vérifié », elle voulait dire
// « rien à vérifier ». C'est le défaut de ce dépôt, dans l'outil écrit pour
// le trouver, pour la quatrième fois aujourd'hui.
//
// On pose donc l'état dans le fichier exporté, en mémoire, sans toucher à
// la famille d'origine : un récit suspendu pour quelqu'un de nommé, un
// récit en quarantaine, une sourdine, une demande. Puis on restaure ça.
const [premier, second] = surLeDisque.stories as Array<Record<string, unknown>>;
const [membreA, membreB] = surLeDisque.members as Array<Record<string, unknown>>;
if (!premier || !second || !membreA || !membreB) {
  throw new Error('Jeu d’essai trop petit : il faut deux récits et deux membres.');
}
premier.suspendedAt = new Date('2026-07-01T10:00:00.000Z').toISOString();
premier.suspendedForId = membreB.id;
second.quarantined = true;
surLeDisque.storyMutes = [
  { id: 'm1', storyId: second.id, memberId: membreA.id, reason: 'trois refus', createdAt: new Date().toISOString() },
];
surLeDisque.suspensionRequests = [
  { id: 'd1', storyId: premier.id, memberId: membreB.id, motif: 'Je préfère qu’on n’en parle pas.', createdAt: new Date().toISOString() },
];
const ATTENDU = {
  suspendu: premier.title as string,
  quarantaine: second.title as string,
  sourdines: 1,
  demandes: 1,
};

const remise = await new ImportService(prisma).importFamily(surLeDisque);
if ('error' in remise) throw new Error(`La restauration a échoué : ${remise.error}`);

try {
  verifier('la restauration crée une famille NEUVE', remise.familyId !== origine.id);
  // Le nom porte « (restaurée) », et c'est voulu : deux mémoires du même
  // nom dans la même base seraient indiscernables. Mon premier contrôle
  // exigeait l'égalité stricte et déclarait un défaut là où il y avait une
  // décision. On vérifie donc ce qui compte : le nom d'origine est là, et
  // la copie se signale.
  verifier(
    'elle garde le nom, en se signalant comme une copie',
    remise.familyName.startsWith(exporte.family.name) && remise.familyName !== exporte.family.name,
    remise.familyName,
  );

  const nouvelle = await new ExportService(prisma).exportFamily(remise.familyId);
  if (!nouvelle) throw new Error('La famille restaurée ne s’exporte pas.');

  // ── Ce qui doit revenir, et ce qui ne revient pas ──
  //
  // Deux catégories, et il faut les tenir séparées : ce qui manque par
  // DÉCISION, et ce qui manque par oubli. La première se nomme, la seconde
  // est un défaut.
  const NE_REVIENT_PAS: Record<string, string> = {
    // L'export ne porte que les descriptions, jamais les octets : recréer
    // des lignes dont la clé de stockage ne pointe sur rien donnerait à la
    // famille l'illusion d'avoir récupéré ses photos.
    archives: 'les fichiers ne sont pas dans l’export',
    // Le journal mesure ce que l'APPLICATION a montré. Le rejouer dans une
    // base neuve inventerait des lectures qui n'ont pas eu lieu.
    visibilityLogs: 'le journal mesure une instance, pas une mémoire',
    // Sans les enregistrements, un brouillon n'a plus rien à relire. Le
    // TEXTE, lui, part bien dans l'export : c'est ce qui compte.
    transcriptionDrafts: 'sans l’audio, il n’y a plus rien à relire',
  };

  // `storyMutes` et `suspensionRequests` sont posés dans le fichier plus
  // haut : on les compare à ce qu'on y a mis, pas à l'export d'origine.
  const ATTENDUS: Record<string, number> = {
    storyMutes: ATTENDU.sourdines,
    suspensionRequests: ATTENDU.demandes,
  };

  for (const clef of Object.keys(exporte.counts) as Array<keyof typeof exporte.counts>) {
    if (clef in ATTENDUS) {
      verifier(
        `${clef} : ${ATTENDUS[clef]} posés, ${nouvelle.counts[clef]} restaurés`,
        nouvelle.counts[clef] === ATTENDUS[clef],
      );
      continue;
    }
    const raison = NE_REVIENT_PAS[clef];
    if (raison) {
      verifier(
        `${clef} : non restauré par décision — ${raison}`,
        nouvelle.counts[clef] === 0,
        `${exporte.counts[clef]} exportés`,
      );
      continue;
    }
    verifier(
      `${clef} : ${exporte.counts[clef]} exportés, ${nouvelle.counts[clef]} restaurés`,
      exporte.counts[clef] === nouvelle.counts[clef],
    );
  }

  // ── LE RETRAIT SURVIT-IL AU VOYAGE ? ──
  //
  // La question la plus importante de ce fichier. Quelqu'un a demandé qu'on
  // n'affiche plus un récit, l'auteur a accepté : une restauration ne doit
  // pas défaire cet accord. Idem pour la quarantaine et les sourdines.
  const suspendus = nouvelle.stories.filter((r) => r.suspendedAt !== null);
  verifier(
    'un récit suspendu le reste après restauration',
    suspendus.length === 1 && suspendus[0]!.title === ATTENDU.suspendu,
    suspendus.map((r) => r.title).join(', ') || 'AUCUN — le retrait a été défait',
  );
  const pourQui = suspendus[0]?.suspendedForId;
  const nomAttendu = (nouvelle.members as Array<{ id: string; name: string }>).find(
    (m) => m.id === pourQui,
  )?.name;
  verifier(
    'et il reste suspendu POUR QUELQU’UN, nommé',
    Boolean(nomAttendu) && nomAttendu === (membreB.name as string),
    nomAttendu ?? 'personne',
  );
  const enQuarantaine = nouvelle.stories.filter((r) => r.quarantined).map((r) => r.title);
  verifier(
    'un récit en quarantaine le reste',
    enQuarantaine.length === 1 && enQuarantaine[0] === ATTENDU.quarantaine,
    enQuarantaine.join(', ') || 'AUCUN — la quarantaine a été levée',
  );
  verifier(
    'la mise en sourdine survit',
    nouvelle.counts.storyMutes === ATTENDU.sourdines,
    `${nouvelle.counts.storyMutes}/${ATTENDU.sourdines}`,
  );
  verifier(
    'la demande de suspension survit, avec ses mots',
    nouvelle.counts.suspensionRequests === ATTENDU.demandes &&
      nouvelle.suspensionRequests[0]?.motif === 'Je préfère qu’on n’en parle pas.',
    nouvelle.suspensionRequests[0]?.motif ?? 'aucune',
  );

  // L'export doit DIRE ce qu'il ne contient pas.
  verifier(
    'le fichier nomme lui-même ses propres trous',
    typeof exporte.nonInclus?.reserves === 'string' && exporte.nonInclus.reserves.length > 40,
  );

  // ── Ce que les comptes ne disent pas ──
  //
  // Deux nombres égaux ne prouvent pas que le CONTENU a survécu. On compare
  // donc les titres, et surtout les PASSAGES : le lien parent → enfant est
  // la primitive du produit, et c'est aussi la première chose qu'un import
  // naïf casse, puisque les identifiants changent.
  const titres = (liste: typeof exporte.stories) =>
    liste.map((r) => r.title).sort().join(' | ');
  verifier(
    'les titres des récits sont identiques',
    titres(exporte.stories) === titres(nouvelle.stories),
  );

  const texteOrigine = exporte.stories.map((r) => r.content).sort().join('§');
  const texteRemis = nouvelle.stories.map((r) => r.content).sort().join('§');
  verifier(
    'le texte des récits est identique, caractère pour caractère',
    texteOrigine === texteRemis,
    `${texteOrigine.length} caractères`,
  );

  // Les identifiants changent à la restauration : on compare la FORME de la
  // filiation — quel titre engendre quel titre — et non les identifiants.
  const filiation = (
    stories: typeof exporte.stories,
    passages: typeof exporte.passages,
  ) => {
    const parTitre = new Map(stories.map((r) => [r.id, r.title]));
    return passages
      .map((p) => `${parTitre.get(p.parentStoryId) ?? '?'} → ${parTitre.get(p.childStoryId) ?? '?'}`)
      .sort()
      .join(' ; ');
  };
  const avant = filiation(exporte.stories, exporte.passages);
  const apres = filiation(nouvelle.stories, nouvelle.passages);
  verifier('la chaîne de transmission survit au voyage', avant === apres, avant || '(aucune)');
  verifier(
    'et elle n’est pas vide : le contrôle vérifie quelque chose',
    exporte.passages.length > 0,
    `${exporte.passages.length} passages`,
  );

  // ── Le contrôle vérifie-t-il quelque chose ? ──
  // Sans cette ligne, un import qui ignorerait tout en bloc passerait les
  // comparaisons dont les deux côtés sont vides.
  verifier(
    'l’état de retrait posé n’était pas vide',
    ATTENDU.sourdines > 0 && ATTENDU.demandes > 0 && Boolean(ATTENDU.suspendu),
  );

  const messages = (liste: typeof exporte.messages) =>
    liste.map((m) => m.content).sort().join('§');
  verifier(
    'la parole des fils survit aussi',
    messages(exporte.messages) === messages(nouvelle.messages),
  );
} finally {
  // ── On ne laisse pas de double derrière soi ──
  await prisma.$transaction([
    prisma.passage.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.visibilityLog.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.message.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.thread.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.archive.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.tradition.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.story.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.entity.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.member.deleteMany({ where: { familyId: remise.familyId } }),
    prisma.family.delete({ where: { id: remise.familyId } }),
  ]);
  const restant = await prisma.family.count({ where: { id: remise.familyId } });
  verifier('la famille d’essai est effacée après le contrôle', restant === 0);
  await prisma.$disconnect();
}

const echecs = resultats.filter(([, ok]) => !ok);
console.log(`\nTOTAL : ${resultats.length - echecs.length}/${resultats.length} contrôles passés`);
if (echecs.length > 0) process.exit(1);
