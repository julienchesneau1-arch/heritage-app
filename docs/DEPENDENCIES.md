# Registre des dépendances

`04 §1` impose qu'une dépendance remplisse sa fiche **avant** d'être ajoutée. Ce
fichier est ce registre. Une dépendance absente d'ici ne doit pas apparaître dans
`package.json`.

Le champ le plus important de chaque fiche est le dernier : **comment on la
remplace**. Une dépendance dont on ne sait pas décrire le remplacement n'est pas
une dépendance, c'est un engagement.

---

## Dépendances d'exécution

### `zod` — 4.4.3

```yaml
raison_d_etre:      Validation à l'exécution sur toutes les frontières du noyau.
pourquoi_pas_natif: TypeScript ne valide rien à l'exécution. ADR-016 impose une
                    validation runtime aux frontières ; l'écrire à la main pour
                    chaque schéma serait plus de code, moins testé, et sans
                    inférence de type.
criticite:          CRITIQUE
licence:            MIT — usage commercial futur : oui
donnees_vues:       Toutes les données franchissant une frontière, en mémoire
                    uniquement. Aucune sortie réseau, aucun accès disque.
acces_reseau:       aucun
maintenance:        Très actif, large adoption, mainteneur principal identifié.
vulnerabilites:     Aucune CVE connue à ce jour.
strategie_maj:      Canal STABLE. Version épinglée, montée après passage des
                    Golden Tests.
fallback:           Aucun automatique. La validation est structurante.
remplacement:       Valibot ou ArkType offrent le même modèle (schéma → type
                    inféré). Le coût est réel mais borné : la surface utilisée
                    se limite à `object`, `enum`, `safeParse` et `infer`. Estimé
                    à 1–2 jours pour l'ensemble du noyau.
```

### `pg` — 8.16.3

```yaml
raison_d_etre:      Pilote PostgreSQL. ADR-001 fait de PostgreSQL l'unique
                    magasin de vérité.
pourquoi_pas_natif: Node n'a pas de client PostgreSQL natif.
criticite:          CRITIQUE
licence:            MIT — usage commercial futur : oui
donnees_vues:       Toute la mémoire personnelle. C'est la dépendance qui voit
                    le plus de données du système.
acces_reseau:       sortant, vers localhost uniquement en configuration par
                    défaut. Aucune connexion distante sans changement explicite
                    de configuration.
maintenance:        Mature, standard de fait depuis plus de dix ans.
vulnerabilites:     Aucune CVE ouverte connue à ce jour.
strategie_maj:      Canal STABLE.
fallback:           Aucun. Sans base, pas de mémoire.
remplacement:       `postgres.js` couvre le même besoin. Notre usage est
                    volontairement confiné à `src/core/db/client.ts` : query,
                    transaction, pool. Estimé à une demi-journée.
```

### `@cedar-policy/cedar-wasm` — 4.12.0

```yaml
raison_d_etre:      Moteur d'évaluation de politique (ADR-005). Répond à « cet
                    acteur a-t-il le droit ? ».
pourquoi_pas_natif: L'autorisation est un domaine où les erreurs subtiles sont
                    coûteuses. Cedar est formellement vérifié ; le réécrire
                    contredirait la règle « assembler avant développer ».
criticite:          IMPORTANTE
                    — pas CRITIQUE : le Gate court-circuite déjà L0, RED+egress
                    et le mode privé avant toute interrogation du moteur. Une
                    panne de Cedar fait échouer l'évaluation, et le refus par
                    défaut s'applique : le système devient inutilisable, jamais
                    permissif.
licence:            Apache 2.0 — usage commercial futur : oui
donnees_vues:       Uniquement le contexte de politique : acteur, action,
                    niveau, classe de confidentialité, mode. Jamais le contenu
                    métier, jamais un secret.
acces_reseau:       aucun (WebAssembly local)
maintenance:        Développé et utilisé par AWS. Communauté plus jeune qu'OPA.
vulnerabilites:     Aucune CVE connue à ce jour.
strategie_maj:      Canal STABLE, avec repassage complet de tests/policy.
fallback:           Refus par défaut. Un moteur indisponible ne dégrade jamais
                    en « autoriser ».
remplacement:       OPA/Rego, prévu par l'ADR-005. L'interface `PolicyEvaluator`
                    est délibérément minimale (une méthode, un verdict) pour que
                    la bascule reste un travail d'adaptateur. Les politiques
                    elles-mêmes seraient à réécrire : compter 2–3 jours.
```

---

## Dépendances de développement

Elles ne s'exécutent jamais en production et ne voient aucune donnée
personnelle. Leur fiche est donc allégée, mais leur licence est vérifiée.

| Paquet | Version | Licence | Rôle | Remplacement |
|---|---|---|---|---|
| `typescript` | 5.9.2 | Apache 2.0 | Compilateur, typage strict | Aucun réaliste — c'est le langage (ADR-016) |
| `vitest` | 3.2.4 | MIT | Lanceur de tests | `node:test` natif ; migration mécanique |
| `eslint` + `typescript-eslint` | 9.36 / 8.44 | MIT / MIT | Application des règles de `06` | Biome ou oxlint |
| `tsx` | 4.20.5 | MIT | Exécution TypeScript pour l'outillage | `node --experimental-strip-types` (Node 22+) |
| `@types/node`, `@types/pg` | — | MIT | Définitions de types | — |
| `@eslint/js` | 9.36 | MIT | Configuration ESLint de base | — |
| `@vitest/coverage-v8` | 3.2.4 | MIT | Mesure de couverture (`pnpm test:coverage`) | `c8`, ou `node --experimental-test-coverage` |

> `@vitest/coverage-v8` a été ajouté pendant la phase d'audit : la question
> « quelle est la couverture ? » ne pouvait pas recevoir de réponse
> reproductible sans lui. Même mainteneur que `vitest`, déjà présent ; aucune
> exécution en production, aucune donnée vue, aucun accès réseau.

---

## Ce qui a été délibérément écarté

Ces décisions sont aussi importantes que les ajouts : chacune évite une
dépendance qu'il aurait ensuite fallu maintenir.

| Écarté | Au profit de | Raison |
|---|---|---|
| Un ORM (Prisma, Drizzle) | SQL et `pg` | Le schéma est petit et stable. Un ORM ajouterait une couche de génération, un cycle de migration parallèle au nôtre, et masquerait les `GRANT` — précisément ce qui garantit l'immuabilité du journal (ADR-012). |
| Une bibliothèque de migrations | ~150 lignes maison | Nous avons besoin d'un rollback testé dans les deux sens et d'un checksum détectant l'édition d'une migration appliquée. C'est exactement ce que fait `ops/db/migrate.ts`. |
| Un logger (pino, winston) | ~90 lignes maison | La redaction des secrets est le cœur du besoin (03 §9), pas la performance d'écriture. Une redaction déléguée à une configuration tierce est une redaction qu'on ne teste pas. |
| Une base vectorielle dédiée | pgvector dans PostgreSQL | ADR-001. |
| XTTS v2 | Piper, Kokoro | Licence CPML non commerciale (ADR-009, 08/C5). |
| Un framework d'agents | Notre orchestration | 00 §6 : pas de swarm. Ces frameworks supposent tous que le modèle pilote les outils — l'inverse exact d'ADR-004. |
