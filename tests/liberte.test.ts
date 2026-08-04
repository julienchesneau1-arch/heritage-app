import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { ThreadService, voixDe } from '@/services/thread.service';
import { FamilyService } from '@/services/family.service';
import { memberSchema } from '@/lib/validation';

/**
 * « QUE CHAQUE ÊTRE SE SENTE LIBRE DE TOUT DANS CETTE APP »
 *
 * Quatre manquements, trouvés en relisant le produit contre la Constitution
 * et vérifiés sur la base réelle avant d'être corrigés :
 *
 *  1. Supprimer un récit détruisait la parole des AUTRES. `Thread.story`
 *     portait `onDelete: Cascade` : effacer « La montre arrêtée » effaçait
 *     la question qu'Emma avait posée dessous. On ne se sent pas libre de
 *     retirer ses mots si les retirer emporte ceux d'un proche (§2.1).
 *  2. Un membre retiré gardait son nom dans les fils. La §2.1 règle 1 dit
 *     « anonymisé » — elle ne dit pas « anonymisé dans les récits ».
 *  3. Le lien familial EST le secret de la §4.1, et n'avait aucune
 *     révocation. Publié par erreur, il l'était pour toujours.
 *  4. Le flux `.ics` part chez Google ou Apple. On peut vouloir appartenir
 *     à la mémoire de sa famille sans que sa date de naissance en sorte.
 */

const FAMILY = 'fam_1';

/** Le code sans ses commentaires : sinon on teste sa propre documentation. */
function source(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const SCHEMA = source('prisma', 'schema.prisma');

// ─── 1. Supprimer ses mots n'emporte pas ceux des autres ───

describe('La suppression d’un récit ne détruit pas la parole des autres', () => {
  it('détache le fil au lieu de le supprimer', () => {
    // Vérifié sur la base réelle : après suppression de « La montre
    // arrêtée », la question d'Emma subsiste et `story_id` vaut NULL.
    const thread = SCHEMA.slice(SCHEMA.indexOf('model Thread'), SCHEMA.indexOf('model Message'));
    expect(thread).toMatch(/story\s+Story\?[^\n]*onDelete: SetNull/);
    expect(thread).toMatch(/entity\s+Entity\?[^\n]*onDelete: SetNull/);
    expect(thread).not.toMatch(/story\s+Story\?[^\n]*onDelete: Cascade/);
  });

  it('garde le Cascade là où il détruit la parole de son seul auteur', () => {
    // Un message appartient à son fil : le fil parti, il n'a plus de lieu.
    const message = SCHEMA.slice(SCHEMA.indexOf('model Message'), SCHEMA.indexOf('model MessageMark'));
    expect(message).toMatch(/thread\s+Thread[^\n]*onDelete: Cascade/);
  });
});

describe('Retirer un message : le sien, et seulement le sien', () => {
  function serviceWith(message: Record<string, unknown> | null, restants: number) {
    const supprimes: string[] = [];
    const prisma = {
      message: {
        findFirst: async () => message,
        count: async () => restants,
      },
      thread: { update: async () => ({}), delete: async () => ({}) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          message: {
            delete: async ({ where }: { where: { id: string } }) => {
              supprimes.push(where.id);
              return {};
            },
            count: async () => restants,
            findFirst: async () => ({ createdAt: new Date(2026, 0, 1) }),
          },
          thread: {
            update: async () => ({}),
            delete: async ({ where }: { where: { id: string } }) => {
              supprimes.push(`thread:${where.id}`);
              return {};
            },
          },
        }),
    } as unknown as PrismaClient;
    return { service: new ThreadService(prisma), supprimes };
  }

  const MESSAGE = { id: 'msg_1', threadId: 'thr_1', authorId: 'claire', narratorId: 'jeanne' };

  it('l’auteur peut retirer ses mots', async () => {
    const { service, supprimes } = serviceWith(MESSAGE, 2);
    expect(await service.removeMessage(FAMILY, 'msg_1', 'claire')).toEqual({
      retire: true,
      filSupprime: false,
    });
    expect(supprimes).toContain('msg_1');
  });

  it('le narrateur aussi : ce sont ses paroles, même saisies par un autre', async () => {
    // §2.3 : la voix appartient à qui a parlé, pas à qui a tapé.
    const { service } = serviceWith(MESSAGE, 2);
    expect((await service.removeMessage(FAMILY, 'msg_1', 'jeanne')).retire).toBe(true);
  });

  it('personne d’autre', async () => {
    const { service, supprimes } = serviceWith(MESSAGE, 2);
    expect(await service.removeMessage(FAMILY, 'msg_1', 'lucas')).toEqual({
      retire: false,
      filSupprime: false,
      raison: 'autorite',
    });
    expect(supprimes).toHaveLength(0);
  });

  it('ne dit pas non plus qu’un message d’une autre famille existe', async () => {
    const { service } = serviceWith(null, 0);
    expect((await service.removeMessage(FAMILY, 'msg_1', 'claire')).raison).toBe('introuvable');
  });

  it('le fil s’efface avec sa dernière parole', async () => {
    const { service, supprimes } = serviceWith(MESSAGE, 0);
    expect(await service.removeMessage(FAMILY, 'msg_1', 'claire')).toEqual({
      retire: true,
      filSupprime: true,
    });
    expect(supprimes).toContain('thread:thr_1');
  });
});

// ─── 2. Un membre retiré est anonymisé PARTOUT ───

describe('Le retrait de la famille vaut aussi dans les fils', () => {
  const vivant = { id: 'claire', name: 'Claire Martin', isDeleted: false };
  const retire = { id: 'jeanne', name: 'Jeanne Martin', isDeleted: true };

  it('anonymise l’auteur retiré', () => {
    expect(voixDe({ author: retire, narrator: null })).toEqual({
      id: 'jeanne',
      nom: 'Membre anonymisé',
      anonymise: true,
    });
  });

  it('anonymise le narrateur retiré, même si le clavier était à quelqu’un d’autre', () => {
    // Le trou par lequel un nom survivait : la voix vient du narrateur, et
    // c'est son `isDeleted` qui compte, pas celui de qui a saisi.
    expect(voixDe({ author: vivant, narrator: retire }).nom).toBe('Membre anonymisé');
  });

  it('n’anonymise pas le narrateur vivant d’un auteur retiré', () => {
    expect(voixDe({ author: retire, narrator: vivant }).nom).toBe('Claire Martin');
  });

  it('laisse les vivants sous leur nom', () => {
    expect(voixDe({ author: vivant, narrator: null })).toEqual({
      id: 'claire',
      nom: 'Claire Martin',
      anonymise: false,
    });
  });

  it('lit `isDeleted` en base : sans ce champ, aucune anonymisation n’est possible', () => {
    const service = source('src', 'services', 'thread.service.ts');
    const narrateur = service.slice(service.indexOf('narrator: { select:'));
    expect(narrateur.slice(0, 120)).toMatch(/isDeleted: true/);
  });
});

// ─── 3. Le lien familial se change ───

describe('Un lien familial publié par erreur peut être coupé', () => {
  it('la page Famille propose de le changer', () => {
    const page = source('src', 'app', 'famille', 'page.tsx');
    expect(page).toMatch(/rotateFamilyLink/);
  });

  it('l’autorisation d’API confronte la version à la base, pas à la seule signature', () => {
    // Une signature reste valide après rotation : seule la version en base
    // distingue l'ancien lien du nouveau.
    const session = source('src', 'lib', 'session.ts');
    expect(session).toMatch(/authorizeFamily[\s\S]{0,600}versionCourante\(familyId\)/);
    expect(session).toMatch(/currentFamilyId[\s\S]{0,400}versionCourante\(jeton\.familyId\)/);
  });

  it('la famille porte un numéro de version', () => {
    const family = SCHEMA.slice(SCHEMA.indexOf('model Family'), SCHEMA.indexOf('model Member'));
    expect(family).toMatch(/tokenVersion\s+Int\s+@default\(1\)/);
  });
});

// ─── 4. Sortir du calendrier sans sortir de la mémoire ───

describe('On peut appartenir à la mémoire sans figurer au calendrier', () => {
  it('le retrait est enregistré, et non seulement affiché', () => {
    // La case existait avant ce correctif ; rien ne la sauvegardait. Un
    // contrôle qui ne fait rien est pire qu'un contrôle absent.
    const parsed = memberSchema.parse({ name: 'Jeanne', generation: 1, calendarOptOut: true });
    expect(parsed.calendarOptOut).toBe(true);
  });

  it('par défaut on y figure : une migration ne retire personne en silence', () => {
    expect(memberSchema.parse({ name: 'Jeanne', generation: 1 }).calendarOptOut).toBe(false);
  });

  it('le service porte le champ jusqu’à la base', async () => {
    let data: Record<string, unknown> | undefined;
    const prisma = {
      member: {
        updateMany: async ({ data: d }: { data: Record<string, unknown> }) => {
          data = d;
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    await new FamilyService(prisma).updateMember(FAMILY, 'mem_1', {
      name: 'Jeanne',
      generation: 1,
      calendarOptOut: true,
    });
    expect(data?.calendarOptOut).toBe(true);
  });

  it('le flux `.ics` filtre à la source', () => {
    // Filtrer dans `familyEvents` laisserait la porte ouverte à un futur
    // appelant qui l'oublierait. La requête elle-même ne les charge pas.
    const route = source(
      'src', 'app', 'api', 'calendrier', '[memberId]', '[token]', 'heritage.ics', 'route.ts',
    );
    expect(route).toMatch(/member\.findMany[\s\S]{0,200}calendarOptOut: false/);
  });

  it('le membre reste partout ailleurs : le retrait ne vaut que pour le flux', () => {
    const member = SCHEMA.slice(SCHEMA.indexOf('model Member'), SCHEMA.indexOf('model Story'));
    expect(member).toMatch(/calendarOptOut\s+Boolean\s+@default\(false\)/);
    // Ce n'est pas un soft-delete déguisé : `isDeleted` existe à part.
    expect(member).toMatch(/isDeleted\s+Boolean/);
  });
});
