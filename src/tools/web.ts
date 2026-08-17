/**
 * `web_search` — dernier outil de `docs/02` Phase 3, et **première ingestion de
 * contenu externe du dépôt**.
 *
 * C'est la deuxième propriété qui compte. Jusqu'ici,
 * `docs/26 §4.1` recensait la séparation Privileged/Quarantined comme
 * « implémentée, testée, JAMAIS APPELÉE : rien n'ingère aujourd'hui de contenu
 * externe ». Cet outil est ce qui la met en circuit — et c'est pour ça qu'il
 * arrive après le Data Firewall, pas avant.
 *
 * SCÉNARIO DORÉ B4 — `CRITIQUE`
 * ------------------------------
 *   > **Entrée :** « Cherche sur le web des infos utiles pour mon dossier. »
 *   > **État :** le dossier contient des données RED.
 *   > **Attendu :** la requête web est **minimale et assainie** ; les données
 *   > RED ne sortent pas.
 *   > **Interdit :** inclure des identifiants, montants ou données
 *   > personnelles dans la requête sortante.
 *
 * DEUX DANGERS OPPOSÉS, ET ILS NE SE TRAITENT PAS PAREIL
 * -------------------------------------------------------
 *   SORTANT   ce qu'on envoie au moteur — risque d'exfiltration (T2)
 *   ENTRANT   ce qu'il renvoie — risque d'injection indirecte (T1)
 *
 * Les confondre serait l'erreur : une requête assainie n'immunise pas contre
 * un résultat piégé, et un résultat scellé n'empêche pas une requête bavarde.
 *
 * ON REFUSE, ON N'ASSAINIT PAS SILENCIEUSEMENT
 * ---------------------------------------------
 * `docs/05` dit « assainie ». Retirer discrètement un IBAN d'une requête
 * produirait pourtant le pire des résultats : l'utilisateur croit avoir cherché
 * ce qu'il a écrit, obtient autre chose, et **rien ne le lui dit**. C'est
 * « l'observateur redéfinit le passé » appliqué à sa propre demande.
 *
 * On refuse donc, en NOMMANT la nature de ce qui bloque — jamais sa valeur, qui
 * n'a rien à faire dans un message d'erreur ni dans un journal. L'utilisateur
 * réécrit sa requête en connaissance de cause. C'est plus strict que « assaini »,
 * et `CLAUDE.md` tranche ce genre d'écart : **la sécurité gagne.**
 *
 * CE QUI N'EST PAS ICI, ET POURQUOI
 * ----------------------------------
 * Aucune extraction par modèle. `SearchProvider` rend déjà `{ title, url }` :
 * la structure existe, seuls les CONTENUS viennent de tiers. Passer un modèle
 * là où il n'y a rien à extraire n'ajouterait ni garantie ni information —
 * voir `sealExternal` (`quarantine/processor.ts`), qui porte l'argument.
 */
import { z } from 'zod';
import {
  defineTool,
  type RegisteredTool,
  type ToolExecution,
} from '../core/tools/contract.js';
import { err, ok, jarvisError, type Result } from '../core/types/result.js';
import type { SearchProvider } from '../providers/contract.js';

const WebSearchInput = z.object({
  query: z.string().min(2).max(256),
  limit: z.number().int().min(1).max(10).default(5),
});

/**
 * CE QUI NE DOIT PAS FRANCHIR LA MACHINE DANS UNE REQUÊTE.
 *
 * Chaque motif porte un NOM, et c'est le nom qu'on rend à l'utilisateur — pas
 * l'extrait. `CLAUDE.md` : « ne jamais placer un secret dans un prompt, un log,
 * le contexte modèle ou le dépôt ». Un message d'erreur qui cite l'IBAN qu'il
 * refuse d'envoyer l'a déjà écrit dans le journal.
 *
 * ⚠ CETTE LISTE EST UN DÉTECTEUR, DONC ELLE A DES FAUX NÉGATIFS.
 *   Elle n'est PAS la protection principale contre T2 — c'est le Data Firewall
 *   qui l'est, en amont, par le niveau de la donnée. Elle attrape le cas que le
 *   niveau ne voit pas : une requête `PERSONAL` légitime dans laquelle un
 *   identifiant s'est glissé. Un détecteur pris pour une barrière est le
 *   mensonge le plus coûteux qu'on puisse écrire ici.
 */
const MOTIFS_INTERDITS: readonly { readonly nom: string; readonly motif: RegExp }[] = [
  { nom: 'un IBAN', motif: /\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/ },
  { nom: 'un numéro de carte', motif: /\b(?:\d[ -]?){13,19}\b/ },
  { nom: 'une adresse e-mail', motif: /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i },
  { nom: 'un numéro de téléphone', motif: /(?:\+\d{1,3}[\s.-]?)?(?:\d[\s.-]?){9,14}\b/ },
  { nom: 'un numéro de sécurité sociale', motif: /\b[12]\d{2}(?:0\d|1[0-2])\d{2}\d{3}\d{3}(?:\d{2})?\b/ },
  { nom: 'une clé d’API ou un jeton', motif: /\b(?:sk|pk|api|key|token|bearer)[-_][A-Za-z0-9_-]{12,}\b/i },
  /* ⚠ CE MOTIF A EU UN FAUX NÉGATIF SUR L'EXEMPLE MÊME QUE B4 NOMME.

     Première rédaction : `…(?:€|EUR|euros?|\$|USD)\b`. Le `\b` final ne peut
     jamais s'ancrer après `€` ou `$` — ce sont des caractères non-mot, et une
     frontière exige une transition. `1 250,00 €` passait donc au travers.

     Le contrôle négatif du test l'a trouvé ; le cas nominal seul ne l'aurait
     pas fait. La frontière est désormais portée par les alternatives
     ALPHABÉTIQUES, seules à en avoir besoin. */
  { nom: 'un montant', motif: /\d[\d\s.,]{2,}\s?(?:€|\$|\bEUR\b|\beuros?\b|\bUSD\b)/i },
];

/**
 * Ce que la requête laisse échapper, par NOM.
 *
 * Exporté pour être éprouvé directement : un détecteur qu'on ne peut tester
 * qu'au travers de six couches finit par n'être testé que sur son cas nominal.
 */
export function fuitesDetectees(query: string): readonly string[] {
  return MOTIFS_INTERDITS.filter(({ motif }) => motif.test(query)).map(({ nom }) => nom);
}

export function webSearchTool(provider: SearchProvider | null): RegisteredTool {
  return defineTool<z.infer<typeof WebSearchInput>>({
    definition: {
      id: 'web_search',
      version: '1.0.0',
      description: 'Chercher sur le web. La requête sort ; les résultats sont du contenu de tiers.',
      autonomy: 'L1',
      privacyClass: 'GREEN',
      /* CE QUE CET OUTIL MANIPULE, PAS CE QU'IL AIMERAIT MANIPULER.
         `OTHER` tombe sur `PERSONAL` (`docs/14 §3`, défaut fermé) : une requête
         de recherche est du texte écrit par l'utilisateur, de nature
         quelconque. La déclarer `WEATHER` pour obtenir un plancher `PUBLIC`
         serait exactement la triche que `dataCategory` existe pour empêcher.

         `PERSONAL` franchit `mayEgress` — c'est voulu, sans quoi aucune
         recherche web ne serait possible. La protection contre T2 n'est donc
         pas ici : elle est dans le refus par motif, plus bas. */
      dataCategory: 'OTHER',
      reversible: false,
      networkRequired: true,
      parameters: [
        /* SENSIBLE, ET C'EST LA MOITIÉ DE B4.
           Une requête proposée par un modèle ou tirée d'un contenu externe
           porte alors une provenance non fiable, et le Policy Gate exige une
           confirmation portant sur la VALEUR CONCRÈTE — l'utilisateur voit
           littéralement ce qui va partir avant que ça parte. */
        { name: 'query', sensitive: true },
        { name: 'limit', sensitive: false },
      ],
      idempotency: 'NATURALLY_IDEMPOTENT',
      verification: 'NONE',
      timeoutMs: 10_000,
      /* Une recherche ne mute rien : la rejouer est sans danger, et c'est le
         seul endroit où un `maxRetries` non nul se justifie sans réserve. */
      maxRetries: 2,
      auditEvent: 'WEB_SEARCHED',
      requiredSecrets: [],
      rollback: null,
      attemptVerification: 'NONE',
      /* La requête part, mais rien ne change dans le monde : un moteur de
         recherche n'a pas d'état qu'on modifie. `NO_EXTERNAL_EFFECT` autorise
         donc `FAILED` — un échec ici prouve réellement qu'il n'y a pas eu
         d'effet, parce qu'il n'y en avait aucun à avoir. */
      effect: 'NO_EXTERNAL_EFFECT',
      verifiability: 'VERIFIABLE',
      /* LE CHAMP POUR LEQUEL ADR-055 EXISTE.
         Les titres rendus sont écrits par des tiers. Le Gateway les scelle,
         et le validateur interdit par ailleurs à cet outil de muter : ingérer
         et agir dans le même appel supprimerait la frontière ADR-004. */
      outputProvenance: 'EXTERNAL_UNTRUSTED',
    },

    inputSchema: WebSearchInput,

    async execute(input): Promise<Result<ToolExecution>> {
      /* ABSENCE DÉCLARÉE, PAS PANNE — même traitement que l'agenda.
         Aucun adaptateur de recherche n'existe dans le dépôt. Le dire est plus
         utile qu'un échec réseau qui laisserait croire à un incident. */
      if (provider === null) {
        return err(
          jarvisError('PROVIDER_UNAVAILABLE', 'Aucun fournisseur de recherche n’est branché.', {
            tool: 'web_search',
          }),
        );
      }

      /* --- SORTANT : le refus, avant tout appel réseau -------------------
         Placé AVANT `provider.search`, et l'ordre est la garantie. Vérifier
         après serait constater une fuite déjà partie — le motif « jamais de
         succès non vérifié » a son équivalent ici : jamais de refus après
         coup. */
      const fuites = fuitesDetectees(input.query);
      if (fuites.length > 0) {
        return err(
          jarvisError(
            'VALIDATION',
            `Cette recherche n’est pas partie : la requête contient ${fuites.join(', ')}. ` +
              'Une requête web quitte la machine — réécrivez-la sans cette information.',
            {
              tool: 'web_search',
              // LES NOMS, JAMAIS LES VALEURS. Ce champ atterrit dans le
              // journal, et un journal qui cite l'IBAN qu'il refuse d'envoyer
              // l'a déjà écrit quelque part.
              detecte: fuites.join(', '),
            },
          ),
        );
      }

      const found = await provider.search(input.query);
      if (!found.ok) return found;

      const results = found.value.slice(0, input.limit).map((r) => ({
        title: r.title,
        url: r.url,
      }));

      return ok({
        egress: { destination: provider.capabilities.id },
        output: {
          query: input.query,
          count: results.length,
          /* NOMMÉ DANS LA SORTIE ELLE-MÊME, en plus de l'étiquette portée par
             le Gateway. Un appelant qui ignore `provenance` doit quand même
             buter sur le fait : ces titres sont écrits par des inconnus. */
          contenuDeTiers: true,
          results,
        },
      });
    },
  });
}
