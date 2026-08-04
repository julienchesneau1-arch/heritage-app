import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { ThreadService, MARK_KINDS, MARK_LABELS } from '@/services/thread.service';
import { ImportService } from '@/services/import.service';
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';

const FAMILY = 'fam_1';

/**
 * LE FIL — la forme vient des salons de discussion, le moteur non.
 *
 * Ces tests fixent ce que le produit REFUSE d'emprunter à Discord et à ses
 * semblables. Ce ne sont pas des préférences d'affichage : ce sont les
 * mécaniques par lesquelles ces produits fabriquent la peur de manquer
 * quelque chose, et la Constitution les interdit (§6.1, §12).
 */
/**
 * Le code SANS ses commentaires.
 *
 * Un fichier qui écrit « aucun compteur de non-lus » dans son en-tête
 * contient littéralement les mots interdits. Chercher dans le source brut
 * confondrait « interdire une chose » et « la faire » — le test échouerait
 * sur sa propre documentation et passerait sur du code fautif commenté.
 */
function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FIL_COMPONENT = source('src', 'components', 'fil.tsx');
const FIL_SERVICE = source('src', 'services', 'thread.service.ts');

describe('Le fil n’emprunte pas le moteur des salons de discussion', () => {
  it('n’affiche aucun compteur de non-lus', () => {
    // La pastille rouge est le moteur de l'engagement de ces produits.
    expect(FIL_COMPONENT).not.toMatch(/non[- ]?lus?|unread|nouveau[x]?\s*message/i);
  });

  it('n’affiche aucune présence ni aucune saisie en cours', () => {
    expect(FIL_COMPONENT).not.toMatch(/en ligne|est en train d[’']écrire|is typing|présence/i);
  });

  it('ne compte jamais les marques — il rend des noms', () => {
    // Un décompte de réactions est un score, et le Conservateur existe pour
    // combattre les scores.
    expect(FIL_COMPONENT).toContain('.map((mark) => mark.member.name)');
    expect(FIL_COMPONENT).not.toMatch(/marks\.length\s*[>}]?\s*\{|\{marks\.length\}/);
  });

  it('n’exhibe jamais l’inactivité d’un fil', () => {
    // « Personne n'a parlé depuis trois semaines » transforme un rythme
    // familial normal en reproche. Dix messages par mois, c'est une famille.
    for (const fichier of [FIL_COMPONENT, FIL_SERVICE]) {
      expect(fichier).not.toMatch(/inactif|depuis \$\{|dernier message il y a|silence depuis/i);
    }
  });

  it('n’interpelle jamais tout le monde à la fois', () => {
    expect(FIL_COMPONENT).not.toMatch(/@everyone|@here|notifier|notification/i);
  });

  it('trie sur la dernière prise de parole, mais ne l’affiche pas', () => {
    // Ordonner est utile ; afficher la décrépitude ne l'est pas.
    expect(FIL_SERVICE).toContain("orderBy: { lastMessageAt: 'desc' }");
    expect(FIL_COMPONENT).not.toContain('lastMessageAt');
  });
});

describe('Les marques sont des faits, pas des avis', () => {
  it('n’offre aucun vocabulaire évaluatif', () => {
    for (const kind of MARK_KINDS) {
      expect(kind).not.toMatch(/LIKE|LOVE|STAR|UPVOTE|FAV/i);
    }
  });

  it('formule chaque marque comme un constat de première main', () => {
    expect(Object.values(MARK_LABELS)).toEqual([
      'J’y étais',
      'Je m’en souviens',
      'Je ne savais pas',
    ]);
  });

  it('franchit le filtre constitutionnel', () => {
    for (const label of Object.values(MARK_LABELS)) {
      expect(constitutionEmotionFilter(label)).toBe(true);
      expect(isNonCoerciveLanguage(label)).toBe(true);
    }
  });
});

describe('Le fil défait le verrou de la page blanche', () => {
  function serviceWith(recorded: Record<string, unknown>[]) {
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          thread: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              recorded.push({ table: 'thread', ...data });
              return { id: 'thr_1', ...data };
            },
            update: async ({ data }: { data: Record<string, unknown> }) => {
              recorded.push({ table: 'thread.update', ...data });
              return {};
            },
            findFirst: async () => ({ id: 'thr_1' }),
          },
          message: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              recorded.push({ table: 'message', ...data });
              return { id: 'msg_1', ...data };
            },
          },
        }),
    } as unknown as PrismaClient;
    return new ThreadService(prisma);
  }

  it('ouvre un fil sur une ENTITÉ, sans qu’aucun récit existe', async () => {
    // C'était impossible : `Conversation.storyId` était obligatoire, donc
    // il fallait rédiger un récit avant de pouvoir dire trois mots.
    const recorded: Record<string, unknown>[] = [];
    await serviceWith(recorded).open(
      { kind: 'entity', entityId: 'e_montre' },
      { familyId: FAMILY, authorId: 'mem_1', body: 'Elle est où maintenant ?' },
    );

    const thread = recorded.find((row) => row.table === 'thread')!;
    expect(thread.entityId).toBe('e_montre');
    expect(thread.storyId).toBeNull();
  });

  it('ouvre un fil accroché à rien du tout', async () => {
    const recorded: Record<string, unknown>[] = [];
    await serviceWith(recorded).open(
      { kind: 'none' },
      { familyId: FAMILY, authorId: 'mem_1', body: 'Quelqu’un se souvient du nom du chien ?' },
    );
    const thread = recorded.find((row) => row.table === 'thread')!;
    expect(thread.entityId).toBeNull();
    expect(thread.storyId).toBeNull();
  });

  it('n’exige ni titre, ni type, ni structure', async () => {
    const recorded: Record<string, unknown>[] = [];
    await serviceWith(recorded).open(
      { kind: 'none' },
      { familyId: FAMILY, authorId: 'mem_1', body: 'Oui.' },
    );
    expect(recorded.find((row) => row.table === 'thread')!.title).toBeNull();
  });

  it('un fil n’est jamais vide : l’ouvrir, c’est déjà y parler', async () => {
    const recorded: Record<string, unknown>[] = [];
    await serviceWith(recorded).open(
      { kind: 'none' },
      { familyId: FAMILY, authorId: 'mem_1', body: 'Trois mots.' },
    );
    expect(recorded.filter((row) => row.table === 'message')).toHaveLength(1);
    expect(recorded.find((row) => row.table === 'thread')!.messageCount).toBe(1);
  });

  it('accepte autant de voix qu’on veut — le troisième intervenant a sa place', async () => {
    // L'ancien modèle n'avait qu'un `responseText` : Jeanne ne pouvait pas
    // corriger la réponse de Claire.
    const recorded: Record<string, unknown>[] = [];
    const service = serviceWith(recorded);
    await service.reply('thr_1', { familyId: FAMILY, authorId: 'mem_2', body: 'Dans le buffet.' });
    await service.reply('thr_1', { familyId: FAMILY, authorId: 'mem_3', body: 'Non, dans le tiroir.' });
    expect(recorded.filter((row) => row.table === 'message')).toHaveLength(2);
  });
});

describe('Le fil garde la voix distincte du clavier', () => {
  it('enregistre le narrateur quand quelqu’un note pour un autre', async () => {
    // Un fil écrit avantage le clavier rapide. Sans cette distinction,
    // l'interface amplifierait la distorsion que le Conservateur mesure.
    const recorded: Record<string, unknown>[] = [];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          thread: { create: async () => ({ id: 'thr_1' }) },
          message: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              recorded.push(data);
              return { id: 'm', ...data };
            },
          },
        }),
    } as unknown as PrismaClient;

    await new ThreadService(prisma).open(
      { kind: 'entity', entityId: 'e' },
      {
        familyId: FAMILY,
        authorId: 'claire',
        narratorId: 'jeanne',
        body: 'Je ne l’ai jamais fait réparer.',
      },
    );

    expect(recorded[0]!.authorId).toBe('claire');
    expect(recorded[0]!.narratorId).toBe('jeanne');
  });

  it('attribue la parole au narrateur dans la matière à cristalliser', async () => {
    const prisma = {
      thread: {
        findFirst: async () => ({
          id: 'thr_1',
          messages: [
            {
              id: 'm1',
              body: 'Elle est où ?',
              author: { id: 'lucas', name: 'Lucas' },
              narrator: null,
              marks: [],
            },
            {
              id: 'm2',
              body: 'Dans le tiroir du buffet.',
              author: { id: 'claire', name: 'Claire' },
              narrator: { id: 'jeanne', name: 'Jeanne' },
              marks: [],
            },
          ],
        }),
      },
    } as unknown as PrismaClient;

    const material = (await new ThreadService(prisma).material(FAMILY, 'thr_1'))!;

    // Jeanne, pas Claire : la mémoire appartient à qui la porte.
    expect(material.speakers.map((s) => s.name)).toEqual(['Lucas', 'Jeanne']);
    expect(material.transcript).toContain('Jeanne : Dans le tiroir du buffet.');
    expect(material.transcript).not.toContain('Claire :');
  });
});

describe('Un export d’avant le fil se restaure encore', () => {
  /**
   * Amendement 3 : la famille possède ses données — y compris celles qu'elle
   * a emportées il y a six mois, dans un format que le produit n'écrit plus.
   * Une conversation v1 redevient un fil d'un ou deux messages, exactement
   * comme l'a fait la migration de la base.
   */
  function fakePrisma(ecrits: Record<string, unknown[]>) {
    const table = (nom: string) => ({
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `${nom}_${(ecrits[nom] ??= []).length}`, ...data };
        ecrits[nom]!.push(row);
        return row;
      },
    });
    return {
      family: { create: table('family').create },
      member: table('member'),
      entity: table('entity'),
      story: table('story'),
      archive: table('archive'),
      tradition: table('tradition'),
      passage: table('passage'),
      visibilityLog: table('visibilityLog'),
      thread: table('thread'),
      message: table('message'),
    } as unknown as PrismaClient;
  }

  const exportV1 = {
    format: 'heritage-export/v1',
    family: { name: 'Martin' },
    members: [
      { id: 'm1', name: 'Emma', generation: 3 },
      { id: 'm2', name: 'Claire', generation: 2 },
    ],
    stories: [{ id: 's1', title: 'La montre', content: 'Texte.', authorId: 'm1' }],
    conversations: [
      {
        id: 'c1',
        storyId: 's1',
        questionerId: 'm1',
        questionText: 'Pourquoi Robert a arrêté la montre ?',
        responderId: 'm2',
        responseText: 'Parce que c’était l’heure de ta naissance.',
        status: 'answered',
        createdAt: '2024-01-01T10:00:00.000Z',
        answeredAt: '2024-01-02T10:00:00.000Z',
      },
      {
        id: 'c2',
        storyId: 's1',
        questionerId: 'm1',
        questionText: 'D’où venait ce vélo ?',
        responseText: null,
        status: 'pending',
        createdAt: '2024-02-01T10:00:00.000Z',
      },
    ],
  };

  it('transforme chaque conversation en fil, sans perdre une parole', async () => {
    const ecrits: Record<string, unknown[]> = {};
    const result = (await new ImportService(fakePrisma(ecrits)).importFamily(exportV1)) as {
      error?: string;
    };
    expect(result.error).toBeUndefined();

    expect(ecrits.thread).toHaveLength(2);
    // Deux messages pour la conversation répondue, un pour celle restée seule.
    expect(ecrits.message).toHaveLength(3);

    const corps = (ecrits.message as Array<{ body: string }>).map((m) => m.body);
    expect(corps).toContain('Pourquoi Robert a arrêté la montre ?');
    expect(corps).toContain('Parce que c’était l’heure de ta naissance.');
    expect(corps).toContain('D’où venait ce vélo ?');
  });

  it('marque la question comme question, et la réponse comme réponse', async () => {
    const ecrits: Record<string, unknown[]> = {};
    await new ImportService(fakePrisma(ecrits)).importFamily(exportV1);

    const messages = ecrits.message as Array<{ body: string; isQuestion?: boolean }>;
    const question = messages.find((m) => m.body.startsWith('Pourquoi'))!;
    const reponse = messages.find((m) => m.body.startsWith('Parce que'))!;
    expect(question.isQuestion).toBe(true);
    expect(reponse.isQuestion).toBeFalsy();
  });

  it('reporte le bon compteur de messages sur chaque fil', async () => {
    const ecrits: Record<string, unknown[]> = {};
    await new ImportService(fakePrisma(ecrits)).importFamily(exportV1);
    const compteurs = (ecrits.thread as Array<{ messageCount: number }>).map((t) => t.messageCount);
    expect(compteurs.sort()).toEqual([1, 2]);
  });
});

describe('Annexe A point 6 — une parole se retire', () => {
  /**
   * « Oubli = droit : archivage, silence, suppression sont des décisions
   * familiales ABSOLUES ». Ce chemin n'existait pas : un message versé
   * dans la mémoire ne pouvait plus être repris par personne, pas même par
   * celui qui l'avait dit. Une parole qu'on ne peut pas retirer n'a pas été
   * donnée, elle a été prise.
   */
  function serviceAvec(
    message: { id: string; threadId: string; authorId: string; narratorId: string | null } | null,
    restants: number,
    trace: string[] = [],
  ) {
    const prisma = {
      message: { findFirst: async () => message },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          message: {
            delete: async () => {
              trace.push('message supprimé');
              return {};
            },
            count: async () => restants,
            findFirst: async () => ({ createdAt: new Date(2024, 0, 1) }),
          },
          thread: {
            delete: async () => {
              trace.push('fil supprimé');
              return {};
            },
            update: async ({ data }: { data: { messageCount: number } }) => {
              trace.push(`compteur → ${data.messageCount}`);
              return {};
            },
          },
        }),
    } as unknown as PrismaClient;
    return { service: new ThreadService(prisma), trace };
  }

  const MESSAGE = { id: 'm1', threadId: 't1', authorId: 'claire', narratorId: 'jeanne' };

  it('laisse celui qui a écrit retirer ses mots', async () => {
    const { service } = serviceAvec(MESSAGE, 2);
    expect((await service.removeMessage(FAMILY, 'm1', 'claire')).retire).toBe(true);
  });

  it('laisse celui qui a PARLÉ retirer ses mots, même s’il n’a pas tapé', async () => {
    // C'est tout l'enjeu : Jeanne a 92 ans et ne tape pas. Ses mots sont
    // saisis par Claire. Sans cette règle, la seule personne à qui ils
    // appartiennent serait la seule à ne pas pouvoir les reprendre.
    const { service } = serviceAvec(MESSAGE, 2);
    expect((await service.removeMessage(FAMILY, 'm1', 'jeanne')).retire).toBe(true);
  });

  it('refuse à quiconque d’autre — le reste de la famille n’a aucune autorité', async () => {
    const { service } = serviceAvec(MESSAGE, 2);
    const resultat = await service.removeMessage(FAMILY, 'm1', 'lucas');
    expect(resultat.retire).toBe(false);
    expect(resultat.raison).toBe('autorite');
  });

  it('ne fuite rien sur un message d’une autre famille', async () => {
    const { service } = serviceAvec(null, 0);
    expect((await service.removeMessage(FAMILY, 'm1', 'claire')).raison).toBe('introuvable');
  });

  it('emporte le fil avec sa dernière parole', async () => {
    // Ouvrir un fil, c'est y parler ; un fil vide n'existe pas.
    const { service, trace } = serviceAvec(MESSAGE, 0);
    const resultat = await service.removeMessage(FAMILY, 'm1', 'claire');
    expect(resultat.filSupprime).toBe(true);
    expect(trace).toEqual(['message supprimé', 'fil supprimé']);
  });

  it('remet le compteur d’aplomb quand le fil survit', async () => {
    // Le compteur est dénormalisé : s'il ne bouge pas dans la même
    // transaction, il ment dès la première suppression.
    const { service, trace } = serviceAvec(MESSAGE, 3);
    await service.removeMessage(FAMILY, 'm1', 'claire');
    expect(trace).toContain('compteur → 3');
  });
});
