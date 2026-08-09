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
