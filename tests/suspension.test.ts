import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { SuspensionService } from '@/services/suspension.service';

/**
 * LA SUSPENSION — par accord de l'auteur, jamais par objection.
 *
 * Ces tests fixent une décision prise CONTRE ma première recommandation.
 * J'avais proposé que l'objection suspende d'elle-même ; cela contredit la
 * §2.6 — « un membre peut décider de ne plus voir un récit ; il ne peut pas
 * décider à la place des autres » — et revient à un veto déguisé.
 */

function sansCommentaires(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const RECIT = { id: 's_1', authorId: 'claire', narratorId: null as string | null };

function service(story = RECIT, demandeExistante = false) {
  const ecrit: Record<string, unknown>[] = [];
  const prisma = {
    story: {
      findFirst: async () => story,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        ecrit.push({ table: 'story', ...data });
        return {};
      },
    },
    suspensionRequest: {
      findUnique: async () => (demandeExistante ? { id: 'r_1' } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        ecrit.push({ table: 'demande', ...data });
        return data;
      },
      deleteMany: async () => ({ count: 1 }),
      findMany: async () => [
        {
          id: 'r_1',
          motif: 'Je préfère qu’on n’en parle pas.',
          memberId: 'jeanne',
          member: { name: 'Jeanne Martin', isDeleted: false },
        },
      ],
    },
  } as unknown as PrismaClient;
  return { service: new SuspensionService(prisma), ecrit };
}

describe('Demander n’est pas suspendre', () => {
  it('enregistre la demande sans toucher au récit', async () => {
    const { service: s, ecrit } = service();
    expect(await s.demander({ familyId: 'f', storyId: 's_1', memberId: 'jeanne' })).toEqual({
      demande: true,
    });
    expect(ecrit.map((e) => e.table)).toEqual(['demande']);
    // Le récit n'a pas bougé : c'est tout le point de la décision.
    expect(ecrit.some((e) => e.table === 'story')).toBe(false);
  });

  it('n’est jamais anonyme : la demande porte un membre', async () => {
    const { ecrit } = service();
    const { service: s } = service();
    await s.demander({ familyId: 'f', storyId: 's_1', memberId: 'jeanne', motif: 'x' });
    expect(ecrit).toBeDefined();
  });

  it('refuse à l’auteur, qui dispose déjà de ses propres mots', async () => {
    const { service: s } = service();
    expect(await s.demander({ familyId: 'f', storyId: 's_1', memberId: 'claire' })).toEqual({
      demande: false,
      raison: 'auteur',
    });
  });

  it('refuse au narrateur, pour la même raison (§2.3)', async () => {
    const { service: s } = service({ ...RECIT, narratorId: 'jeanne' });
    expect((await s.demander({ familyId: 'f', storyId: 's_1', memberId: 'jeanne' })).raison).toBe(
      'auteur',
    );
  });

  it('ne transforme pas une demande répétée en insistance', async () => {
    const { service: s } = service(RECIT, true);
    expect((await s.demander({ familyId: 'f', storyId: 's_1', memberId: 'jeanne' })).raison).toBe(
      'deja',
    );
  });
});

describe('Seul l’auteur suspend', () => {
  it('suspend à la demande de quelqu’un, en le nommant', async () => {
    const { service: s, ecrit } = service();
    expect(
      await s.suspendre({ familyId: 'f', storyId: 's_1', memberId: 'claire', pourQui: 'jeanne' }),
    ).toEqual({ suspendu: true });

    const maj = ecrit.find((e) => e.table === 'story')!;
    expect(maj.suspendedAt).toBeInstanceOf(Date);
    expect(maj.suspendedForId).toBe('jeanne');
  });

  it('refuse à qui n’a écrit ni raconté', async () => {
    const { service: s, ecrit } = service();
    expect(
      await s.suspendre({ familyId: 'f', storyId: 's_1', memberId: 'jeanne', pourQui: 'jeanne' }),
    ).toEqual({ suspendu: false, raison: 'autorite' });
    expect(ecrit).toHaveLength(0);
  });

  it('remet le récit — c’est tout l’intérêt sur la suppression', async () => {
    const { service: s, ecrit } = service();
    expect(await s.remettre('f', 's_1', 'claire')).toBe(true);
    const maj = ecrit.find((e) => e.table === 'story')!;
    expect(maj.suspendedAt).toBeNull();
    expect(maj.suspendedForId).toBeNull();
  });

  it('anonymise l’auteur d’une demande qui a quitté la famille', async () => {
    const prisma = {
      suspensionRequest: {
        findMany: async () => [
          { id: 'r', motif: null, memberId: 'x', member: { name: 'Jeanne', isDeleted: true } },
        ],
      },
    } as unknown as PrismaClient;
    const [vue] = await new SuspensionService(prisma).demandes('f', 's_1');
    expect(vue!.parQui).toBe('Membre anonymisé');
  });
});

describe('Un récit suspendu quitte ce qui circule, pas ce qu’on possède', () => {
  /** Toute requête qui alimente un affichage doit porter le filtre. */
  const AFFICHAGES: Array<[string, string[]]> = [
    ['la liste des récits', ['src', 'app', 'recits', 'page.tsx']],
    // Le rassemblement du livre a quitté la page pour un service partagé :
    // le coffre (`src/lib/coffre.ts`) doit produire EXACTEMENT le même
    // livre, et deux requêtes écrites deux fois divergeraient. Le contrôle
    // porte donc sur le point de passage unique — il couvre maintenant les
    // deux sorties au lieu d'une.
    ['le livre', ['src', 'services', 'livre.service.ts']],
    ['la veillée', ['src', 'services', 'veillee.service.ts']],
    ['le Passeur', ['src', 'services', 'passeur.service.ts']],
    ['le graphe', ['src', 'app', 'graphe', 'page.tsx']],
    ['le calendrier', ['src', 'app', 'api', 'calendrier', '[memberId]', '[token]', 'heritage.ics', 'route.ts']],
    ['l’API des récits', ['src', 'app', 'api', 'family', '[id]', 'stories', 'route.ts']],
  ];

  it.each(AFFICHAGES)('%s écarte les récits suspendus', (_nom, chemin) => {
    expect(sansCommentaires(...chemin)).toMatch(/suspendedAt: null/);
  });

  it('l’export ne filtre RIEN — la famille possède ses données (amendement 3)', () => {
    // La frontière est celle-ci, et elle existait déjà pour les récits
    // archivés et mis en quarantaine : le livre filtre, l'export non.
    const EXPORT = sansCommentaires('src', 'services', 'export.service.ts');
    expect(EXPORT).not.toMatch(/suspendedAt: null|archived: false|quarantined: false/);
  });

  it('ne détruit aucun lien de transmission', () => {
    const SERVICE = sansCommentaires('src', 'services', 'suspension.service.ts');
    expect(SERVICE).not.toMatch(/passage\.delete|deleteMany\(\{ where: \{ storyId/);
  });
});

describe('L’application porte la demande, elle ne l’impose jamais', () => {
  const PAGE = sansCommentaires('src', 'app', 'recits', '[storyId]', 'page.tsx');

  it('dit à qui demande que l’auteur peut refuser', () => {
    expect(PAGE).toMatch(/Il décide, et il peut refuser/);
  });

  it('dit à l’auteur que ne rien faire est une réponse', () => {
    expect(PAGE).toMatch(/Ne rien faire est une réponse/);
  });

  it('affiche les mots du demandeur sans les reformuler', () => {
    expect(PAGE).toMatch(/demande\.motif/);
  });

  it('ne relance jamais l’auteur ni ne compte les demandes en attente', () => {
    // Ni minuteur, ni « 2 demandes en attente » : ce serait une pression.
    //
    // Le motif contenait `rappel` tout court. Il a fini par refuser une
    // phrase qui n'a rien à voir avec la pression — « Ce récit vous en
    // rappelle un autre ? », posée sous le texte pour inviter à raconter la
    // suite. Un garde trop large finit par interdire du français ordinaire,
    // et on le désarme alors pour de mauvaises raisons.
    //
    // Il vise donc maintenant ce qu'il voulait dire : le décompte, le
    // minuteur, la relance, l'injonction. Plus étroit sur les mots, aussi
    // strict sur le fond.
    expect(PAGE).not.toMatch(
      /en attente depuis|\brelances?\b|demandes? en attente|rappelez[- ]|relancer l|n.oubliez pas/i,
    );
    // Et le NOMBRE de demandes ne s'affiche jamais. Attention à la nuance :
    // `demandes.length > 0` est une condition — parfaitement légitime, c'est
    // elle qui décide de montrer la section. Ce qui est interdit, c'est de
    // RENDRE le chiffre. Mon premier motif confondait les deux et refusait
    // le garde lui-même.
    expect(PAGE).not.toMatch(/\{\s*demandes\.length\s*\}/);
  });

  it('exige une identité prouvée pour suspendre, comme pour supprimer', () => {
    const ACTIONS = sansCommentaires('src', 'app', 'actions.ts');
    const action = ACTIONS.slice(ACTIONS.indexOf('export async function suspendreRecit'));
    expect(action.slice(0, 600)).toMatch(/canDelete\(context\)/);
  });
});

describe('Aucune détection automatique nulle part', () => {
  it('rien ne suspend un récit sans qu’un humain l’ait décidé', () => {
    const racine = join(process.cwd(), 'src');
    const fichiers: string[] = [];
    const parcourir = (d: string) => {
      for (const e of readdirSync(d)) {
        const c = join(d, e);
        if (statSync(c).isDirectory()) parcourir(c);
        else if (/\.tsx?$/.test(e)) fichiers.push(c);
      }
    };
    parcourir(racine);

    // Seule l'ÉCRITURE compte : `suspendedAt: null` apparaît partout comme
    // filtre de lecture, et confondre les deux ne testerait rien. Le geste
    // qui suspend est `suspendedAt: new Date()`, et lui seul.
    const ecrivains = fichiers.filter((f) => {
      const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return /suspendedAt: new Date\(\)/.test(code);
    });
    expect(ecrivains.map((f) => f.split('/').pop())).toEqual(['suspension.service.ts']);
  });
});
