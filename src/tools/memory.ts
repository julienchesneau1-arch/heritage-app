/**
 * Outils mémoire : `memory_add` et `memory_search`.
 *
 * Référence : 02 Phase 2, 03 §10.
 *
 * `memory_add` n'écrit PAS en base : il passe par le Memory Guard. Un outil
 * qui contournerait le Guard rouvrirait l'empoisonnement de mémoire (03 §11),
 * et c'est précisément le genre de raccourci que le contrat d'outil existe pour
 * empêcher.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
  type VerificationOutcome,
} from '../core/tools/contract.js';
import { verificationOutcome } from '../core/verification/engine.js';
import {
  describeTargets,
  projectStatus,
  type TargetOutcome,
} from '../core/tools/outcome.js';
import type { MemoryGuard } from '../core/memory/guard.js';
import type { MemoryStore } from '../core/memory/store.js';
import type { HybridSearch } from '../core/memory/search.js';
import { DataCategory, SourceType } from '../core/types/domain.js';
import { MemoryType } from '../core/memory/types.js';
import { ok, type Result } from '../core/types/result.js';

/* -------------------------------------------------------------------------- */
/* memory_add                                                                 */
/* -------------------------------------------------------------------------- */

const MemoryAddInput = z.object({
  content: z.string().min(1).max(4000),
  memoryType: MemoryType,
  sourceType: SourceType,
  dataCategory: DataCategory.default('OTHER'),
  source: z.string().min(1).default('conversation'),
  subjectEntityId: z.uuid().nullable().default(null),
  suggestedConfidence: z.number().min(0).max(1).default(0.6),
});

export function memoryAddTool(
  guard: MemoryGuard,
  store: MemoryStore,
  /** Le Gateway ne connaît pas la confirmation métier : elle vient de l'appelant. */
  isUserConfirmed: () => boolean,
): RegisteredTool {
  return defineTool({
    definition: {
      id: 'memory_add',
      version: '1.0.0',
      description: 'Mémoriser une information, via le Memory Guard.',
      autonomy: 'L2', // réversible, faible risque
      privacyClass: 'ORANGE',
      /* vocation de l'outil ; la catégorie RÉELLE de chaque souvenir est portée par la ligne et arbitrée par le Memory Guard. */
      dataCategory: 'PERSONAL_MEMORY',
      reversible: true,
      networkRequired: false,
      parameters: [
        { name: 'content', sensitive: false },
        { name: 'memoryType', sensitive: true },
        { name: 'sourceType', sensitive: true },
        { name: 'dataCategory', sensitive: true },
        { name: 'subjectEntityId', sensitive: true },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'MEMORY_ADDED',
      requiredSecrets: [],
      /* ⚠ CETTE PHRASE DÉCRIVAIT UN EFFACEMENT DOUX — ADR-065.
         Elle disait « marquer la mémoire DELETED ». Un état `DELETED` laisse
         `content` dans la ligne : `docs/05 §C3` exige la suppression, et dire
         « oublié » sans effacer serait une fausse confirmation portant sur une
         promesse de confidentialité. `memory_forget` supprime pour de bon. */
      rollback: 'Effacer définitivement la mémoire via memory_forget.',
      // Aucun de ces outils ne sait dire après coup si une tentative a eu un
      // effet : ils n'écrivent pas la clé d'opération dans la ressource créée.
      // La reprise conclura donc UNKNOWN, et refusera de rejouer (ADR-027).
      attemptVerification: 'NONE',
      // Écrit dans la même base que le journal d'intention : une erreur
      // signifie un rollback, donc l'absence d'effet (ADR-029).
      effect: 'LOCAL_TRANSACTIONAL',
      // PostgreSQL ferme la fenêtre d'observation : une relecture qui ne
      // trouve rien PROUVE l'absence (ADR-030).
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: MemoryAddInput,

    async execute(input): Promise<Result<ToolExecution>> {
      const verdict = await guard.propose(
        {
          memoryType: input.memoryType,
          content: input.content,
          sourceType: input.sourceType,
          source: input.source,
          dataCategory: input.dataCategory,
          subjectEntityId: input.subjectEntityId,
          suggestedConfidence: input.suggestedConfidence,
        },
        { userConfirmed: isUserConfirmed() },
      );
      if (!verdict.ok) return verdict;

      // Trois issues possibles du Guard, trois résultats d'outil distincts.
      if (verdict.value.outcome === 'QUEUED') {
        return ok({
          output: {
            outcome: 'QUEUED',
            candidateId: verdict.value.candidate.id,
            adjustments: verdict.value.adjustments,
          },
          // Aucune mémoire créée : rien à relire, rien à annuler.
        });
      }

      const memory = verdict.value.memory;
      return ok({
        output: {
          outcome: verdict.value.outcome,
          memoryId: memory.id,
          kind: memory.kind,
          confidence: memory.confidence,
          adjustments: verdict.value.adjustments,
        },
        resource: { kind: 'memory', id: memory.id },
        undo:
          verdict.value.outcome === 'STORED'
            ? {
                kind: 'INVERSE_OPERATION',
                // `memory_forget` arrivera avec l'Undo Engine. La capture est
                // un enregistrement, pas une exécution (ADR-019).
                inverseToolId: 'memory_forget',
                inverseInput: { memoryId: memory.id },
              }
            : { kind: 'NOT_UNDOABLE' }, // déduplication : rien n'a été créé
      });
    },

    async readBack(execution): Promise<Result<VerificationOutcome>> {
      if (execution.resource === undefined) {
        return ok(
          verificationOutcome.confirmed({
            observed: 'aucune mémoire à créer (mise en file ou dédupliquée)',
          }),
        );
      }
      const found = await store.getById(execution.resource.id);
      if (!found.ok) return found;
      if (found.value === null) {
        return ok(
          verificationOutcome.failed({
            observed: `La mémoire ${execution.resource.id} est introuvable après création.`,
            // La fenêtre d'observation est FERMÉE : `memories` est dans la même
            // base que le journal d'intention, et la lecture suit le commit.
            // Rien ne peut apparaître après coup (ADR-030).
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }
      return ok(
        verificationOutcome.confirmed({
          observed: `mémoire ${found.value.id} présente, crédit ${found.value.kind}`,
        }),
      );
    },
  });
}

/* -------------------------------------------------------------------------- */
/* memory_search                                                              */
/* -------------------------------------------------------------------------- */

const MemorySearchInput = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).default(10),
});

export function memorySearchTool(search: HybridSearch): RegisteredTool {
  return defineTool({
    definition: {
      id: 'memory_search',
      version: '1.0.0',
      description: 'Rechercher dans la mémoire personnelle (trois voies).',
      autonomy: 'L1', // lecture seule
      privacyClass: 'ORANGE',
      /* même vocation, en lecture. */
      dataCategory: 'PERSONAL_MEMORY',
      reversible: false,
      networkRequired: false,
      parameters: [{ name: 'query', sensitive: false }],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 5000,
      maxRetries: 2,
      auditEvent: 'MEMORY_SEARCHED',
      requiredSecrets: [],
      rollback: null, // une lecture ne se défait pas
      // Aucun de ces outils ne sait dire après coup si une tentative a eu un
      // effet : ils n'écrivent pas la clé d'opération dans la ressource créée.
      // La reprise conclura donc UNKNOWN, et refusera de rejouer (ADR-027).
      attemptVerification: 'NONE',
      // Écrit dans la même base que le journal d'intention : une erreur
      // signifie un rollback, donc l'absence d'effet (ADR-029).
      effect: 'LOCAL_TRANSACTIONAL',
      // PostgreSQL ferme la fenêtre d'observation : une relecture qui ne
      // trouve rien PROUVE l'absence (ADR-030).
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: MemorySearchInput,

    async execute(input): Promise<Result<ToolExecution>> {
      const found = await search.search({
        text: input.query,
        limit: input.limit,
      });
      if (!found.ok) return found;

      return ok({
        output: {
          results: found.value.merged.map((m) => ({
            id: m.memory.id,
            content: m.memory.content,
            kind: m.memory.kind,
            confidence: m.memory.confidence,
            lanes: m.lanes,
          })),
          // La dégradation est remontée à l'appelant : Jarvis doit pouvoir
          // dire « j'ai cherché sans la voie sémantique ».
          degraded: found.value.degraded,
          /**
           * OÙ la recherche a réellement eu lieu (HIGH-4).
           *
           * Sans ce champ, une réponse vide était indiscernable d'une
           * recherche web infructueuse. La portée n'est pas une décoration
           * d'interface : c'est une partie du résultat, et toute interface
           * doit l'afficher — y compris quand la recherche a trouvé quelque
           * chose, sinon l'utilisateur ne saura jamais ce qui n'a PAS été
           * consulté.
           */
          knowledge: {
            verdict: found.value.merged.length > 0 ? 'KNOWN' : 'UNKNOWN',
            // Une mémoire relue n'est pas pour autant re-vérifiée contre le
            // monde. `VERIFIED` exigerait une relecture de la source d'origine,
            // et `STALE` une notion de fraîcheur — l'un et l'autre attendent la
            // mémoire bitemporelle (ADR-026).
            quality: 'UNVERIFIED',
            coverage: [
              {
                source: 'mémoire personnelle',
                scope: 'IN_SCOPE',
                detail: found.value.degraded
                  ? 'consultée, sans la voie sémantique'
                  : 'consultée',
              },
              {
                source: 'web',
                scope: 'OUT_OF_SCOPE',
                detail: 'aucune capacité de recherche web',
              },
              {
                source: 'documents',
                scope: 'OUT_OF_SCOPE',
                detail: 'aucune capacité de lecture de documents',
              },
            ],
          },
          scope: 'MEMOIRE_PERSONNELLE',
          scopeLabel:
            'recherche limitée à ta mémoire personnelle — ni web, ni documents',
        },
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* memory_forget — docs/05 §C3, droit à l'oubli (CRITIQUE)                    */
/* -------------------------------------------------------------------------- */

const MemoryForgetInput = z.object({
  memoryId: z.uuid(),
});

/**
 * OUBLIER POUR DE BON — `docs/05 §C3`, le premier outil inverse écrit.
 *
 * ```
 * Attendu : mémoire + embeddings + relations + cache + dérivés supprimés ;
 *           événement MEMORY_DELETED.
 * Interdit : que le contenu supprimé survive dans le journal.
 * ```
 *
 * TROIS ARBITRAGES, ET AUCUN N'EST ANODIN — ADR-065
 * ---------------------------------------------------------------------------
 *
 * **1. Suppression RÉELLE, pas un état `DELETED`.**
 * `memory_add.rollback` annonçait « marquer la mémoire DELETED via
 * memory_forget ». Un effacement doux laisse `content` dans la ligne : dire
 * « oublié » serait alors une fausse confirmation portant sur une promesse de
 * confidentialité — la pire espèce. La règle du dépôt tranche seule : *quand
 * une exigence entre en conflit avec la sécurité, la sécurité gagne.*
 *
 * **2. `NOT_UNDOABLE`, et c'est ADR-019 respecté, pas contourné.**
 * Toute mutation capture de quoi être annulée. Ici, capturer l'état antérieur
 * reviendrait à recopier le contenu dans `action_snapshots` — c'est-à-dire à
 * ne rien oublier du tout. Le schéma avait prévu la sortie : `undo_kind`
 * accepte `NOT_UNDOABLE`. La capture EXISTE — l'opération est comptée — et ne
 * garde rien. Un oubli qu'on peut défaire n'est pas un oubli.
 *
 * **3. Le statut est PROJETÉ, jamais déclaré.**
 * La ligne mémoire part par `DELETE`, et `memory_derivatives` suit par
 * `ON DELETE CASCADE`. Restent les dérivés `cascades = false` — export,
 * sauvegarde, cache externe. Tant qu'il en survit un, la mémoire n'est pas
 * oubliée : le statut est `PARTIAL`, et il vient de `projectStatus`, pas d'une
 * décision de l'outil (`docs/19 §2` : *un outil ne peut pas se dire PARTIAL
 * pour éviter de trancher*).
 *
 * POURQUOI LE CONTENU NE PEUT PAS SURVIVRE DANS LE JOURNAL
 * --------------------------------------------------------
 * Le journal est append-only : rien n'en sort jamais. L'interdit de §C3 ne
 * tient donc que si le contenu n'y entre PAS. `event_ledger` ne porte qu'un
 * `payload_digest` — « empreinte du contenu, jamais le contenu » (`03 §12`) —
 * et cet outil ne renseigne ni `intent` ni `proof` avec du contenu mémoire.
 */
export function memoryForgetTool(store: MemoryStore): RegisteredTool {
  return defineTool({
    definition: {
      id: 'memory_forget',
      version: '1.0.0',
      description: 'Effacer définitivement une mémoire et ses dérivés.',
      /* `docs/03` nomme le niveau sans ambiguïté : L4 = « suppression, données
         sensibles, irréversible ». Ce n'est pas une prudence de ma part, c'est
         la ligne du tableau. */
      autonomy: 'L4',
      privacyClass: 'ORANGE',
      dataCategory: 'PERSONAL_MEMORY',
      reversible: false,
      networkRequired: false,
      /* L'identifiant est sensible : il désigne un souvenir. L'humain doit voir
         CE QU'il efface avant de dire oui (ADR-063). */
      parameters: [{ name: 'memoryId', sensitive: true }],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 5000,
      maxRetries: 1,
      auditEvent: 'MEMORY_DELETED',
      requiredSecrets: [],
      /* RIEN NE DÉFAIT UN OUBLI. C'est la seule valeur honnête ici : annoncer
         un rollback qui n'existe pas serait promettre une réversibilité que
         §C3 interdit précisément d'avoir. */
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'LOCAL_TRANSACTIONAL',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },
    inputSchema: MemoryForgetInput,

    async execute(input): Promise<Result<ToolExecution>> {
      /* ON RELÈVE LES DÉRIVÉS AVANT DE SUPPRIMER. Après le `DELETE`, la cascade
         a emporté `memory_derivatives` : demander ensuite « que reste-t-il à
         effacer à la main ? » rendrait toujours une liste vide, et l'outil
         annoncerait un oubli complet en toute bonne foi. */
      const aLaMain = await store.derivativesRequiringManualDeletion(input.memoryId);
      if (!aLaMain.ok) return aLaMain;

      const efface = await store.deleteForever(input.memoryId);
      if (!efface.ok) return efface;

      return ok({
        output: {
          memoryId: input.memoryId,
          existait: efface.value,
          /* On nomme les dérivés survivants par leur GENRE et leur localisateur
             — jamais par leur contenu. Dire « une sauvegarde en garde une
             copie » est l'information utile ; recopier la copie serait le
             défaut qu'on prétend corriger. */
          derivesRestants: aLaMain.value.map((d) => `${d.kind}:${d.locator}`),
        },
        resource: { kind: 'memory', id: input.memoryId },
        // Voir l'arbitrage n°2 : la capture existe et ne garde rien.
        undo: { kind: 'NOT_UNDOABLE' },
      });
    },

    async readBack(execution): Promise<Result<VerificationOutcome>> {
      const id = (execution.output as { memoryId: string }).memoryId;
      const restants = (execution.output as { derivesRestants: readonly string[] })
        .derivesRestants;
      const existait = (execution.output as { existait: boolean }).existait;

      /* ⚠ DÉFAUT TROUVÉ PAR LE CONTRÔLE NÉGATIF DE CE PROPRE OUTIL.
         La relecture concluait « absente, donc effacée » — vrai aussi d'une
         mémoire qui n'a JAMAIS existé. `memory_forget` annonçait alors un oubli
         CONFIRMED sur un identifiant inconnu, et l'utilisateur en aurait
         conclu qu'une donnée avait été effacée.

         Revendiquer un acte qui n'a pas eu lieu est exactement la faute que ce
         dépôt traque partout ailleurs. `execute` savait la différence — il
         rend `existait` — et la relecture l'ignorait. */
      if (!existait) {
        return ok(
          verificationOutcome.notAttempted(
            `Aucune mémoire ${id} : il n'y avait rien à oublier.`,
          ),
        );
      }

      const found = await store.getById(id);
      if (!found.ok) return found;

      if (found.value !== null) {
        return ok(
          verificationOutcome.failed({
            observed: `La mémoire ${id} est TOUJOURS présente après suppression.`,
            conclusiveBecause:
              'lecture transactionnelle après commit, aucun effet différé possible',
          }),
        );
      }

      /* LA LIGNE EST PARTIE. Si rien ne survit ailleurs, l'oubli est complet et
         sa preuve est une ABSENCE — d'où `erased` et non `confirmed`
         (ADR-065). */
      if (restants.length === 0) {
        return ok(
          verificationOutcome.erased({
            observed: `mémoire ${id} absente, aucun dérivé à effacer à la main`,
            conclusiveBecause:
              'lecture transactionnelle après commit ; les dérivés en base sont partis par cascade',
          }),
        );
      }

      /* IL SURVIT UNE COPIE. On ne dit pas « oublié ». Le statut se projette
         sur deux familles de cibles, et `PARTIAL` en SORT — l'outil ne le
         choisit pas. */
      const cibles: TargetOutcome[] = [
        {
          target: `memories:${id}`,
          status: 'CONFIRMED',
          evidence: 'POSITIVE_ABSENCE',
          detail: 'ligne supprimée, relecture vide',
        },
        ...restants.map((r) => ({
          target: r,
          status: 'FAILED' as const,
          evidence: 'POSITIVE_PRESENCE' as const,
          detail: 'dérivé hors cascade : une suppression explicite reste due',
        })),
      ];

      const projete = projectStatus(cibles, 'POSITIVE_ABSENCE');
      return ok({
        status: projete,
        detail:
          `Oubli INCOMPLET : ${describeTargets(cibles)}. ` +
          `La mémoire est partie de la base ; ${String(restants.length)} dérivé(s) ` +
          `exigent une suppression explicite.`,
        evidence: 'POSITIVE_ABSENCE',
      });
    },
  });
}
