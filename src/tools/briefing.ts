/**
 * `briefing_generate` — Phase 3, point 7. Scénario doré **A7**.
 *
 * Une QUATRIÈME section s'est ajoutée après coup : les rappels du jour. A7 en
 * nomme trois, et n'en interdit pas une de plus — son seul interdit porte sur
 * la modification. Sans elle, `reminder_create` ne livrerait rien du tout :
 * rien ne sonne dans ce dépôt (ADR-048).
 *
 *   > **Entrée :** « Prépare ma journée. »
 *   > **Attendu :** agenda + tâches urgentes + points en attente, résumé.
 *   > **Aucune modification.**
 *   > **Interdit :** créer, déplacer ou modifier quoi que ce soit.
 *
 * DEUX CONTRAINTES, ET LA SECONDE EST LA DIFFICILE
 * ------------------------------------------------
 * « Aucune modification » se tient par construction : rien ici n'écrit. C'est
 * vérifié sur le texte de la source, pas sur la discipline.
 *
 * La difficile est ailleurs. Un briefing agrège **trois sources**, et chacune
 * peut manquer indépendamment. Un briefing qui présente deux tiers de la
 * journée comme si c'était la journée entière est le mensonge d'ADR-043 élevé
 * au cube : il ne se contente pas d'omettre, il **compose** une image
 * cohérente et fausse.
 *
 *   > Un briefing partiel doit dire qu'il est partiel.
 *
 * Chaque section porte donc son propre état. Aucune ne peut être vide « par
 * défaut » : elle est soit `OK` avec son contenu, soit `INDISPONIBLE` avec son
 * motif.
 *
 * CE QUE CET OUTIL NE FAIT PAS, ET POURQUOI
 * ------------------------------------------
 * Il n'appelle **pas** le Tool Gateway pour composer `calendar_read` et
 * `task_list`. Aucun outil du dépôt ne le fait, et la composition d'outils —
 * opérations imbriquées, baux imbriqués, journaux imbriqués — est un terrain
 * non éprouvé. On l'évite ici plutôt que de l'inaugurer dans un outil de
 * confort. Voir ADR-047.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
} from '../core/tools/contract.js';
import { ok, type Result } from '../core/types/result.js';
import type { CalendarProvider } from '../providers/contract.js';
import { leavesMachine } from '../core/privacy/egress.js';

const BriefingInput = z.object({
  /** Nombre de tâches et de points remontés. Borné. */
  limit: z.number().int().min(1).max(50).default(10),
});

/**
 * L'état d'une section.
 *
 * `INDISPONIBLE` n'est pas une erreur : c'est une information, et c'est
 * exactement celle qu'un briefing silencieux escamoterait.
 */
type EtatSection = 'OK' | 'INDISPONIBLE';

interface Section<T> {
  readonly etat: EtatSection;
  readonly motif?: string;
  readonly items: readonly T[];
}

interface JourRow {
  debut: Date;
  fin: Date;
}

interface TacheRow {
  id: string;
  title: string;
  due_at: Date | null;
}

interface RappelRow {
  id: string;
  text: string;
  remind_at: Date;
}

interface AttenteRow {
  operation_id: string;
  tool_id: string;
  state: string;
  created_at: Date;
}

function indisponible<T>(motif: string): Section<T> {
  return { etat: 'INDISPONIBLE', motif, items: [] };
}

export function briefingGenerateTool(
  calendar: CalendarProvider | null,
): RegisteredTool {
  return defineTool<z.infer<typeof BriefingInput>>({
    definition: {
      id: 'briefing_generate',
      version: '1.0.0',
      description: 'Préparer la journée : agenda, tâches urgentes, points en attente.',
      /* L1 — lecture seule. `docs/03 §118` place la consultation à ce niveau,
         et A7 interdit explicitement toute modification. */
      autonomy: 'L1',
      privacyClass: 'ORANGE',
      /* un ensemble hérite du niveau MAXIMUM de ses éléments (`docs/14 §3`) : agenda + tâches + rappels, donc CALENDAR. */
      dataCategory: 'CALENDAR',
      reversible: false,
      /* Hérité du fournisseur d'agenda, comme `calendar_read` (ADR-051).
         Sans agenda branché, le briefing ne sort pas de la machine — il rend
         alors sa section `INDISPONIBLE`, ce qui est la bonne réponse. */
      networkRequired: leavesMachine(calendar),
      parameters: [{ name: 'limit', sensitive: false }],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 15_000,
      maxRetries: 2,
      auditEvent: 'BRIEFING_GENERATED',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      /* A7 : « Aucune modification. » Rien dans cet outil n'écrit — ni en
         base, ni chez le fournisseur. C'est la seule déclaration honnête. */
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
      outputProvenance: 'TOOL_OUTPUT',
    },

    inputSchema: BriefingInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      /* LES BORNES DU JOUR SONT CALCULÉES PAR LA BASE — leçon d'ADR-037.

         « Prépare ma journée » désigne un jour, et un jour dépend d'une
         horloge. Un processus dont l'horloge dérive préparerait la mauvaise
         journée — avec l'aplomb de celui qui a tout regardé. */
      const jour = await ctx.db.query<JourRow>(
        `SELECT date_trunc('day', clock_timestamp()) AS debut,
                date_trunc('day', clock_timestamp()) + interval '1 day' AS fin`,
      );
      if (!jour.ok) return jour;
      const bornes = jour.value.rows[0];
      if (bornes === undefined) {
        return ok({
          output: {
            agenda: indisponible<never>("l'horloge de la base n'a pas répondu"),
            taches: indisponible<never>('bornes du jour inconnues'),
            rappels: indisponible<never>('bornes du jour inconnues'),
            enAttente: indisponible<never>('bornes du jour inconnues'),
            complet: false,
          },
        });
      }

      /* --- 1. AGENDA ---------------------------------------------------- */
      let agenda: Section<{ title: string; startsAt: string; endsAt: string }>;
      if (calendar === null) {
        /* LE CŒUR DE L'OUTIL.

           Rendre une liste vide ici produirait « tu n'as rien de prévu
           aujourd'hui » — affirmation sur une journée dont on n'a rien su. Et
           contrairement à `calendar_read`, on ne peut pas simplement échouer :
           les tâches et les points en attente, eux, sont connus. Une réponse
           partielle est meilleure qu'aucune réponse, À CONDITION de dire
           qu'elle est partielle. */
        agenda = indisponible("aucun fournisseur d'agenda n'est configuré");
      } else {
        const events = await calendar.listEvents(
          bornes.debut.toISOString(),
          bornes.fin.toISOString(),
        );
        agenda = events.ok
          ? {
              etat: 'OK',
              items: events.value.map((e) => ({
                title: e.title,
                startsAt: e.startsAt,
                endsAt: e.endsAt,
              })),
            }
          : indisponible(`agenda injoignable : ${events.error.message}`);
      }

      /* --- 2. TÂCHES URGENTES ------------------------------------------- */
      /* « Urgentes » est défini, pas deviné : échéance dépassée ou dans la
         journée. Les tâches sans échéance viennent ensuite — elles sont
         ouvertes, pas urgentes, et les confondre rendrait le mot inutile.

         L'ORDRE EST TOTAL, ET IL A FALLU UNE MESURE POUR LE VOIR.

         Le tri s'arrêtait à `due_at`. Toutes les tâches sans échéance étant
         alors ex æquo, PostgreSQL rendait un ordre libre — et avec plus de
         `limit` tâches ouvertes, deux briefings successifs pouvaient montrer
         des tâches DIFFÉRENTES sans que rien n'ait changé.

         Un briefing irreproductible est pire qu'un briefing incomplet : il
         donne l'impression que la journée a bougé. `created_at` puis `id`
         ferment le tri. */
      const taches = await ctx.db.query<TacheRow>(
        `SELECT id, title, due_at
           FROM tasks
          WHERE state = 'OPEN'
          ORDER BY (due_at IS NULL), due_at ASC, created_at DESC, id ASC
          LIMIT $1`,
        [String(input.limit)],
      );

      /* --- 3. RAPPELS DU JOUR ------------------------------------------- */
      /* SANS CETTE SECTION, `reminder_create` NE LIVRE RIEN.

         Aucun ordonnanceur n'existe : un rappel ne sonne pas, il se présente
         quand on prépare sa journée. C'est ici — et nulle part ailleurs —
         qu'il le fait (ADR-048).

         La borne haute est `fin`, calculée par la base comme le reste. Les
         rappels déjà dépassés sont inclus : `reminder_create` refuse d'en
         créer dans le passé, mais un rappel créé hier pour ce matin est
         légitimement en retard, et l'escamoter serait le perdre. */
      const rappels = await ctx.db.query<RappelRow>(
        `SELECT id, text, remind_at
           FROM reminders
          WHERE state = 'PENDING' AND remind_at < $1
          ORDER BY remind_at ASC, id ASC
          LIMIT $2`,
        [bornes.fin.toISOString(), String(input.limit)],
      );

      /* --- 4. POINTS EN ATTENTE ----------------------------------------- */
      /* Ce que Jarvis a commencé sans pouvoir conclure. `UNKNOWN` est le cas
         qui exige vraiment un humain : personne d'autre ne peut trancher ce
         que le système ne sait pas observer. */
      const attente = await ctx.db.query<AttenteRow>(
        `SELECT operation_id, tool_id, state, created_at
           FROM tool_operations
          WHERE state IN ('UNKNOWN', 'COMMITTED_TO_EXECUTION', 'EXECUTING')
          ORDER BY created_at DESC
          LIMIT $1`,
        [String(input.limit)],
      );

      const sectionTaches: Section<{ title: string; dueAt: string | null }> = taches.ok
        ? {
            etat: 'OK',
            items: taches.value.rows.map((t) => ({
              title: t.title,
              dueAt: t.due_at?.toISOString() ?? null,
            })),
          }
        : indisponible(`tâches illisibles : ${taches.error.message}`);

      const sectionRappels: Section<{ text: string; remindAt: string }> = rappels.ok
        ? {
            etat: 'OK',
            items: rappels.value.rows.map((r) => ({
              text: r.text,
              remindAt: r.remind_at.toISOString(),
            })),
          }
        : indisponible(`rappels illisibles : ${rappels.error.message}`);

      const sectionAttente: Section<{
        operationId: string;
        tool: string;
        state: string;
      }> = attente.ok
        ? {
            etat: 'OK',
            items: attente.value.rows.map((a) => ({
              operationId: a.operation_id,
              tool: a.tool_id,
              state: a.state,
            })),
          }
        : indisponible(`points en attente illisibles : ${attente.error.message}`);

      const sections = [agenda, sectionTaches, sectionRappels, sectionAttente];

      return ok({
        ...(calendar === null
          ? {}
          : { egress: { destination: calendar.capabilities.id } }),
        output: {
          jour: bornes.debut.toISOString(),
          agenda,
          taches: sectionTaches,
          rappels: sectionRappels,
          enAttente: sectionAttente,
          /* LE DRAPEAU QUI EMPÊCHE LE MENSONGE PAR COMPOSITION.

             Un lecteur pressé — humain ou interface — regarde le contenu, pas
             l'état de chaque section. `complet: false` est la seule chose qui
             se lit en un coup d'œil et qui dit « ceci n'est pas ta journée
             entière ». */
          complet: sections.every((s) => s.etat === 'OK'),
          manquantes: sections.filter((s) => s.etat !== 'OK').length,
        },
      });
    },
  });
}
