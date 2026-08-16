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
} from '../core/tools/contract.js';
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
