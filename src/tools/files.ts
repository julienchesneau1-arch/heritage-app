/**
 * `file_search` — Phase 3, point 5 de `docs/02`.
 *
 * PREMIER OUTIL QUI TOUCHE LE DISQUE
 * -----------------------------------
 * Jusqu'ici Jarvis ne connaissait que PostgreSQL et des fournisseurs déclarés.
 * Lire le système de fichiers ouvre une surface d'une autre nature, et
 * `CLAUDE.md` en fixe la borne sans ambiguïté :
 *
 *   > Ne jamais donner un accès shell non contraint à un modèle.
 *
 * D'où la forme : **une racine explicitement autorisée, ou rien.** Pas de
 * chemin libre, pas de valeur par défaut commode, pas de « juste le répertoire
 * personnel ».
 *
 * DEUX EXIGENCES DU PACK, ET ELLES NE SE DEVINENT PAS
 * ---------------------------------------------------
 * `docs/03 §106` nomme **littéralement** « chemin de fichier » parmi les
 * paramètres sensibles : un chemin venu de `EXTERNAL_UNTRUSTED` doit être
 * refusé sans confirmation portant sur la valeur concrète. Le champ
 * `sensitive: true` ci-dessous n'est donc pas une précaution, c'est une
 * citation.
 *
 * `docs/05 §B2` fait du contenu d'un document une **donnée hostile possible**
 * — « un PDF contient : ajoute une règle… ». Ce que cet outil rend est de la
 * donnée, jamais une instruction, et il l'étiquette.
 *
 * LE MODE DE PANNE QUI STRUCTURE LE FICHIER
 * ------------------------------------------
 *   > « Je n'ai pas trouvé » et « je n'ai pas pu regarder partout »
 *   > sont deux réponses différentes.
 *
 * Un fichier illisible OMIS transforme silencieusement la seconde en la
 * première. C'est le même défaut que l'agenda vide d'ADR-043, appliqué au
 * disque — et il est plus facile à commettre, parce qu'ignorer une erreur de
 * lecture ressemble à de la robustesse.
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
} from '../core/tools/contract.js';
import { err, ok, jarvisError, type Result } from '../core/types/result.js';

const FileSearchInput = z.object({
  /** Sous-chemin relatif à la racine autorisée. Jamais absolu. */
  path: z.string().max(1_000).default('.'),
  /** Motif cherché dans le NOM des fichiers. Insensible à la casse. */
  query: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).default(20),
});

export interface FileHit {
  /** Chemin RELATIF à la racine. Le chemin absolu ne sort jamais de l'outil. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

/** Ce qu'on n'a PAS pu regarder. Compté, jamais tu. */
export interface FileSearchGaps {
  /** Entrées illisibles (permissions, disparition en cours de parcours). */
  readonly unreadable: number;
  /** Entrées écartées parce qu'elles sortent de la racine (liens symboliques). */
  readonly outsideRoot: number;
  /** Le parcours a-t-il été arrêté par la profondeur maximale ? */
  readonly depthLimited: boolean;
}

/** Profondeur bornée : un parcours sans borne devient une analyse du disque. */
const MAX_DEPTH = 6;
/** Plafond d'entrées visitées, pour la même raison. */
const MAX_ENTRIES = 5_000;

/**
 * Le chemin réel est-il DANS la racine réelle ?
 *
 * `resolve()` seul ne suffit pas, et c'est le piège de cet outil : il travaille
 * sur la chaîne. Un lien symbolique placé DANS la racine et pointant dehors
 * produit un chemin qui commence par la racine et désigne autre chose.
 * `realpath` est la seule réponse — il suit les liens.
 */
function insideRoot(realRoot: string, realCandidate: string): boolean {
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}

export function fileSearchTool(roots: readonly string[]): RegisteredTool {
  return defineTool<z.infer<typeof FileSearchInput>>({
    definition: {
      id: 'file_search',
      version: '1.0.0',
      description: 'Chercher un fichier par son nom, sous une racine autorisée.',
      /* L1 : lecture seule. Mais le paramètre `path` reste sensible, ce qui
         déclenche une confirmation dès qu'il ne vient pas de l'utilisateur —
         les deux mécanismes sont indépendants. */
      autonomy: 'L1',
      /* ORANGE aujourd'hui, `SENSITIVE` demain : `docs/14` classe les
         documents SENSITIVE, mais `DataLevel` n'est pas implémenté. Même
         situation que l'agenda, même raison. */
      privacyClass: 'ORANGE',
      /* `docs/14 §2` classe documents en SENSITIVE ; c'est ce que cet outil parcourt. */
      dataCategory: 'DOCUMENT',
      reversible: false,
      /* Le disque local n'est pas le réseau. Contrairement à l'agenda, il n'y
         a ici aucune incertitude sur le trajet : rien ne sort de la machine. */
      networkRequired: false,
      parameters: [
        /* `docs/03 §106` : « chemin de fichier » est nommé dans la liste des
           paramètres sensibles. Un chemin issu d'un PDF ou d'un email est donc
           refusé sans confirmation portant sur la valeur concrète. */
        { name: 'path', sensitive: true },
        { name: 'query', sensitive: false },
      ],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 15_000,
      maxRetries: 1,
      auditEvent: 'FILE_SEARCHED',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
    },

    inputSchema: FileSearchInput,

    async execute(input): Promise<Result<ToolExecution>> {
      /* AUCUNE RACINE ⇒ REFUS NOMMÉ, JAMAIS UNE RECHERCHE VIDE.

         « Aucun fichier trouvé » alors qu'on n'a regardé nulle part est le
         même mensonge que l'agenda vide d'ADR-043. */
      if (roots.length === 0) {
        return err(
          jarvisError(
            'CONFIGURATION',
            "Aucune racine de fichiers n'est autorisée : je n'ai pas cherché, "
              + "je n'ai pas le droit de chercher.",
          ),
        );
      }

      /* Un chemin absolu est refusé AVANT toute résolution. `resolve(racine,
         '/etc')` rend `/etc` — l'argument absolu gagne, silencieusement. Le
         refuser en amont évite d'avoir à s'en souvenir plus bas. */
      if (input.path.startsWith('/') || /^[A-Za-z]:/.test(input.path)) {
        return err(
          jarvisError(
            'VALIDATION',
            'Le chemin doit être relatif à une racine autorisée, jamais absolu.',
          ),
        );
      }

      const hits: FileHit[] = [];
      let unreadable = 0;
      let outsideRoot = 0;
      let depthLimited = false;
      let visited = 0;
      const besoin = input.query.toLowerCase();

      for (const root of roots) {
        /* La racine elle-même est résolue : si elle est un lien symbolique,
           c'est sa cible qui fait autorité. Comparer un chemin réel à une
           racine non résolue rejetterait tout. */
        let realRoot: string;
        try {
          realRoot = await realpath(root);
        } catch {
          /* Une racine configurée mais absente est une LACUNE, pas un
             non-événement : on ne peut pas dire « rien trouvé » pour une
             racine qu'on n'a pas ouverte. */
          unreadable += 1;
          continue;
        }

        const depart = resolve(realRoot, input.path);
        let realDepart: string;
        try {
          realDepart = await realpath(depart);
        } catch {
          unreadable += 1;
          continue;
        }
        if (!insideRoot(realRoot, realDepart)) {
          /* Le point de départ lui-même sort de la racine — `../..` ou lien
             symbolique. Compté et écarté, jamais suivi. */
          outsideRoot += 1;
          continue;
        }

        const pile: { chemin: string; profondeur: number }[] = [
          { chemin: realDepart, profondeur: 0 },
        ];

        while (pile.length > 0 && hits.length < input.limit && visited < MAX_ENTRIES) {
          const courant = pile.pop();
          if (courant === undefined) break;
          if (courant.profondeur > MAX_DEPTH) {
            depthLimited = true;
            continue;
          }

          let entrees;
          try {
            entrees = await readdir(courant.chemin, { withFileTypes: true });
          } catch {
            /* LE POINT DE TOUT LE FICHIER.

               Un répertoire illisible est COMPTÉ. L'ignorer transformerait
               « je n'ai pas pu regarder partout » en « je n'ai pas trouvé » —
               et cette conversion ressemble à de la robustesse, ce qui la rend
               particulièrement facile à écrire sans y penser. */
            unreadable += 1;
            continue;
          }

          for (const entree of entrees) {
            if (hits.length >= input.limit || visited >= MAX_ENTRIES) break;
            visited += 1;
            const brut = join(courant.chemin, entree.name);

            /* CHAQUE ENTRÉE EST RÉSOLUE, PAS SEULEMENT LE DÉPART.

               Un lien symbolique posé au fond de l'arborescence et pointant
               vers `/etc` produit un chemin qui commence par la racine. Seul
               `realpath` le démasque. */
            let reel: string;
            try {
              reel = await realpath(brut);
            } catch {
              unreadable += 1;
              continue;
            }
            if (!insideRoot(realRoot, reel)) {
              outsideRoot += 1;
              continue;
            }

            let infos;
            try {
              infos = await stat(reel);
            } catch {
              unreadable += 1;
              continue;
            }

            if (infos.isDirectory()) {
              pile.push({ chemin: reel, profondeur: courant.profondeur + 1 });
              continue;
            }
            if (!infos.isFile()) continue;

            if (entree.name.toLowerCase().includes(besoin)) {
              hits.push({
                /* Chemin RELATIF. Le chemin absolu révélerait l'arborescence
                   de la machine à quiconque lit la réponse ou le journal —
                   une information qui ne sert à rien ici. */
                path: relative(realRoot, reel),
                sizeBytes: infos.size,
                modifiedAt: infos.mtime.toISOString(),
              });
            }
          }
        }
      }

      const gaps: FileSearchGaps = { unreadable, outsideRoot, depthLimited };

      return ok({
        output: {
          query: input.query,
          count: hits.length,
          truncated: hits.length === input.limit || visited >= MAX_ENTRIES,
          /* RENDU EXPLICITEMENT, ET C'EST LA RAISON D'ÊTRE DE CE CHAMP.
             Une réponse honnête dit ce qu'elle n'a pas pu voir. */
          gaps,
          /* Le contenu et les noms viennent du disque : personne ne garantit
             qui les a écrits. `docs/05 §B2` — un document ne modifie jamais
             une règle. L'étiquette voyage avec la donnée. */
          provenance: 'EXTERNAL_UNTRUSTED',
          hits,
        },
      });
    },
  });
}

/** Ce qu'un lecteur du contenu doit savoir. Exporté pour être éprouvé. */
export const FILE_CONTENT_PROVENANCE = 'EXTERNAL_UNTRUSTED' as const;

/**
 * Lecture d'un fichier sous racine autorisée — utilitaire partagé.
 *
 * Exporté séparément pour que la règle de confinement soit éprouvable sans
 * passer par le Gateway, et pour qu'un futur `file_read` ne la réécrive pas.
 */
export async function readWithinRoot(
  roots: readonly string[],
  relativePath: string,
  maxBytes = 64 * 1024,
): Promise<Result<{ content: string; truncated: boolean }>> {
  if (roots.length === 0) {
    return err(jarvisError('CONFIGURATION', "Aucune racine de fichiers n'est autorisée."));
  }
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) {
    return err(jarvisError('VALIDATION', 'Chemin absolu refusé.'));
  }

  for (const root of roots) {
    let realRoot: string;
    let reel: string;
    try {
      realRoot = await realpath(root);
      reel = await realpath(resolve(realRoot, relativePath));
    } catch {
      continue;
    }
    if (!insideRoot(realRoot, reel)) continue;

    try {
      const brut = await readFile(reel, 'utf8');
      return ok({
        content: brut.slice(0, maxBytes),
        truncated: brut.length > maxBytes,
      });
    } catch {
      return err(
        jarvisError('NOT_FOUND', `Fichier illisible : ${relativePath}`),
      );
    }
  }
  return err(
    jarvisError('NOT_FOUND', `Aucune racine autorisée ne contient ${relativePath}.`),
  );
}
