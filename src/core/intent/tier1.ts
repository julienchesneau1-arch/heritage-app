/**
 * TIER 1 — parler librement, et que Jarvis comprenne. ADR-081.
 *
 * `Tier 0` est une liste de règles écrites à la main. Mesuré sur trente tours
 * d'une conversation réelle (ADR-080) : **43 % aboutissent**, et `REFERENCE`
 * tombe à `0/8`. Dis « ajoute du café à ma liste » et ça marche ; dis
 * « faudrait que je pense au café » et il ne comprend pas.
 *
 * Ce module comble cet écart. Il donne à un modèle LOCAL le catalogue des
 * outils et l'énoncé de l'utilisateur, et lui demande lequel appeler.
 *
 * CE QUI CHANGE, ET CE QUI NE CHANGE SURTOUT PAS
 * ---------------------------------------------------------------------------
 * ```text
 * CHANGE        la COMPRÉHENSION — n'importe quelle formulation est admise
 * NE CHANGE PAS l'AUTORITÉ — la sortie du modèle reste une entrée non fiable
 * ```
 *
 * `CLAUDE.md` règle 1 : *« Le modèle propose, le système décide. Une sortie de
 * LLM est une entrée non fiable, jamais une autorisation. »* Ce fichier est
 * l'application littérale de cette phrase.
 *
 * LE MÉCANISME QUI REND ÇA SÛR EXISTAIT DÉJÀ
 * ---------------------------------------------------------------------------
 * Chaque paramètre proposé par le modèle est marqué `MODEL_OUTPUT`. Le Policy
 * Gate traite cette provenance comme non fiable ; sur un paramètre **sensible**,
 * il force le niveau à `L4` — c'est-à-dire **confirmation portant sur la valeur
 * concrète**, pas sur l'intention résumée.
 *
 * ```text
 * « faudrait que je pense au café »
 *   ↓ Tier 1 : le modèle propose
 * task_create { title: "acheter du café" }   ← MODEL_OUTPUT
 *   ↓ Policy Gate : provenance non fiable + paramètre sensible → L4
 * « Créer la tâche « acheter du café » ? »   ← la VALEUR est montrée
 *   ↓ l'utilisateur répond
 * ```
 *
 * L'utilisateur parle donc librement, **et voit toujours ce qui a été compris
 * avant que ça parte**. C'est la version honnête de « il fait mes intentions » :
 * il les fait, après te les avoir montrées.
 *
 * DÉSIGNER SANS NOMMER — ADR-084
 * ---------------------------------------------------------------------------
 * Plus d'un quart d'une conversation réelle désigne une chose sans la renommer
 * (`REFERENCE` **0/8**, ADR-080). C'est ce qui sépare une conversation d'une
 * suite d'ordres.
 *
 * Le modèle peut désormais MARQUER un paramètre comme renvoi — jamais le
 * résoudre :
 *
 * ```text
 * « rappelle-moi de la rappeler demain »
 *   parametres  { title: "la rappeler", due_at: "demain" }
 *   referents   { title: 'ANAPHORA',    due_at: 'TEMPORAL' }
 *                        ↓                       ↓
 *                 le résolveur d'entités   PostgreSQL (ADR-077)
 *                 sur PREUVE contextuelle  clock_timestamp()
 * ```
 *
 * **Et c'est ce qui évite de mettre l'historique dans le prompt.** Repérer un
 * pronom est une observation de langue, lisible sur la phrase seule. Savoir ce
 * qu'il désigne exige la conversation — laquelle contiendra tôt ou tard un
 * email lu à voix haute. Donner l'historique au modèle serait T1 par la grande
 * porte ; lui demander de pointer du doigt ne coûte rien.
 *
 * POURQUOI CE N'EST PAS DANS `engine.ts`
 * ---------------------------------------------------------------------------
 * `propose(text)` est une fonction **pure et synchrone** du texte. ADR-073 a
 * refusé de la rendre asynchrone pour un gain de court terme : cela ferait
 * dépendre la compréhension d'une entrée-sortie, et rendrait le `Tier 0`
 * inéprouvable sans infrastructure. Le `Tier 1` demande un modèle, donc de
 * l'asynchrone : il vit ici, et c'est l'Assistant qui l'orchestre.
 *
 * L'ORDRE EST UNE PROPRIÉTÉ, PAS UNE OPTIMISATION
 * ---------------------------------------------------------------------------
 * `Tier 0` d'abord, `Tier 1` **seulement s'il n'a rien compris**. Jamais
 * l'inverse. Les règles sont déterministes, gratuites, répondent en 4,6 µs et
 * marquent leurs paramètres `USER` — elles n'exigent donc pas de confirmation
 * là où elles suffisent. Passer par le modèle d'abord ajouterait de la latence,
 * de la variabilité et une confirmation, pour un résultat identique.
 *
 * ⚠ CE QUI N'A JAMAIS TOURNÉ CONTRE UN VRAI MODÈLE
 * ---------------------------------------------------------------------------
 * **Aucun modèle n'est installé dans l'environnement où ce fichier a été
 * écrit.** Il est éprouvé contre un `ModelProvider` simulé, ce qui vérifie la
 * forme du dialogue, la validation de la réponse et le traitement des cas
 * hostiles — et **rien** de ce qu'un modèle réel produit.
 */
import { z } from 'zod';
import { err, jarvisError, ok, type Result } from '../types/result.js';
import type { Provenance } from '../types/domain.js';
import type { ModelProvider } from '../../providers/contract.js';
import type { RegisteredTool } from '../tools/contract.js';
import type { IntentProposal } from './engine.js';

/* -------------------------------------------------------------------------- */
/* Ce que le modèle a le droit de répondre                                    */
/* -------------------------------------------------------------------------- */

/**
 * ⚠ CE SCHÉMA EST LA FRONTIÈRE, ET IL EST DÉLIBÉRÉMENT PAUVRE.
 *
 * Le modèle ne rend ni provenance, ni niveau d'autonomie, ni confirmation. Ces
 * champs décident de ce qui s'exécute sans demander : les lui laisser écrire
 * reviendrait à lui confier la clé du Policy Gate.
 *
 * Il ne rend pas non plus `userConfirms`. `Tier 0` peut le poser parce qu'une
 * règle sait que « retiens que X » EST un ordre de mémorisation. Un modèle qui
 * l'affirmerait affirmerait seulement qu'il le pense.
 */
const ReponseModele = z.union([
  z.object({
    action: z.literal('APPEL'),
    outil: z.string().min(1),
    parametres: z.record(z.string(), z.unknown()),
    /**
     * LES PARAMÈTRES QUI SONT UN RENVOI, PAS UNE DONNÉE — ADR-084.
     *
     * Le modèle a le droit de dire *« ce paramètre désigne quelque chose sans
     * le nommer »*. Il n'a PAS le droit de dire quoi.
     *
     * ```text
     * DROIT     « supprime-la »  → { id: "la" },  referents: { id: 'ANAPHORA' }
     * PAS DROIT  choisir QUELLE tâche « la » désigne
     * ```
     *
     * La différence est celle entre une observation de LANGUE — il y a un
     * pronom, une date relative — et une décision sur le MONDE. La première se
     * lit sur la phrase seule ; la seconde exige la conversation et la base,
     * que le modèle n'a ni l'une ni l'autre, et n'aura pas (voir §PROMPT).
     *
     * C'est ce partage qui permet d'atteindre `REFERENCE` **sans jamais mettre
     * l'historique de conversation dans le prompt** — lequel contiendrait tôt
     * ou tard un contenu externe, c'est-à-dire T1 par la grande porte.
     */
    referents: z.record(z.string(), z.enum(['ANAPHORA', 'TEMPORAL'])).optional(),
  }),
  z.object({
    action: z.literal('AUCUN'),
    /** Ce que le modèle a cru comprendre — repris tel quel à l'utilisateur. */
    compris: z.string().min(1).max(300),
  }),
]);

/* -------------------------------------------------------------------------- */
/* Le prompt                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Décrit le catalogue au modèle.
 *
 * On ne donne QUE ce qui aide à choisir : l'identifiant, la description, et le
 * nom des paramètres. Ni le niveau d'autonomie, ni le caractère sensible, ni la
 * réversibilité — ce sont des propriétés dont le modèle n'a pas à connaître
 * l'existence, encore moins à raisonner dessus.
 */
function catalogue(outils: readonly RegisteredTool[]): string {
  return outils
    .map((t) => {
      const noms = t.definition.parameters.map((p) => p.name).join(', ');
      const params = noms.length > 0 ? ` (paramètres : ${noms})` : '';
      return `- ${t.definition.id} : ${t.definition.description}${params}`;
    })
    .join('\n');
}

/**
 * Les instructions données au modèle.
 *
 * ⚠ AUCUNE DONNÉE NON FIABLE N'ENTRE ICI. Le prompt se compose de trois choses
 * seulement : ces instructions, le catalogue d'outils, et l'énoncé de
 * l'utilisateur. Ce dernier est la SEULE entrée fiable du système (`engine.ts`).
 *
 * Le jour où l'on voudra enrichir le prompt d'un contenu d'email ou d'un extrait
 * de mémoire, ce sera une décision d'architecture à part entière — pas un
 * ajout de commodité. Un email dans un prompt, c'est T1 par la grande porte.
 */
const INSTRUCTIONS = `Tu es le module de compréhension d'un assistant personnel.
Ta seule tâche est de choisir UN outil dans le catalogue, ou aucun.

Règles :
- Réponds UNIQUEMENT en JSON, sans texte autour.
- Si un outil correspond : {"action":"APPEL","outil":"<id>","parametres":{...}}
- Sinon : {"action":"AUCUN","compris":"<ce que tu as compris, en une phrase>"}
- N'invente jamais d'identifiant d'outil absent du catalogue.
- Ne remplis un paramètre qu'avec ce que l'utilisateur a dit. Ne complète pas.
- Tu ne décides pas si l'action est autorisée : ce n'est pas ton rôle.

Quand un paramètre DÉSIGNE une chose sans la nommer, signale-le dans
"referents", en recopiant quand même les mots employés dans "parametres" :
- "ANAPHORA" : un pronom ou un renvoi — « la », « celui-là », « le même »
- "TEMPORAL" : un moment relatif — « demain », « jeudi », « dans 2 heures »

Exemple : « rappelle-moi de la rappeler demain »
{"action":"APPEL","outil":"reminder_create",
 "parametres":{"title":"la rappeler","due_at":"demain"},
 "referents":{"title":"ANAPHORA","due_at":"TEMPORAL"}}

Tu signales qu'il y a un renvoi. Tu ne cherches PAS ce qu'il désigne : tu n'as
ni la conversation précédente ni la date du jour, et quelqu'un d'autre s'en
charge avec les bonnes données.`;

/* -------------------------------------------------------------------------- */
/* Le proposeur                                                               */
/* -------------------------------------------------------------------------- */

export interface Tier1Deps {
  readonly model: ModelProvider;
  /** Le catalogue réel, lu à chaque appel : un outil retiré disparaît aussitôt. */
  readonly outils: () => readonly RegisteredTool[];
}

export interface Tier1 {
  propose(texte: string): Promise<Result<IntentProposal>>;
}

/** Toute valeur venue du modèle porte cette étiquette. Sans exception. */
const DU_MODELE: Provenance = 'MODEL_OUTPUT';

export function createTier1(deps: Tier1Deps): Tier1 {
  return {
    async propose(texte: string): Promise<Result<IntentProposal>> {
      const outils = deps.outils();
      if (outils.length === 0) {
        return err(jarvisError('CONFIGURATION', 'aucun outil enregistré'));
      }

      const lu = await deps.model.structuredOutput(
        {
          messages: [
            { role: 'system', content: `${INSTRUCTIONS}\n\nCatalogue :\n${catalogue(outils)}` },
            { role: 'user', content: texte },
          ],
          // Une proposition d'outil tient en quelques dizaines de jetons. Borner
          // évite qu'un modèle parti en digression consomme une minute.
          maxTokens: 300,
          // Déterminisme : deux fois la même phrase doivent donner la même
          // proposition, sans quoi rien n'est reproductible ni éprouvable.
          temperature: 0,
        },
        (brut) => {
          const valide = ReponseModele.safeParse(brut);
          if (!valide.success) {
            return err(
              jarvisError(
                'VALIDATION',
                `réponse de modèle non conforme : ${valide.error.issues[0]?.message ?? '?'}`,
              ),
            );
          }
          return ok(valide.data);
        },
      );
      if (!lu.ok) return lu;

      const reponse = lu.value;
      if (reponse.action === 'AUCUN') {
        return ok({
          kind: 'UNSUPPORTED',
          understood: reponse.compris,
          missing: 'une action que je sache faire à partir de cette demande',
        });
      }

      /* ⚠ L'OUTIL DOIT EXISTER — ET C'EST LA GARDE LA PLUS IMPORTANTE DU FICHIER.

         Un modèle qui hallucine un identifiant (`email_send`, `payment_make`)
         ne doit pas produire un appel que la suite de la chaîne tenterait de
         résoudre. On refuse ICI, sur le catalogue RÉEL relu à chaque appel, et
         non sur une liste recopiée qui pourrait diverger (ADR-041). */
      const connu = outils.find((t) => t.definition.id === reponse.outil);
      if (connu === undefined) {
        return ok({
          kind: 'UNSUPPORTED',
          understood: `que tu veux quelque chose que j'ai cru pouvoir faire`,
          missing:
            `cette capacité — j'ai proposé « ${reponse.outil} », qui n'existe ` +
            `pas. Je préfère le dire plutôt que de tenter autre chose.`,
        });
      }

      /* CHAQUE paramètre est marqué `MODEL_OUTPUT`. Pas seulement ceux qui
         semblent sensibles : c'est le contrat de l'outil qui décide de ce qui
         est sensible, pas nous, et le Policy Gate croise les deux. */
      const provenance: Record<string, Provenance> = {};
      for (const cle of Object.keys(reponse.parametres)) provenance[cle] = DU_MODELE;

      /* LES RENVOIS — ADR-084.

         On ne garde que les marques qui désignent un paramètre RÉELLEMENT
         présent. Une marque sur un paramètre absent ne désigne rien : la
         retenir ferait échouer la résolution en aval sur un champ vide, et
         transformerait une bizarrerie de modèle en erreur affichée.

         Ce filtrage n'accorde rien — il ne peut que RETIRER une marque, donc
         que rendre le traitement plus littéral. Le sens dangereux serait
         l'inverse : inventer une marque que le modèle n'a pas posée. */
      const referents: Record<string, 'ANAPHORA' | 'TEMPORAL'> = {};
      for (const [cle, genre] of Object.entries(reponse.referents ?? {})) {
        if (Object.hasOwn(reponse.parametres, cle)) referents[cle] = genre;
      }

      return ok({
        kind: 'TOOL_CALL',
        toolId: connu.definition.id,
        input: reponse.parametres,
        parameterProvenance: provenance,
        /* Une proposition de modèle n'est pas plus sûre parce qu'elle est
           confiante. Le chiffre sert à comparer deux propositions, jamais à
           justifier de ne pas demander. */
        confidence: 0.6,
        tier: 1,
        /* ⚠ JAMAIS `true`, ET CE N'EST PAS NÉGOCIABLE.

           `userConfirms` dit « l'énoncé VAUT confirmation ». Une règle `Tier 0`
           peut l'affirmer parce qu'elle reconnaît une formule impérative exacte.
           Un modèle qui l'affirmerait affirmerait seulement qu'il le pense —
           et ce serait au modèle de décider s'il faut demander la permission. */
        userConfirms: false,
        /* ⚠ LE MODÈLE SIGNALE LE RENVOI ; IL NE LE RÉSOUT JAMAIS — ADR-084.

           Ce qui suit est la garantie qui rend cette liberté acceptable, et
           elle tient parce qu'AUCUN chemin ne mène à une action silencieuse :

             marque juste    → l'Assistant résout sur PREUVE (entité évoquée,
                               date calculée par la base), et le Policy Gate
                               fait confirmer la valeur concrète obtenue
             marque fausse   → la résolution ne trouve rien, ou trouve deux
                               candidats → CLARIFY. Une QUESTION
             marque absente  → comportement d'avant : le paramètre garde les
                               mots du modèle, et se fait confirmer tel quel

           Les trois issues sont visibles. La pire dégradation possible est une
           confirmation qui nomme la mauvaise chose — que l'utilisateur refuse
           — jamais une action juste-vraisemblable exécutée sans être montrée.

           Et la valeur SUBSTITUÉE garde la provenance `MODEL_OUTPUT` bien
           qu'elle vienne du résolveur, donc de la base. C'est délibérément
           conservateur : ça exige plus de confirmation, jamais moins. */
        referents,
      });
    },
  };
}
