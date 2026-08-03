import { PrismaClient } from '@prisma/client';
import { normalizeName, daysBetween } from '../src/lib/normalize';
import { searchTextOf } from '../src/services/story.service';

const prisma = new PrismaClient();

/**
 * Famille Martin — jeu de données de référence.
 *
 * Il est construit pour que chaque acteur algorithmique ait de quoi
 * s'exercer dès le premier lancement : une tension non résolue pour le
 * Passeur, un récit ancien jamais relu pour le Conservateur, une tradition
 * datée et des anniversaires pour le Trigger Model, et deux passages pour
 * que transmission_rate ne soit pas nul.
 */
async function main() {
  const existing = await prisma.family.findFirst({ where: { name: 'Martin' } });
  if (existing) {
    console.log(`Famille Martin déjà présente (${existing.id}). Rien à faire.`);
    return;
  }

  const family = await prisma.family.create({ data: { name: 'Martin' } });

  const [robert, jeanne, claire, philippe, emma, lucas] = await Promise.all([
    prisma.member.create({
      data: {
        familyId: family.id,
        name: 'Robert Martin',
        generation: 1,
        birthDate: new Date('1931-03-12'),
        deathDate: new Date('2014-11-08'),
        role: 'Grand-père. Réparait les vélos du quartier.',
      },
    }),
    prisma.member.create({
      data: {
        familyId: family.id,
        name: 'Jeanne Martin',
        generation: 1,
        birthDate: new Date('1934-06-21'),
        role: 'Grand-mère. Tenait le carnet de recettes.',
      },
    }),
    prisma.member.create({
      data: {
        familyId: family.id,
        name: 'Claire Martin',
        generation: 2,
        birthDate: new Date('1962-09-30'),
        role: 'Fille aînée.',
      },
    }),
    prisma.member.create({
      data: {
        familyId: family.id,
        name: 'Philippe Martin',
        generation: 2,
        birthDate: new Date('1965-01-17'),
        role: 'Fils cadet.',
      },
    }),
    prisma.member.create({
      data: {
        familyId: family.id,
        name: 'Emma Martin',
        generation: 3,
        birthDate: new Date('1994-06-10'),
        role: 'Petite-fille.',
      },
    }),
    prisma.member.create({
      data: {
        familyId: family.id,
        name: 'Lucas Martin',
        generation: 4,
        birthDate: new Date('2019-04-02'),
        role: 'Arrière-petit-fils.',
      },
    }),
  ]);

  const entity = async (name: string, type: string, description?: string) =>
    prisma.entity.create({
      data: {
        familyId: family.id,
        name,
        type,
        normalizedName: normalizeName(name),
        description: description ?? null,
        memberId:
          type === 'PERSON'
            ? ([robert, jeanne, claire, philippe, emma, lucas].find((m) => m.name.startsWith(name))?.id ??
              null)
            : null,
      },
    });

  const [robertEntity, jeanneEntity, montre, atelier, poirier, bordeaux] = await Promise.all([
    entity('Robert', 'PERSON'),
    entity('Jeanne', 'PERSON'),
    entity('Montre Omega 1962', 'OBJECT', 'Montre portée par Robert jusqu’en 1994.'),
    entity('L’atelier', 'PLACE', 'Le garage au fond de la cour, rue des Peupliers.'),
    entity('Le poirier', 'PLACE', 'Planté en 1958 derrière la maison.'),
    entity('Bordeaux', 'PLACE'),
  ]);

  const now = new Date();
  const yearsAgo = (years: number, month: number, day: number) =>
    new Date(now.getFullYear() - years, month - 1, day, 10, 0, 0);

  // ── Récit 1 : la tension non résolue. Matière première du Passeur. ──
  const velos = await prisma.story.create({
    data: {
      familyId: family.id,
      authorId: claire.id,
      title: 'Les vélos de la rue des Peupliers',
      content: `Mon père réparait les vélos de tout le quartier, dans l'atelier au fond de la cour. Il ne prenait jamais d'argent. Les gens laissaient un pot de confiture sur l'établi, parfois rien du tout, et c'était très bien ainsi.

Le sien datait de 1953. Le cadre était fendu à deux endroits, ressoudé à chaque fois. On lui a proposé un vélo neuf au moins trois fois — mon oncle, puis le voisin, puis nous, pour ses soixante ans. Il refusait. Il n'a jamais voulu expliquer pourquoi.`,
      structureType: 'trait-caractere',
      tone: 'intime',
      length: 'standard',
      createdAt: yearsAgo(3, 5, 14),
      views: 12,
      lastViewedAt: yearsAgo(1, 2, 3),
      linkedEntities: { connect: [{ id: robertEntity.id }, { id: atelier.id }] },
    },
  });

  // ── Récit 2 : engendré par le premier, via une question. ──
  const montreStory = await prisma.story.create({
    data: {
      familyId: family.id,
      authorId: claire.id,
      title: 'La montre arrêtée',
      content: `Robert portait une Omega de 1962, achetée d'occasion l'année de son mariage. Elle est restée à son poignet jusqu'en 1994.

Cette année-là, il l'a arrêtée un matin de juin et ne l'a plus jamais remontée. Elle est dans le tiroir du buffet, arrêtée à 4h12. Emma est née à 4h12.`,
      structureType: 'objet-emotionnel',
      tone: 'intime',
      length: 'standard',
      createdAt: yearsAgo(2, 6, 10),
      eventDate: new Date('1994-06-10'),
      views: 8,
      lastViewedAt: yearsAgo(0, Math.max(1, now.getMonth()), 15),
      linkedEntities: { connect: [{ id: robertEntity.id }, { id: montre.id }] },
    },
  });

  // ── Récit 3 : la recette. Adossée à la tradition d'octobre. ──
  // Jeanne a 92 ans et ne tape pas. C'est Claire qui note — mais la voix
  // reste celle de Jeanne, et c'est elle que compte la métrique de distorsion.
  const tarte = await prisma.story.create({
    data: {
      familyId: family.id,
      authorId: claire.id,
      narratorId: jeanne.id,
      title: 'La tarte aux poires d’automne',
      content: `Le poirier a été planté en 1958, derrière la maison. Il donne trop de fruits, tous en même temps, à la mi-octobre.

La tarte, c'est la seule chose qu'on sache faire avec autant de poires d'un coup. Pâte brisée, poires coupées épaisses, un peu de crème, rien d'autre. On la fait le 15 octobre, ou le week-end le plus proche.`,
      structureType: 'recette-familiale',
      tone: 'factuel',
      length: 'standard',
      createdAt: yearsAgo(4, 10, 15),
      views: 21,
      lastViewedAt: yearsAgo(1, 10, 15),
      linkedEntities: { connect: [{ id: jeanneEntity.id }, { id: poirier.id }] },
    },
  });

  // ── Récit 4 : engendré par la tradition. ──
  const premiereTarte = await prisma.story.create({
    data: {
      familyId: family.id,
      authorId: emma.id,
      title: 'La première fois que j’ai fait la tarte seule',
      content: `J'avais dix-neuf ans et Jeanne était à l'hôpital pour trois jours. Personne n'avait prévu qui ferait la tarte.

Je l'ai faite avec le carnet posé à côté, en suivant chaque ligne. La pâte était trop épaisse. On l'a mangée quand même, et mon oncle a dit que c'était exactement comme celle de 1978, ce qui n'était sûrement pas un compliment.`,
      structureType: 'tradition-origine',
      tone: 'intime',
      length: 'standard',
      createdAt: yearsAgo(1, 10, 16),
      views: 5,
      lastViewedAt: yearsAgo(1, 11, 2),
      linkedEntities: { connect: [{ id: poirier.id }] },
    },
  });

  // ── Récit 5 : ancien, jamais relu. Matière du Conservateur. ──
  await prisma.story.create({
    data: {
      familyId: family.id,
      authorId: philippe.id,
      title: 'Le déménagement de Bordeaux',
      content: `On est partis de Bordeaux en août 1971, dans une camionnette prêtée par le beau-frère. Il a fallu deux voyages.

Au deuxième, la caisse de vaisselle est tombée sur l'autoroute. On s'est arrêtés, on a ramassé ce qui n'était pas cassé. Il reste quatre assiettes de ce service. Elles sont dans le buffet, avec la montre.`,
      structureType: 'maison-demenagement',
      tone: 'factuel',
      length: 'standard',
      createdAt: yearsAgo(5, 8, 22),
      views: 2,
      lastViewedAt: null,
      linkedEntities: { connect: [{ id: bordeaux.id }] },
    },
  });

  // ── Passages : la primitive du produit. ──
  const passage = async (parent: { id: string; createdAt: Date }, child: { id: string; createdAt: Date }, triggerType: string) =>
    prisma.passage.create({
      data: {
        familyId: family.id,
        parentStoryId: parent.id,
        childStoryId: child.id,
        triggerType,
        latencyDays: daysBetween(parent.createdAt, child.createdAt),
      },
    });

  await passage(velos, montreStory, 'question');
  await passage(tarte, premiereTarte, 'tradition');

  // ── Conversations ──
  await prisma.conversation.create({
    data: {
      familyId: family.id,
      storyId: montreStory.id,
      questionerId: emma.id,
      responderId: claire.id,
      questionText: 'Pourquoi Robert a arrêté la montre ?',
      responseText: 'Parce que c’était l’heure de ta naissance.',
      status: 'answered',
      createdAt: yearsAgo(2, 6, 12),
      answeredAt: yearsAgo(2, 6, 13),
    },
  });

  await prisma.conversation.create({
    data: {
      familyId: family.id,
      storyId: velos.id,
      questionerId: emma.id,
      questionText: 'Est-ce que quelqu’un sait d’où venait ce vélo de 1953 ?',
      status: 'pending',
      createdAt: yearsAgo(0, Math.max(1, now.getMonth()), 8),
    },
  });

  // ── Traditions ──
  await prisma.tradition.createMany({
    data: [
      {
        familyId: family.id,
        name: 'La tarte aux poires d’automne',
        description:
          'On récolte le poirier et on fait la tarte, avec le carnet de Jeanne posé à côté. Le 15 octobre, ou le week-end le plus proche.',
        periodicity: 'annual',
        monthDay: '10-15',
        activationCount: 6,
        lastActivatedAt: yearsAgo(1, 10, 15),
      },
      {
        familyId: family.id,
        name: 'Le coup de fil du dimanche',
        description: 'Chaque dimanche, un appel à la génération au-dessus. Peu importe la durée.',
        periodicity: 'weekly',
        weekDay: 0,
        activationCount: 44,
        lastActivatedAt: new Date(now.getTime() - 7 * 86_400_000),
      },
      {
        familyId: family.id,
        name: 'La visite de la Toussaint',
        description: 'Le 1er novembre, on passe au cimetière, puis on mange chez celui qui reçoit.',
        periodicity: 'annual',
        monthDay: '11-01',
        activationCount: 2,
        lastActivatedAt: yearsAgo(4, 11, 1),
        isAsleep: true,
        sleepReason: 'Non relevée depuis 3 ans.',
      },
    ],
  });

  // ── Archives ──
  await prisma.archive.create({
    data: {
      familyId: family.id,
      uploaderId: claire.id,
      storyId: montreStory.id,
      type: 'PHOTO',
      title: 'La montre dans le tiroir du buffet',
      storageKey: 'martin/montre-omega.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 842_133,
      extractedEntities: [],
    },
  });

  // searchText : normalisé à partir du titre et du contenu, pour que la
  // recherche trouve « demenagement » quand on a écrit « déménagement ».
  for (const story of await prisma.story.findMany({ where: { familyId: family.id } })) {
    await prisma.story.update({
      where: { id: story.id },
      data: { searchText: searchTextOf(story.title, story.content) },
    });
  }

  console.log(`Famille Martin créée.`);
  console.log(`Lien familial : /f/${family.id}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
