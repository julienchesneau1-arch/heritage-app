/**
 * OLLAMA — le modèle qui tourne CHEZ TOI. ADR-082.
 *
 * ADR-007 pose Ollama comme runtime de référence, **jamais comme dépendance
 * dure** : rien ici ne dépasse de l'interface `ModelProvider`, et un adaptateur
 * llama.cpp ou MLX prendrait sa place sans que le noyau s'en aperçoive.
 *
 * C'est la dernière pièce de la chaîne mesurée par ADR-080 : les 43 % qui
 * aboutissent aujourd'hui tiennent à des règles écrites à la main. `tier1.ts`
 * attendait un modèle ; le voici.
 *
 * AUCUNE DÉPENDANCE NPM, ET AUCUNE DONNÉE QUI SORT
 * ---------------------------------------------------------------------------
 * L'API d'Ollama est du REST sur HTTP, et Node 22 porte `fetch`. Mais surtout :
 * **elle écoute sur la boucle locale.** Rien ne quitte la machine — c'est ce
 * qui rend `data-local-first` tenable avec un modèle, là où un fournisseur
 * cloud demanderait le Data Firewall, le CostGate et une décision.
 *
 * ⚠ LA GARDE QUI REND CETTE PHRASE VRAIE
 * ---------------------------------------------------------------------------
 * « Local » n'est pas une intention, c'est une **adresse**. Pointer la
 * configuration vers `http://serveur-distant:11434` transformerait Jarvis en
 * client d'un service tiers, **sans qu'aucune ligne de code ne change** et sans
 * que rien ne le signale : le fournisseur continuerait de se déclarer `local`,
 * le Policy Gate le croirait, et chaque énoncé de l'utilisateur partirait sur
 * le réseau.
 *
 * L'adresse est donc **vérifiée**, et une adresse non locale est refusée à la
 * construction — pas au premier appel. Une promesse de confidentialité qui
 * repose sur la vigilance de celui qui édite un fichier de configuration n'est
 * pas une promesse.
 *
 * ⚠ CE QUI N'A JAMAIS TOURNÉ CONTRE UN VRAI OLLAMA
 * ---------------------------------------------------------------------------
 * **Aucun Ollama n'est installé dans l'environnement où ce fichier a été
 * écrit.** Il est éprouvé contre un transport simulé : forme des requêtes,
 * traitement des réponses, cas hostiles. **Rien** de ce qu'un vrai modèle
 * produit — ni la qualité de ses choix d'outil, ni sa latence réelle.
 */
import { z } from 'zod';
import { err, jarvisError, ok, type Result } from '../../core/types/result.js';
import type {
  ChatRequest,
  ChatResponse,
  ModelProvider,
  ProviderCapabilities,
  ProviderHealth,
} from '../contract.js';
import type { Transport } from '../google/calendar.js';
import { transportReseau } from '../google/calendar.js';

/* -------------------------------------------------------------------------- */
/* La garde d'adresse                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Les seuls hôtes qui garantissent qu'une donnée ne quitte pas la machine.
 *
 * Volontairement une liste FERMÉE, et non un motif. Un motif du genre
 * « commence par 192.168 » laisserait passer le réseau local — c'est-à-dire
 * une autre machine, chez le voisin de bureau ou sur le Wi-Fi d'un café.
 */
const HOTES_LOCAUX: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

/**
 * L'adresse désigne-t-elle bien cette machine ?
 *
 * Exportée pour être éprouvée : c'est la garde dont dépend toute l'affirmation
 * « aucune donnée ne sort », et une garde non testée n'est pas une garde.
 */
export function estLocale(url: string): boolean {
  let parsee: URL;
  try {
    parsee = new URL(url);
  } catch {
    // Une adresse illisible n'est pas locale. Le doute se résout vers le refus.
    return false;
  }
  /* `https` vers la boucle locale n'a aucun sens et signale une configuration
     copiée d'ailleurs : on ne l'accepte pas non plus. */
  if (parsee.protocol !== 'http:') return false;
  return HOTES_LOCAUX.has(parsee.hostname);
}

/* -------------------------------------------------------------------------- */
/* Les réponses d'Ollama — entrée NON FIABLE, comme toute frontière           */
/* -------------------------------------------------------------------------- */

const ReponseChat = z.object({
  message: z.object({ content: z.string() }),
  model: z.string().default(''),
  prompt_eval_count: z.number().int().nonnegative().default(0),
  eval_count: z.number().int().nonnegative().default(0),
});

const ReponseTags = z.object({
  models: z.array(z.object({ name: z.string() })).default([]),
});

const ReponseEmbeddings = z.object({
  embedding: z.array(z.number()),
});

/* -------------------------------------------------------------------------- */
/* Le fournisseur                                                             */
/* -------------------------------------------------------------------------- */

export interface OptionsOllama {
  /** Adresse du service. DOIT désigner la boucle locale. */
  readonly url: string;
  /** Nom du modèle, tel qu'Ollama le connaît (`llama3.1:8b`, `mistral`…). */
  readonly model: string;
  readonly transport?: Transport;
}

export function createOllama(options: OptionsOllama): Result<ModelProvider> {
  /* ⚠ REFUS À LA CONSTRUCTION, PAS AU PREMIER APPEL.

     Un refus tardif laisserait Jarvis démarrer en se croyant local, et
     n'échouerait qu'au moment où l'utilisateur parle — c'est-à-dire au pire
     moment, et après que la configuration a été acceptée en silence. */
  if (!estLocale(options.url)) {
    return err(
      jarvisError(
        'CONFIGURATION',
        `Adresse de modèle non locale : « ${options.url} ». Un modèle « local » ` +
          `qui écoute ailleurs ferait sortir chaque énoncé de la machine sans ` +
          `qu'aucune ligne de code ne change. Seule la boucle locale est admise.`,
      ),
    );
  }

  const transport = options.transport ?? transportReseau();
  const base = options.url.replace(/\/+$/u, '');

  const capabilities: ProviderCapabilities = {
    id: `ollama:${options.model}`,
    local: true,
    /* `false` : l'appel emprunte HTTP mais ne quitte pas la machine. C'est la
       garde d'adresse ci-dessus qui rend cette déclaration honnête — sans elle,
       ce champ serait une affirmation que rien n'établit. */
    requiresNetwork: false,
    /* ⚠ `ORANGE`, ET C'EST UN CHOIX PRUDENT PLUTÔT QUE JUSTE.

       `docs/14` autorise un traitement LOCAL sur des données `HIGHLY_SENSITIVE`,
       ce qui plaiderait pour `RED`. Mais `PrivacyClass` confond en `RED` ce que
       le modèle fin distingue : les données très sensibles (traitables
       localement) et les SECRETS (« aucun — pas même local »).

       Tant que cette confusion existe — la migration `data_level` l'attend,
       `docs/29` — déclarer `RED` ouvrirait la porte aux seconds pour servir les
       premières. `ORANGE` suffit largement : le `Tier 1` ne voit que l'énoncé
       de l'utilisateur et le catalogue d'outils, jamais le contenu de la
       mémoire. */
    maxPrivacyClass: 'ORANGE',
    costPerMillionTokensEur: 0,
  };

  async function poster(chemin: string, corps: unknown): Promise<Result<string>> {
    try {
      const r = await transport(`${base}${chemin}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corps),
      });
      if (r.status !== 200) {
        return err(
          jarvisError(
            'PROVIDER_UNAVAILABLE',
            `Ollama a refusé la demande (HTTP ${String(r.status)}). ` +
              `Le modèle « ${options.model} » est-il installé ?`,
          ),
        );
      }
      return ok(r.body);
    } catch (cause) {
      return err(traduire(cause));
    }
  }

  function lire<T>(corps: string, schema: z.ZodType<T>): Result<T> {
    let brut: unknown;
    try {
      brut = JSON.parse(corps);
    } catch {
      return err(
        jarvisError('PROVIDER_TRUST_REVOKED', 'Ollama a répondu autre chose que du JSON'),
      );
    }
    const valide = schema.safeParse(brut);
    if (!valide.success) {
      return err(
        jarvisError(
          'PROVIDER_TRUST_REVOKED',
          `réponse d'Ollama non conforme : ${valide.error.issues[0]?.path.join('.') ?? '?'}`,
        ),
      );
    }
    return ok(valide.data);
  }

  const provider: ModelProvider = {
    capabilities,

    async health(): Promise<Result<ProviderHealth>> {
      try {
        const r = await transport(`${base}/api/tags`, { method: 'GET', headers: {} });
        if (r.status !== 200) {
          return ok({ available: false, detail: `HTTP ${String(r.status)}` });
        }
        const lu = lire(r.body, ReponseTags);
        if (!lu.ok) return ok({ available: false, detail: lu.error.message });

        /* LE MODÈLE DEMANDÉ EST-IL RÉELLEMENT LÀ ? Ollama accepte la connexion
           même sans lui, et n'échoue qu'à l'appel. Le dire ici évite un
           « indisponible » incompréhensible au moment où l'utilisateur parle.

           Comparaison par PRÉFIXE : Ollama nomme ses modèles `mistral:latest`,
           et l'utilisateur écrit `mistral`. */
        const noms = lu.value.models.map((m) => m.name);
        const present = noms.some(
          (n) => n === options.model || n.startsWith(`${options.model}:`),
        );
        return ok({
          available: present,
          detail: present
            ? `modèle « ${options.model} » chargé`
            : `Ollama répond, mais « ${options.model} » n'est pas installé ` +
              `(disponibles : ${noms.join(', ') || 'aucun'})`,
        });
      } catch (cause) {
        return ok({ available: false, detail: traduire(cause).message });
      }
    },

    async chat(request: ChatRequest): Promise<Result<ChatResponse>> {
      const brut = await poster('/api/chat', {
        model: options.model,
        messages: request.messages,
        stream: false,
        options: {
          // `?? 0` : le déterminisme est le défaut, pas une option à demander.
          temperature: request.temperature ?? 0,
          ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
        },
      });
      if (!brut.ok) return brut;

      const lu = lire(brut.value, ReponseChat);
      if (!lu.ok) return lu;
      return ok({
        content: lu.value.message.content,
        model: lu.value.model,
        promptTokens: lu.value.prompt_eval_count,
        completionTokens: lu.value.eval_count,
        // Local : zéro. C'est le chiffre qu'ADR-017 vise sur 80–95 % des tours.
        costEur: 0,
      });
    },

    async structuredOutput<T>(
      request: ChatRequest,
      validate: (raw: unknown) => Result<T>,
    ): Promise<Result<T>> {
      /* `format: 'json'` contraint Ollama à produire du JSON syntaxiquement
         valide. Cela ne dit RIEN de sa conformité au schéma attendu — d'où la
         validation qui suit, faite par l'appelant. Une sortie de modèle reste
         une entrée non fiable, y compris quand elle prétend être du JSON. */
      const brut = await poster('/api/chat', {
        model: options.model,
        messages: request.messages,
        stream: false,
        format: 'json',
        options: {
          temperature: request.temperature ?? 0,
          ...(request.maxTokens === undefined ? {} : { num_predict: request.maxTokens }),
        },
      });
      if (!brut.ok) return brut;

      const enveloppe = lire(brut.value, ReponseChat);
      if (!enveloppe.ok) return enveloppe;

      let charge: unknown;
      try {
        charge = JSON.parse(enveloppe.value.message.content);
      } catch {
        /* `VALIDATION` et non `PROVIDER_TRUST_REVOKED` : Ollama a fait son
           travail — il a transmis ce que le modèle a produit. C'est le MODÈLE
           qui n'a pas respecté la consigne, et cela arrive normalement. Rompre
           la confiance dans le fournisseur pour une réponse mal formée
           punirait le messager. */
        return err(
          jarvisError('VALIDATION', "le modèle n'a pas produit le JSON demandé"),
        );
      }
      return validate(charge);
    },

    async embeddings(texts: readonly string[]): Promise<Result<readonly number[][]>> {
      const vecteurs: number[][] = [];
      for (const texte of texts) {
        const brut = await poster('/api/embeddings', {
          model: options.model,
          prompt: texte,
        });
        if (!brut.ok) return brut;
        const lu = lire(brut.value, ReponseEmbeddings);
        if (!lu.ok) return lu;
        vecteurs.push(lu.value.embedding);
      }
      return ok(vecteurs);
    },
  };

  return ok(provider);
}

/**
 * Traduit une exception de transport.
 *
 * Même distinction qu'ADR-080 : cesser d'attendre n'est pas échouer. Ici
 * l'enjeu est moindre — aucune action n'a d'effet — mais l'uniformité vaut
 * mieux que l'exception justifiée au cas par cas.
 */
function traduire(cause: unknown): ReturnType<typeof jarvisError> {
  const nom = cause instanceof Error ? cause.name : '';
  if (nom === 'TimeoutError' || nom === 'AbortError') {
    return jarvisError(
      'TIMEOUT',
      "le modèle local n'a pas répondu dans le délai — il charge peut-être encore",
    );
  }
  return jarvisError(
    'PROVIDER_UNAVAILABLE',
    `Ollama est injoignable : ${cause instanceof Error ? cause.message : 'cause inconnue'}. ` +
      'Est-il lancé ?',
  );
}
