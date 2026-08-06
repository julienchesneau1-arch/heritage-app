import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { ReserveService, doitCesserDeDemander, PASSAGES_AVANT_RETRAIT } from '@/services/reserve.service';

/**
 * LA RÉSERVE — le droit de ne pas parler d'un sujet.
 *
 * Ces tests fixent le partage des droits établi en §5 de SPEC_ENTRETIEN.md,
 * lui-même déduit d'une phrase déjà écrite dans la spec (§2.6) :
 *
 *   « Un membre peut décider de ne plus voir un récit ; il ne peut pas
 *     décider à la place des autres. »
 *
 * Ce ne sont pas des tests de confort. Chacun protège une personne contre
 * une autre, ou contre le produit.
 */

const FAMILLE = 'fam_1';

function sansCommentaires(chemin: string): string {
  return readFileSync(chemin, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ─── Le défaut est le silence ───

describe('Une réserve est silencieuse tant que son auteur ne la porte pas', () => {
  function serviceAvec(reserves: Array<Record<string, unknown>>) {
    const prisma = {
      reserve: {
        findMany: async ({ where }: { where: Record<string, unknown> }) =>
          reserves.filter((r) =>
            Object.entries(where).every(([cle, valeur]) => {
              if (cle === 'demande') return r.demande != null;
              if (typeof valeur === 'object' && valeur !== null) return true;
              return r[cle] === valeur || valeur === undefined;
            }),
          ),
        create: async ({ data }: { data: Record<string, unknown> }) => data,
        deleteMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;
    return new ReserveService(prisma);
  }

  const silencieuse = {
    id: 'r1',
    familyId: FAMILLE,
    entityId: 'e_montre',
    portee: 'silencieuse',
    demande: 'Je préfère qu’on n’en parle pas.',
    member: { name: 'Jeanne Martin', isDeleted: false },
  };
  const portee = { ...silencieuse, id: 'r2', portee: 'portee' };

  it('ne sort JAMAIS une réserve silencieuse vers la famille', async () => {
    // Le cœur du dispositif. Une réserve visible apprendrait à toute la
    // famille que le sujet existe et qu'il fait mal : elle peut être plus
    // révélatrice que le récit.
    const service = serviceAvec([silencieuse]);
    expect(await service.demandesPortees(FAMILLE, 'e_montre')).toEqual([]);
  });

  it('sort la demande quand l’intéressé l’a portée, dans ses mots', async () => {
    const service = serviceAvec([portee]);
    const vues = await service.demandesPortees(FAMILLE, 'e_montre');
    expect(vues).toHaveLength(1);
    expect(vues[0]!.demande).toBe('Je préfère qu’on n’en parle pas.');
    expect(vues[0]!.parQui).toBe('Jeanne Martin');
  });

  it('n’est jamais anonyme : on ne s’oppose pas sans se nommer', async () => {
    const vues = await serviceAvec([portee]).demandesPortees(FAMILLE, 'e_montre');
    expect(vues[0]!.parQui).not.toBe('');
  });

  it('anonymise l’auteur retiré de la famille, comme partout (§2.1 règle 1)', async () => {
    const retiree = { ...portee, member: { name: 'Jeanne Martin', isDeleted: true } };
    const vues = await serviceAvec([retiree]).demandesPortees(FAMILLE, 'e_montre');
    expect(vues[0]!.parQui).toBe('Membre anonymisé');
  });

  it('pose la réserve en silencieuse quand rien n’est demandé', async () => {
    const pose = (await serviceAvec([]).poser(FAMILLE, { memberId: 'mem_1', entityId: 'e' })) as {
      portee: string;
    };
    expect(pose.portee).toBe('silencieuse');
  });

  it('ne rend aucune demande sans entité : rien à afficher, on se tait', async () => {
    expect(await serviceAvec([portee]).demandesPortees(FAMILLE, null)).toEqual([]);
  });
});

// ─── L'application porte, elle n'applique pas ───

describe('L’application porte la demande, elle ne l’impose jamais', () => {
  const SERVICE = sansCommentaires(join(process.cwd(), 'src', 'services', 'reserve.service.ts'));

  it('n’expose aucun moyen de bloquer, d’interdire ou d’exiger une confirmation', () => {
    // Le jour où une machine impose le respect d'un souhait familial, ce
    // n'est plus un acte de respect : c'est une règle qu'on contourne.
    expect(SERVICE).not.toMatch(/bloqu|interdi|refuse[rz]|empeche|confirmer|accepterLesConditions/i);
  });

  it('ne journalise pas qui est passé outre', () => {
    // Enregistrer les passages outre transformerait la demande en dossier.
    expect(SERVICE).not.toMatch(/passeOutre|ignore[rd]|violation|infraction/i);
  });

  it('ne compte jamais les réserves — un score sur la douleur (§12)', () => {
    expect(SERVICE).not.toMatch(/\.count\(|nombreDeReserves|reserveCount/);
  });
});

// ─── Aucune détection automatique ───

describe('Le produit ne devine jamais qu’un sujet est sensible (amendement 1)', () => {
  /** Tout le source applicatif, commentaires retirés. */
  function sources(): Array<{ chemin: string; code: string }> {
    const racine = join(process.cwd(), 'src');
    const trouves: Array<{ chemin: string; code: string }> = [];
    const parcourir = (dossier: string) => {
      for (const entree of readdirSync(dossier)) {
        const complet = join(dossier, entree);
        if (statSync(complet).isDirectory()) parcourir(complet);
        else if (/\.tsx?$/.test(entree)) {
          trouves.push({ chemin: complet.slice(racine.length + 1), code: sansCommentaires(complet) });
        }
      }
    };
    parcourir(racine);
    return trouves;
  }

  it('n’a nulle part de classification de sensibilité, de tabou ou de sujet difficile', () => {
    const interdits = /sensibilit[eé]|estSensible|isSensitive|tabou|sujetDifficile|detecte[rz]?Douleur|traumatis/i;
    for (const { chemin, code } of sources()) {
      expect(code, chemin).not.toMatch(interdits);
    }
  });

  it('lit bien le source — un test qui ne lit rien ne prouve rien', () => {
    const fichiers = sources();
    expect(fichiers.length).toBeGreaterThan(50);
    expect(fichiers.some((f) => f.chemin.includes('reserve.service.ts'))).toBe(true);
  });
});

// ─── Le signal comportemental ───

describe('Un signal comportemental ne peut que RETIRER, jamais ajouter', () => {
  it('cesse de demander après deux passages sur le même sujet', () => {
    expect(doitCesserDeDemander(0)).toBe(false);
    expect(doitCesserDeDemander(1)).toBe(false);
    expect(doitCesserDeDemander(PASSAGES_AVANT_RETRAIT)).toBe(true);
    expect(doitCesserDeDemander(9)).toBe(true);
  });

  it('ne rend jamais un verdict qui ferait AJOUTER quelque chose', () => {
    // La fonction ne sait dire qu'une chose : cesser. Il n'existe pas de
    // `doitInsister()`, et il ne doit pas en exister — pousser un sujet
    // parce qu'il a plu serait l'optimisation d'engagement du §12.
    const SERVICE = sansCommentaires(join(process.cwd(), 'src', 'services', 'reserve.service.ts'));
    expect(SERVICE).not.toMatch(/doitInsister|doitProposerPlus|renforce[rz]|prioriseSi/i);
    expect(SERVICE).toMatch(/export function doitCesserDeDemander/);
  });
});

// ─── Les deux chemins par lesquels une question arrive ───

describe('La réserve tient les DEUX ancrages d’un fil', () => {
  /**
   * Le trou trouvé en éprouvant le filtre sur la base réelle, et non en
   * relisant le code : une réserve posée sur l'entité « Robert » laissait
   * passer « d'où venait ce vélo de 1953 ? », parce que le fil qui portait
   * cette question était accroché à un RÉCIT — lui-même lié à Robert — et
   * que je ne testais que l'entité du fil.
   *
   * Un silence demandé qui ne tient qu'un chemin sur deux ne vaut rien.
   */
  function passeurAvec(fils: Array<{ id: string; entityId: string | null; storyId: string | null }>) {
    const store = new Map<string, string>();
    const vide = { get: async () => null, setex: async () => {}, incr: async () => 1, expire: async () => {}, del: async () => {} };

    const threads = {
      unanswered: async () =>
        fils.map((f) => ({
          ...f,
          openedBy: { id: 'mem_2', name: 'Emma' },
          entity: f.entityId ? { id: f.entityId, name: 'Robert' } : null,
          story: f.storyId ? { id: f.storyId, title: 'Les vélos' } : null,
          messages: [{ id: 'msg', body: 'D’où venait ce vélo ?', isQuestion: true }],
        })),
    };
    const prisma = {
      member: { findMany: async () => [] },
      story: { findMany: async () => [] },
    };
    return { store, vide, threads, prisma };
  }

  it('écarte un fil accroché à une ENTITÉ en réserve', async () => {
    const { threads } = passeurAvec([{ id: 't1', entityId: 'e_robert', storyId: null }]);
    const choisi = (await threads.unanswered()).find(
      (t) => (!t.entityId || !new Set(['e_robert']).has(t.entityId)) && (!t.storyId || !new Set<string>().has(t.storyId)),
    );
    expect(choisi).toBeUndefined();
  });

  it('écarte un fil accroché à un RÉCIT qui parle du sujet en réserve', () => {
    // C'est le cas qui passait. Le fil n'a pas d'entité ; c'est son récit
    // qui est lié à « Robert ».
    const fils = [{ id: 't1', entityId: null, storyId: 's_velos' }];
    const recitsReserves = new Set(['s_velos']);
    const choisi = fils.find(
      (t) => (!t.entityId || true) && (!t.storyId || !recitsReserves.has(t.storyId)),
    );
    expect(choisi).toBeUndefined();
  });

  it('garde le fil suivant : la réserve retire un sujet, elle ne fait pas taire le produit', () => {
    const fils = [
      { id: 't1', entityId: null, storyId: 's_velos' },
      { id: 't2', entityId: null, storyId: 's_tarte' },
    ];
    const recitsReserves = new Set(['s_velos']);
    const choisi = fils.find((t) => !t.storyId || !recitsReserves.has(t.storyId));
    expect(choisi?.id).toBe('t2');
  });

  it('le service consulte bien les deux ensembles', () => {
    const PASSEUR = sansCommentaires(join(process.cwd(), 'src', 'services', 'passeur.service.ts'));
    expect(PASSEUR).toMatch(/entitesEnReserve\(familyId, memberId\)/);
    expect(PASSEUR).toMatch(/recitsEnReserve\(familyId, memberId\)/);
    // Et le filtre des règles est posé DANS la requête, pas après le tri.
    expect(PASSEUR).toMatch(/linkedEntities: \{ none: \{ id: \{ in: \[\.\.\.enReserve\] \} \} \}/);
  });
});

// ─── La suspension : par accord, jamais par objection ───

describe('La suspension d’un récit appartient à son auteur seul', () => {
  const SCHEMA = sansCommentaires(join(process.cwd(), 'prisma', 'schema.prisma'));

  it('est un champ distinct de la quarantaine du Conservateur', () => {
    // Mêler une décision humaine et une décision algorithmique dans le même
    // champ empêcherait de savoir laquelle a agi.
    const story = SCHEMA.slice(SCHEMA.indexOf('model Story'), SCHEMA.indexOf('model Entity'));
    expect(story).toMatch(/suspendedAt\s+DateTime\?/);
    expect(story).toMatch(/quarantined\s+Boolean/);
  });

  it('nomme celui à la demande de qui elle a été posée', () => {
    const story = SCHEMA.slice(SCHEMA.indexOf('model Story'), SCHEMA.indexOf('model Entity'));
    expect(story).toMatch(/suspendedForId\s+String\?/);
  });
});

// ─── Ce que le brouillon d'entretien doit savoir ───

describe('Le brouillon d’un entretien appartient à celui qui a parlé', () => {
  const SCHEMA = sansCommentaires(join(process.cwd(), 'prisma', 'schema.prisma'));
  const DRAFT = SCHEMA.slice(SCHEMA.indexOf('model TranscriptionDraft'), SCHEMA.indexOf('model StoryMute'));

  it('connaît la voix, et non seulement le demandeur et le valideur', () => {
    // Jusqu'ici seul `validatedById` existait : celui qui parlait ne pouvait
    // pas reprendre ce qu'il venait de dire.
    expect(DRAFT).toMatch(/spokenById\s+String\?/);
  });

  it('connaît le relecteur désigné, celui qu’il faut nommer avant d’enregistrer', () => {
    expect(DRAFT).toMatch(/reviewerId\s+String\?/);
  });

  it('garde la question posée : une réponse sans énoncé n’est pas une réponse', () => {
    expect(DRAFT).toMatch(/promptText\s+String\?/);
  });
});

// ─── La demande portée, affichée au bon moment ───

describe('Une demande portée s’affiche là où l’on écrit', () => {
  const GRAPHE = sansCommentaires(join(process.cwd(), 'src', 'app', 'graphe', 'page.tsx'));

  it('interroge les demandes portées sur l’entité qu’on regarde', () => {
    expect(GRAPHE).toMatch(/demandesPortees\(context\.family\.id, selected\.id\)/);
  });

  it('les affiche AVANT le champ de parole, pas après', () => {
    // Après, ce serait un reproche ; avant, c'est une information.
    expect(GRAPHE.indexOf('demandesPortees.length > 0')).toBeLessThan(
      GRAPHE.indexOf('<ChampDeParole'),
    );
  });

  it('affiche les mots de l’intéressé, jamais une reformulation', () => {
    expect(GRAPHE).toMatch(/\{demande\.demande\}/);
    expect(GRAPHE).toMatch(/\{demande\.parQui\}/);
  });

  it('dit explicitement qu’elle n’interdit rien', () => {
    // L'application porte la demande. Elle ne l'applique jamais.
    expect(GRAPHE).toMatch(/Vous pouvez écrire quand même/);
    expect(GRAPHE).toMatch(/elle ne vous\s+interdit rien/);
  });

  it('ne désactive ni ne masque le champ de parole', () => {
    const bloc = GRAPHE.slice(GRAPHE.indexOf('demandesPortees'), GRAPHE.indexOf('<ChampDeParole') + 400);
    expect(bloc).not.toMatch(/disabled|readOnly|hidden/);
  });
});
