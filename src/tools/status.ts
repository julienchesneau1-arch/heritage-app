/**
 * `system_status` — Phase 3, point 9 de `docs/02`. Dernier des dix.
 *
 * CE QU'UN OUTIL D'ÉTAT NE DOIT PAS ÊTRE
 * ---------------------------------------
 * Un « tout va bien » est la réponse la plus facile à écrire et la plus facile
 * à rendre fausse. Il suffit de ne pas regarder, ou de regarder ce qui ne
 * risque rien.
 *
 *   > Un état qui ne peut pas dire « ça ne va pas » ne dit rien quand ça va.
 *
 * D'où la forme : chaque contrôle est une **mesure**, et une mesure impossible
 * se rapporte comme telle. Aucun champ n'a de valeur par défaut rassurante.
 *
 * CE QU'IL RAPPORTE, ET POURQUOI CE SONT CEUX-LÀ
 * -----------------------------------------------
 * Trois choses seulement, chacune parce qu'elle peut mal aller sans bruit :
 *
 *   1. **La chaîne du journal** — si elle est rompue, tout audit passé devient
 *      une supposition. C'est la seule vérification qui invalide
 *      rétroactivement des affirmations déjà faites.
 *
 *   2. **Les opérations sans issue** — `UNKNOWN`, et les exécutions dont le
 *      bail a expiré sans que personne ne conclue. Une opération EN COURS n'en
 *      fait pas partie : voir le commentaire du contrôle 2, où la première
 *      rédaction se comptait elle-même.
 *
 *   3. **Les instantanés d'annulation qui expirent** — `docs/26` : un
 *      instantané n'est pas un archivage, il vit sept jours. Passé ce délai
 *      l'action devient définitivement non annulable, en silence.
 *
 * Pas de « mémoire OK », pas de « base OK » : si la base ne répondait pas, cet
 * outil ne répondrait pas non plus. Un contrôle qui ne peut pas échouer
 * séparément de son appelant ne mesure rien.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
} from '../core/tools/contract.js';
import { ok, type Result } from '../core/types/result.js';
import type { Ledger } from '../core/ledger/ledger.js';

const SystemStatusInput = z.object({});

/** Le verdict d'un contrôle. `INCONNU` n'est pas `OK`. */
type Verdict = 'OK' | 'ATTENTION' | 'INCONNU';

interface Controle {
  readonly verdict: Verdict;
  readonly detail: string;
}

interface CompteRow {
  n: string;
}

export function systemStatusTool(ledger: Ledger): RegisteredTool {
  return defineTool<z.infer<typeof SystemStatusInput>>({
    definition: {
      id: 'system_status',
      version: '1.0.0',
      description: "État du système : intégrité du journal, opérations sans issue, instantanés qui expirent.",
      autonomy: 'L1',
      /* ORANGE et non GREEN, pour la même raison qu'`audit_query` : les
         COMPTES disent quelque chose de l'activité de l'utilisateur, même sans
         aucun contenu. */
      privacyClass: 'ORANGE',
      /* des compteurs sur l'activité du système ; OTHER tombe sur PERSONAL, défaut fermé. */
      dataCategory: 'OTHER',
      reversible: false,
      networkRequired: false,
      parameters: [],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 15_000,
      maxRetries: 1,
      auditEvent: 'SYSTEM_STATUS_READ',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
    },

    inputSchema: SystemStatusInput,

    async execute(_input, ctx): Promise<Result<ToolExecution>> {
      /* --- 1. LA CHAÎNE DU JOURNAL -------------------------------------- */
      /* Le contrôle le plus lourd, et le seul qui invalide RÉTROACTIVEMENT.
         Une chaîne rompue ne casse pas le présent : elle rend incertain tout
         ce qui a déjà été affirmé. */
      const chaine = await ledger.verifyChain();
      const journal: Controle = !chaine.ok
        ? {
            verdict: 'INCONNU',
            detail: `vérification impossible : ${chaine.error.message}`,
          }
        : chaine.value.valid
          ? { verdict: 'OK', detail: `chaîne intacte sur ${String(chaine.value.checked)} entrées` }
          : {
              verdict: 'ATTENTION',
              detail:
                `chaîne rompue (${chaine.value.brokenAt?.reason ?? 'motif inconnu'}) — `
                + 'tout audit antérieur devient une supposition',
            };

      /* --- 2. LES OPÉRATIONS SANS ISSUE --------------------------------- */
      /* PREMIÈRE RÉDACTION : `state IN ('UNKNOWN','COMMITTED_TO_EXECUTION',
         'EXECUTING')`. Le test l'a démolie immédiatement, et pour la meilleure
         des raisons :

           **`system_status` est lui-même `EXECUTING` pendant qu'il compte.**

         L'observateur se comptait dans ce qu'il observait. Le tableau de bord
         signalait donc une opération en suspens en permanence — une alerte
         toujours allumée, c'est-à-dire une alerte éteinte.

         La correction n'est pas d'exclure `ctx.operationId` : ce serait un
         emplâtre qui laisserait passer toute autre opération en cours. C'est
         de distinguer ce qui est EN VOL de ce qui est ABANDONNÉ — et le bail
         porte déjà cette information.

           `UNKNOWN`              terminal, observé, issue inconnue → un humain
           en vol, bail VIVANT    quelqu'un travaille → rien à signaler
           en vol, bail PÉRIMÉ    plus personne ne travaille → abandonnée

         SENS DU `COALESCE`, ET IL EST INVERSE DE CELUI D'ADR-036.

         ADR-036 décide s'il faut LAISSER ÉCRIRE : fail-closed y signifie
         « en cas de doute, refuser », donc un bail sans échéance vaut
         `infinity` et l'écriture est autorisée par le détenteur.

         Ici on décide s'il faut PRÉVENIR UN HUMAIN : fail-closed signifie
         « en cas de doute, prévenir ». Une opération déclarée en vol sans
         échéance de bail n'est pas vivante pour l'éternité — c'est une
         anomalie, et elle se rapporte. */
      const sansIssue = await ctx.db.query<CompteRow>(
        `SELECT count(*)::text AS n FROM tool_operations
          WHERE state = 'UNKNOWN'
             OR (state IN ('COMMITTED_TO_EXECUTION', 'EXECUTING')
                 AND (lease_expires_at IS NULL
                      OR lease_expires_at <= clock_timestamp()))`,
      );
      const operations: Controle = !sansIssue.ok
        ? { verdict: 'INCONNU', detail: `comptage impossible : ${sansIssue.error.message}` }
        : (sansIssue.value.rows[0]?.n ?? '0') === '0'
          ? { verdict: 'OK', detail: 'aucune opération en suspens' }
          : {
              verdict: 'ATTENTION',
              detail:
                `${sansIssue.value.rows[0]?.n ?? '?'} opération(s) sans issue `
                + '(inconnues, ou abandonnées bail expiré) — seul un humain peut '
                + 'trancher ce que le système ne sait pas observer',
            };

      /* --- 3. LES INSTANTANÉS QUI EXPIRENT ------------------------------ */
      /* Un instantané n'est pas un archivage : il vit sept jours (ADR-019).
         Passé ce délai l'action devient définitivement non annulable — et rien
         ne le signale au moment où ça arrive. Le seuil est calculé par la
         base, comme partout (ADR-037). */
      const echeance = await ctx.db.query<CompteRow>(
        `SELECT count(*)::text AS n FROM action_snapshots
          WHERE undone_at IS NULL
            AND expires_at > clock_timestamp()
            AND expires_at < clock_timestamp() + interval '24 hours'`,
      );
      const annulations: Controle = !echeance.ok
        ? { verdict: 'INCONNU', detail: `comptage impossible : ${echeance.error.message}` }
        : (echeance.value.rows[0]?.n ?? '0') === '0'
          ? { verdict: 'OK', detail: 'aucun instantané n\'expire dans les 24 h' }
          : {
              verdict: 'ATTENTION',
              detail:
                `${echeance.value.rows[0]?.n ?? '?'} instantané(s) expirent sous 24 h — `
                + 'les actions correspondantes deviendront non annulables',
            };

      const controles = { journal, operations, annulations };
      const verdicts = Object.values(controles).map((c) => c.verdict);

      return ok({
        output: {
          controles,
          /* LE VERDICT GLOBAL EST LE PIRE, JAMAIS UNE MOYENNE.

             Deux contrôles verts et un rouge ne font pas « globalement bon ».
             Et `INCONNU` ne se fond pas dans `OK` : ne pas avoir pu regarder
             n'est pas avoir regardé. */
          verdict: verdicts.includes('ATTENTION')
            ? 'ATTENTION'
            : verdicts.includes('INCONNU')
              ? 'INCONNU'
              : 'OK',
          /* Rendu pour qu'un lecteur puisse constater qu'aucun contrôle n'a
             été silencieusement retiré : trois annoncés, trois rendus. */
          controlesEffectues: verdicts.length,
        },
      });
    },
  });
}
