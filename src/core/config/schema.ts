/**
 * Schéma de configuration.
 *
 * `06` impose : « aucune configuration critique cachée dans le code ».
 * La configuration non secrète vit dans `config/`, les secrets viennent de
 * l'environnement et ne sont jamais sérialisés (03 §9).
 */
import { z } from 'zod';

export const Environment = z.enum(['dev', 'test', 'lab', 'production']);
export type Environment = z.infer<typeof Environment>;

/** Partie publique : versionnée dans le dépôt, lisible, diffable. */
export const PublicConfig = z.object({
  environment: Environment,

  policy: z.object({
    /**
     * Répertoire des politiques Cedar. Les politiques dures y sont
     * en lecture seule pour l'application (03 §5).
     */
    directory: z.string().min(1),
    /**
     * Comportement quand aucune politique ne statue.
     * `deny` est le seul défaut acceptable pour un moteur d'autorisation.
     */
    defaultDecision: z.literal('deny'),
  }),

  cloud: z.object({
    /** 04 §9 — défaut 0 €. */
    budgetMonthlyEur: z.number().min(0),
    alertAtPercent: z.number().min(0).max(100),
    hardBlockAtPercent: z.number().min(0).max(100),
    /** I2 — le cloud doit pouvoir être coupé globalement. */
    enabled: z.boolean(),
  }),

  /**
   * Le modèle LOCAL — ADR-082.
   *
   * `enabled: false` par défaut, et c'est un invariant produit : Jarvis doit
   * fonctionner sans aucun modèle installé (I1, I2). L'activer élargit la
   * compréhension ; ne pas l'activer ne casse rien.
   */
  localModel: z.object({
    enabled: z.boolean(),
    /**
     * DOIT désigner la boucle locale. Vérifié à la construction du fournisseur,
     * pas seulement ici : une adresse distante ferait sortir chaque énoncé de
     * la machine sans qu'aucune ligne de code ne change.
     */
    url: z.string().min(1),
    /**
     * Nom du modèle tel que le runtime le connaît (`mistral:7b`, `qwen2.5:14b`…).
     *
     * ⚠ LE DÉFAUT A CHANGÉ — ADR-086. Il valait `llama3.1:8b`, dont la licence
     * porte des restrictions d'usage commercial. Un défaut est ce que prend
     * quelqu'un qui ne choisit pas : le dépôt ne peut pas signaler la question
     * de licence dans `docs/04` et proposer par défaut le seul modèle qui la
     * pose. `mistral:7b` est Apache 2.0.
     *
     * Ce n'est pas un jugement de qualité — c'est le refus d'imposer une
     * contrainte juridique par omission.
     */
    model: z.string().min(1),
  }),

  privacy: z.object({
    /** 03 §7 — mode privé actif au démarrage ? */
    startInPrivateMode: z.boolean(),
    /** 04 — la télémétrie externe est désactivée par défaut, sans exception. */
    externalTelemetry: z.literal(false),
  }),

  ledger: z.object({
    /** Vérifier la chaîne de hash au démarrage. Coûteux mais rassurant. */
    verifyChainOnStartup: z.boolean(),
  }),

  database: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    name: z.string().min(1),
    /** Rôle applicatif : SELECT/INSERT sur le journal, jamais UPDATE/DELETE. */
    user: z.string().min(1),
    poolMax: z.number().int().positive(),
    statementTimeoutMs: z.number().int().positive(),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

/**
 * Partie secrète. Jamais écrite dans un fichier de configuration, jamais
 * journalisée, jamais transmise à un modèle.
 *
 * Le type est volontairement séparé de `PublicConfig` pour qu'une
 * sérialisation accidentelle de la configuration ne puisse pas emporter un
 * secret avec elle.
 */
export const SecretConfig = z.object({
  databasePassword: z.string().min(1),
});
export type SecretConfig = z.infer<typeof SecretConfig>;

export interface Config {
  readonly public: PublicConfig;
  readonly secret: SecretConfig;
}
