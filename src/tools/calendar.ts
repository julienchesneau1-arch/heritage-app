/**
 * `calendar_read` — Phase 3, point 2 de `docs/02`.
 *
 * PREMIER OUTIL DU DÉPÔT QUI PARLE À UN FOURNISSEUR
 * -------------------------------------------------
 * Les sept outils précédents lisent et écrivent dans PostgreSQL. Celui-ci
 * dépend d'un système que nous ne possédons pas, et toute la difficulté tient
 * dans une phrase :
 *
 *   > Un agenda vide et un agenda inaccessible se ressemblent, et se
 *   > racontent différemment.
 *
 * « Tu n'as rien aujourd'hui » quand le fournisseur est injoignable est un
 * énoncé FAUX sur le monde. C'est la règle 3 (« jamais de succès non
 * vérifié ») dans sa forme la plus discrète : rien n'a échoué visiblement,
 * aucune exception n'a été levée, et pourtant Jarvis vient de mentir sur une
 * journée entière.
 *
 * D'où la forme de cet outil : l'absence de fournisseur est un ÉCHEC NOMMÉ,
 * jamais une liste vide.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
  type VerificationOutcome,
} from '../core/tools/contract.js';
import { verificationOutcome } from '../core/verification/engine.js';
import { err, ok, jarvisError, type Result } from '../core/types/result.js';
import type { CalendarProvider } from '../providers/contract.js';

const CalendarReadInput = z.object({
  /** Fenêtre demandée, bornée. Un agenda sans borne est une requête sans fin. */
  fromIso: z.string().datetime(),
  toIso: z.string().datetime(),
});

export function calendarReadTool(
  provider: CalendarProvider | null,
): RegisteredTool {
  return defineTool<z.infer<typeof CalendarReadInput>>({
    definition: {
      id: 'calendar_read',
      version: '1.0.0',
      description: "Lire les événements de l'agenda sur une fenêtre donnée.",
      /* L1 — `docs/03 §118` place explicitement « consulter l'agenda » à ce
         niveau. Ce n'est pas une déduction de ma part. */
      autonomy: 'L1',
      /* ORANGE aujourd'hui, `SENSITIVE` demain. `docs/14` classe l'agenda
         SENSITIVE, mais `DataLevel` n'est pas implémenté — le code en est
         encore à `PrivacyClass` à trois valeurs. Déclarer ORANGE est donc
         exact au regard de ce qui EXISTE, et insuffisant au regard de ce qui
         est spécifié. La bascule est un chantier de `docs/14 §5`, pas une
         décision de cet outil. */
      privacyClass: 'ORANGE',
      reversible: false,
      /* `true`, ET C'EST UN CHOIX DÉLIBÉRÉMENT PESSIMISTE.

         `egress` est dérivé de ce champ (`gateway.ts:801`). Or l'outil ne PEUT
         PAS savoir si l'appel quitte la machine : cela dépend du fournisseur
         branché — un CalDAV sur 127.0.0.1 ne sort pas, un agenda cloud sort.
         `ProviderCapabilities.local` porte cette information, et elle n'est
         connue qu'à l'exécution.

         Un contrat d'outil est statique. Devant une inconnue, il déclare le
         PIRE CAS : la fenêtre où l'agenda pourrait sortir de la machine est
         traitée comme si elle sortait toujours.

         Conséquence assumée : en mode privé, `calendar_read` est refusé même
         avec un fournisseur local. C'est un refus faux, et c'est le bon sens
         du compromis — l'erreur inverse laisserait un agenda partir sans que
         le Gate le voie. Le raffinement (croiser `capabilities.local`)
         appartient au Data Firewall de Phase 4, pas au contrat d'outil. */
      networkRequired: true,
      parameters: [
        { name: 'fromIso', sensitive: false },
        { name: 'toIso', sensitive: false },
      ],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 10_000,
      maxRetries: 2,
      auditEvent: 'CALENDAR_READ',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      /* Une lecture ne change rien, nulle part — y compris chez le
         fournisseur. `NO_EXTERNAL_EFFECT` décrit l'EFFET, pas le trajet
         réseau : les deux sont des questions différentes, et c'est
         `networkRequired` qui porte la seconde. */
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
    },

    inputSchema: CalendarReadInput,

    async execute(input): Promise<Result<ToolExecution>> {
      /* AUCUN FOURNISSEUR ⇒ ÉCHEC NOMMÉ, JAMAIS UNE LISTE VIDE.

         C'est la seule ligne qui compte vraiment dans ce fichier. Rendre
         `{ events: [] }` serait syntaxiquement correct, ne lèverait aucune
         exception, et affirmerait « tu n'as rien » sur une journée dont on ne
         sait rien. Un mensonge sans erreur. */
      if (provider === null) {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            "Aucun fournisseur d'agenda n'est configuré : l'agenda est inconnu, "
              + 'pas vide.',
          ),
        );
      }

      if (Date.parse(input.fromIso) > Date.parse(input.toIso)) {
        return err(
          jarvisError('VALIDATION', 'Fenêtre inversée : `fromIso` est après `toIso`.'),
        );
      }

      const events = await provider.listEvents(input.fromIso, input.toIso);
      /* L'ERREUR DU FOURNISSEUR REMONTE TELLE QUELLE.

         La rattraper pour rendre une liste vide reproduirait exactement le
         défaut ci-dessus, une couche plus bas — et cette fois avec un
         fournisseur configuré, donc sans le moindre indice pour l'utilisateur. */
      if (!events.ok) return events;

      return ok({
        output: {
          from: input.fromIso,
          to: input.toIso,
          count: events.value.length,
          /* La source est rendue : deux agendas différents ne donnent pas la
             même réponse à la même question, et l'utilisateur a le droit de
             savoir lequel a répondu. */
          source: provider.capabilities.id,
          local: provider.capabilities.local,
          events: events.value.map((e) => ({
            id: e.id,
            title: e.title,
            startsAt: e.startsAt,
            endsAt: e.endsAt,
          })),
        },
      });
    },
  });
}

/* -------------------------------------------------------------------------- */

const CalendarCreateInput = z.object({
  title: z.string().min(1).max(300),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

/**
 * `calendar_create` — Phase 3, point 3.
 *
 * **PREMIER EFFET EXTERNE DU DÉPÔT.** Les huit outils précédents écrivent dans
 * PostgreSQL ou ne changent rien. Celui-ci modifie un monde que nos
 * transactions ne couvrent pas, et toute la machinerie construite ces dernières
 * semaines — contrats d'effet, `UNKNOWN` définitif, refus de rejeu, deux mondes
 * du banc — existait pour ce cas sans qu'aucun code de production ne l'exerce.
 *
 * Voir ADR-044. Les trois déclarations qui suivent sont les seules qui
 * comptent, et chacune a été choisie CONTRE une option plus flatteuse.
 */
export function calendarCreateTool(
  provider: CalendarProvider | null,
): RegisteredTool {
  return defineTool<z.infer<typeof CalendarCreateInput>>({
    definition: {
      id: 'calendar_create',
      version: '1.0.0',
      description: "Créer un événement dans l'agenda.",
      /* L3 — `docs/03 §120` nomme explicitement « déplacer un rendez-vous »
         comme exemple de APPROVAL. Ce n'est pas une déduction : le niveau est
         écrit dans le document, et l'outil s'y range. */
      autonomy: 'L3',
      privacyClass: 'ORANGE',
      reversible: true,
      /* Même raisonnement que `calendar_read` : le contrat est statique, le
         trajet dépend du fournisseur, donc pire cas. Voir `docs/26 §4.5`. */
      networkRequired: true,
      parameters: [
        { name: 'title', sensitive: true },
        { name: 'startsAt', sensitive: true },
        { name: 'endsAt', sensitive: true },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 10_000,
      /* ZÉRO. Une nouvelle tentative après un échec réseau créerait un second
         rendez-vous si le premier a abouti sans que la réponse nous parvienne.
         C'est `docs/21 §2` — la requête encore en vol — et aucune observation
         de notre part ne peut l'exclure. */
      maxRetries: 0,
      auditEvent: 'CALENDAR_EVENT_CREATED',
      requiredSecrets: [],
      rollback: "Supprimer l'événement créé chez le fournisseur (calendar_delete).",
      /* `NONE`, ET C'EST UNE LIMITE DE L'INTERFACE, PAS UNE PARESSE.

         `docs/16 §3` prescrit `BY_RESOURCE` pour cet outil. Or
         `CalendarProvider.verifyEvent(id)` exige l'IDENTIFIANT DE L'ÉVÉNEMENT
         — précisément ce qu'on n'a pas si le processus est mort avant de
         l'avoir enregistré. L'interface, telle qu'elle est déclarée, ne sait
         pas répondre à « as-tu déjà traité l'opération 8f2a… ? ».

         `BY_OPERATION_KEY` exigerait `verifyAttempt`, que nous ne pourrions
         pas écrire honnêtement. Le déclarer serait l'illusion de fiabilité que
         le validateur de contrat existe pour empêcher.

         Conséquence assumée : après un `UNKNOWN`, on ne rejoue pas et on
         demande. Consigné en `docs/26 §4.6`. */
      attemptVerification: 'NONE',
      /* `EXTERNALLY_VERIFIABLE`, ET SURTOUT PAS `PROVIDER_IDEMPOTENT`.

         La signature `createEvent(event, operationId)` INVITE à déclarer
         `PROVIDER_IDEMPOTENT` : la clé d'opération est là, le fournisseur
         pourrait dédoublonner. Mais « pourrait » n'est pas « garantit », et
         `PROVIDER_IDEMPOTENT` est le SEUL contrat externe qui autorise un
         rejeu après `UNKNOWN`.

         Aucun fournisseur n'existe. Déclarer cette garantie serait la promettre
         AU NOM d'un adaptateur que personne n'a écrit — et le jour où
         quelqu'un brancherait un CalDAV qui ignore la clé, un rejeu créerait
         un second rendez-vous en silence.

         `EXTERNALLY_VERIFIABLE` dit ce qui est vrai : le fournisseur est
         interrogeable, donc un `UNKNOWN` peut devenir `CONFIRMED` ; il n'est
         pas idempotent, donc on ne rejoue jamais. */
      effect: 'EXTERNALLY_VERIFIABLE',
      /* `OBSERVABLE` — présence seulement, JAMAIS `FAILED`.

         Ne pas voir l'événement ne prouve pas qu'il n'existe pas : la requête
         peut encore être en vol. Le Verification Engine dégrade d'ailleurs
         tout `FAILED` en `UNKNOWN` pour un outil OBSERVABLE (`engine.ts:200`),
         ce qui fait de cette ligne une seconde barrière et non l'unique. */
      verifiability: 'OBSERVABLE',
    },

    inputSchema: CalendarCreateInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      if (provider === null) {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            "Aucun fournisseur d'agenda n'est configuré : l'événement n'a pas "
              + 'été créé, et rien ne permet de dire qu\'il le sera.',
          ),
        );
      }

      if (Date.parse(input.startsAt) >= Date.parse(input.endsAt)) {
        return err(
          jarvisError('VALIDATION', 'Un événement doit finir après avoir commencé.'),
        );
      }

      /* La clé d'opération est transmise au fournisseur. Elle ne FONDE aucune
         garantie de notre côté — voir `effect` ci-dessus — mais la retenir
         empêcherait un fournisseur qui, lui, sait dédoublonner, de le faire. */
      const created = await provider.createEvent(
        {
          title: input.title,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
        },
        ctx.operationId,
      );
      /* L'erreur remonte telle quelle. Le Gateway la traduira en `UNKNOWN` et
         non en `FAILED`, parce que le contrat d'effet est externe : une erreur
         de transport ne prouve pas l'absence d'effet chez le fournisseur. */
      if (!created.ok) return created;

      return ok({
        output: {
          eventId: created.value.id,
          title: created.value.title,
          startsAt: created.value.startsAt,
          endsAt: created.value.endsAt,
          source: provider.capabilities.id,
        },
        resource: { kind: 'calendar_event', id: created.value.id },
        undo: {
          kind: 'INVERSE_OPERATION',
          inverseToolId: 'calendar_delete',
          inverseInput: { eventId: created.value.id },
        },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      void ctx;
      if (provider === null || execution.resource === undefined) {
        return ok(
          verificationOutcome.unknown('Aucune ressource à relire.', 'NO_OBSERVATION'),
        );
      }

      const found = await provider.verifyEvent(execution.resource.id);
      if (!found.ok) {
        /* Le fournisseur ne répond pas à la relecture. L'événement a peut-être
           été créé — on ne le saura pas maintenant. */
        return ok(
          verificationOutcome.unknown(
            `Relecture impossible chez ${provider.capabilities.id} : ${found.error.message}`,
            'EXTERNAL_STATE',
          ),
        );
      }

      if (found.value === null) {
        /* ABSENCE OBSERVÉE ⇒ `UNKNOWN`, JAMAIS `FAILED`.

           C'est la différence entre PostgreSQL et le monde. Une ligne absente
           après commit PROUVE l'absence ; un événement absent chez un
           fournisseur distant prouve seulement qu'il n'est pas là À CET
           INSTANT. La requête peut arriver une seconde plus tard, et
           l'utilisateur qui aurait entendu « échec » recréerait le
           rendez-vous. */
        return ok(
          verificationOutcome.unknown(
            `Événement ${execution.resource.id} non trouvé chez `
              + `${provider.capabilities.id} — un effet différé reste possible.`,
            'EXTERNAL_STATE',
          ),
        );
      }

      return ok(
        verificationOutcome.confirmed({
          observed: `événement « ${found.value.title} » relu chez `
            + `${provider.capabilities.id} (${found.value.startsAt})`,
        }),
      );
    },
  });
}

/* -------------------------------------------------------------------------- */

const CalendarUpdateInput = z.object({
  eventId: z.string().min(1),
  title: z.string().min(1).max(300).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
});

/**
 * `calendar_update` — Phase 3, point 4.
 *
 * ADR-042 APPLIQUÉ LÀ OÙ L'ÉTAT ANTÉRIEUR VIT CHEZ QUELQU'UN D'AUTRE
 * ------------------------------------------------------------------
 * `task_complete` a établi qu'une modification ne se défait qu'en restaurant
 * l'état **observé**, et l'a obtenu en fusionnant mutation et capture dans une
 * seule instruction SQL. Ici cette fusion est impossible : entre un `SELECT`
 * chez le fournisseur et l'écriture qui suit, l'événement peut changer — le
 * téléphone de l'utilisateur écrit dans le même agenda.
 *
 * On ne peut pas fermer la fenêtre. On déplace l'obligation : **le fournisseur
 * déclare ce qu'il a remplacé** (`CalendarUpdate.previous`). Il est la seule
 * partie qui a réellement effectué l'échange.
 *
 * Ce qui reste — et qui ne se referme pas ici — est en `docs/26 §4.7`.
 * Voir ADR-045.
 */
export function calendarUpdateTool(
  provider: CalendarProvider | null,
): RegisteredTool {
  return defineTool<z.infer<typeof CalendarUpdateInput>>({
    definition: {
      id: 'calendar_update',
      version: '1.0.0',
      description: "Modifier un événement de l'agenda.",
      /* L3 — `docs/03 §120` nomme littéralement « déplacer un rendez-vous »
         comme exemple de APPROVAL. C'est CET outil que le document décrit. */
      autonomy: 'L3',
      privacyClass: 'ORANGE',
      reversible: true,
      networkRequired: true,
      parameters: [
        { name: 'eventId', sensitive: false },
        { name: 'title', sensitive: true },
        { name: 'startsAt', sensitive: true },
        { name: 'endsAt', sensitive: true },
      ],
      idempotency: 'OPERATION_KEY',
      verification: 'READ_BACK',
      timeoutMs: 10_000,
      /* Zéro, et la raison est PIRE que pour `calendar_create`. Un doublon de
         création se voit ; un second `update` rejoué écraserait la capture
         d'annulation du premier avec l'état qu'il vient lui-même d'écrire —
         c'est la leçon d'ADR-042, aggravée par le fait que rien, dehors, ne
         nous dira que c'est arrivé. */
      maxRetries: 0,
      auditEvent: 'CALENDAR_EVENT_UPDATED',
      requiredSecrets: [],
      rollback: "Réécrire l'état antérieur DÉCLARÉ PAR LE FOURNISSEUR (STATE_RESTORE).",
      attemptVerification: 'NONE',
      effect: 'EXTERNALLY_VERIFIABLE',
      verifiability: 'OBSERVABLE',
    },

    inputSchema: CalendarUpdateInput,

    async execute(input, ctx): Promise<Result<ToolExecution>> {
      if (provider === null) {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            "Aucun fournisseur d'agenda n'est configuré : l'événement n'a pas "
              + 'été modifié.',
          ),
        );
      }

      const changes: Partial<{ title: string; startsAt: string; endsAt: string }> = {};
      if (input.title !== undefined) changes.title = input.title;
      if (input.startsAt !== undefined) changes.startsAt = input.startsAt;
      if (input.endsAt !== undefined) changes.endsAt = input.endsAt;

      /* UNE MODIFICATION QUI NE MODIFIE RIEN EST UNE ERREUR, PAS UN SUCCÈS.

         Accepter un appel vide ferait écrire au journal « rendez-vous
         modifié » sans qu'aucun champ ait bougé — et la capture d'annulation
         enregistrerait un état antérieur identique à l'état courant, ce qui
         n'annule rien. */
      if (Object.keys(changes).length === 0) {
        return err(
          jarvisError('VALIDATION', 'Aucun champ à modifier : la demande est vide.'),
        );
      }

      if (
        changes.startsAt !== undefined
        && changes.endsAt !== undefined
        && Date.parse(changes.startsAt) >= Date.parse(changes.endsAt)
      ) {
        return err(
          jarvisError('VALIDATION', 'Un événement doit finir après avoir commencé.'),
        );
      }

      const result = await provider.updateEvent(input.eventId, changes, ctx.operationId);
      if (!result.ok) return result;

      const { previous, updated } = result.value;

      /* LE FOURNISSEUR EST VÉRIFIÉ, PAS CRU SUR PAROLE.

         Il vient de nous remettre l'état antérieur sur lequel repose toute
         possibilité d'annuler. S'il parle d'un autre événement que celui qu'on
         a demandé, la capture serait une restauration vers l'état d'un TIERS —
         un dégât pire que l'absence d'annulation.

         Ce n'est pas un échec de l'action : c'est une rupture de contrat de la
         SOURCE, et elle se nomme comme telle (ADR-038). */
      if (previous.id !== input.eventId || updated.id !== input.eventId) {
        return err(
          jarvisError(
            'INTEGRITY',
            `Le fournisseur ${provider.capabilities.id} rend un état antérieur `
              + `(${previous.id}) ou modifié (${updated.id}) qui ne correspond pas `
              + `à l'événement demandé (${input.eventId}). L'état antérieur est `
              + "inutilisable, donc l'action n'est pas annulable.",
          ),
        );
      }

      return ok({
        output: {
          eventId: updated.id,
          title: updated.title,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt,
          source: provider.capabilities.id,
          /* Rendu explicitement, comme pour `task_complete` : « c'était déjà
             ainsi » et « je viens de le changer » sont deux réponses. */
          changed:
            previous.title !== updated.title
            || previous.startsAt !== updated.startsAt
            || previous.endsAt !== updated.endsAt,
        },
        resource: { kind: 'calendar_event', id: updated.id },
        undo: {
          kind: 'STATE_RESTORE',
          /* L'état antérieur DÉCLARÉ PAR CELUI QUI L'A REMPLACÉ — jamais
             celui qu'on aurait lu avant, ni celui qu'on suppose. */
          priorState: {
            eventId: previous.id,
            title: previous.title,
            startsAt: previous.startsAt,
            endsAt: previous.endsAt,
          },
        },
      });
    },

    async readBack(execution, ctx): Promise<Result<VerificationOutcome>> {
      void ctx;
      if (provider === null || execution.resource === undefined) {
        return ok(
          verificationOutcome.unknown('Aucune ressource à relire.', 'NO_OBSERVATION'),
        );
      }

      const found = await provider.verifyEvent(execution.resource.id);
      if (!found.ok) {
        return ok(
          verificationOutcome.unknown(
            `Relecture impossible chez ${provider.capabilities.id} : ${found.error.message}`,
            'EXTERNAL_STATE',
          ),
        );
      }
      if (found.value === null) {
        /* L'événement a disparu entre l'écriture et la relecture. Ce n'est pas
           `FAILED` : dehors, l'absence ne prouve rien — et ici elle pourrait
           même signifier qu'un tiers l'a supprimé APRÈS notre modification
           réussie. */
        return ok(
          verificationOutcome.unknown(
            `Événement ${execution.resource.id} introuvable chez `
              + `${provider.capabilities.id} après modification.`,
            'EXTERNAL_STATE',
          ),
        );
      }

      return ok(
        verificationOutcome.confirmed({
          observed: `événement « ${found.value.title} » relu chez `
            + `${provider.capabilities.id} (${found.value.startsAt})`,
        }),
      );
    },
  });
}
