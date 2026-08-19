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

## Services externes

Un service n'est pas un paquet : il ne s'installe pas, il se **connecte**. Sa
fiche est donc plus courte sur la maintenance et beaucoup plus longue sur ce
qu'il voit.

### Google Calendar API — v3

```yaml
raison_d_etre:      Écrire un rappel LÀ OÙ IL SONNE. L'agenda Google de Julien
                    est déjà synchronisé vers son iPhone ; un événement créé ici
                    déclenche une notification qu'aucun code local ne saurait
                    produire.
pourquoi_pas_natif: Construire un ordonnanceur et un canal de notification
                    iOS serait des semaines de travail pour reproduire ce que le
                    téléphone fait déjà. `CLAUDE.md` règle 4 — assembler avant
                    de développer.
paquet_npm:         AUCUN. L'API est du REST sur HTTPS et Node 22 porte `fetch`.
                    Le paquet officiel `googleapis` apporterait des centaines de
                    dépendances transitives pour quatre requêtes : il ne mérite
                    pas son droit d'exister (`04 §1`).
criticite:          NON CRITIQUE. Jarvis fonctionne entièrement sans — les
                    rappels restent visibles dans le briefing du matin.
licence:            Service, pas logiciel. Conditions Google Cloud Platform.
                    Usage personnel : gratuit dans les quotas courants.
donnees_vues:       Titre, date de début et de fin des événements créés ou lus.
                    Classe maximale déclarée : ORANGE. Une donnée RED ne peut
                    pas l'atteindre — le Policy Gate consulte
                    `maxPrivacyClass` du fournisseur.
                    ⚠ Google voit donc ce que Julien écrit dans son agenda.
                    C'est déjà le cas aujourd'hui : l'intégration n'ajoute
                    aucune exposition, elle en tire parti.
acces_reseau:       HTTPS sortant vers `www.googleapis.com` et
                    `oauth2.googleapis.com`. Aucun autre hôte.
secrets:            Trois, au coffre, JAMAIS dans le dépôt :
                      GOOGLE_OAUTH_CLIENT_ID
                      GOOGLE_OAUTH_CLIENT_SECRET
                      GOOGLE_OAUTH_REFRESH_TOKEN
                    Un test structurel compte les appels à `expose()` : trois,
                    tous dans la construction de la requête de jeton.
maintenance:        API stable depuis 2011, versionnée (`v3`). Google annonce
                    les retraits avec un an de préavis.
vulnerabilites:     Surface propre : aucun code tiers exécuté chez nous.
                    Le risque est la FUITE DE JETON, traitée par le coffre et
                    par l'interdiction de recopier une réponse d'authentification
                    dans un message d'erreur.
strategie_maj:      Aucune mise à jour à subir — c'est un contrat REST distant.
                    Un changement de contrat se manifeste par
                    `PROVIDER_TRUST_REVOKED`, jamais par une supposition.
fallback:           `null`. Sans compte connecté, les outils d'agenda rendent
                    `PROVIDER_UNAVAILABLE` — une réponse, pas une panne. Les
                    rappels continuent d'exister localement et de remonter dans
                    le briefing.
remplacement:       CalDAV est le protocole standard, et Apple, Fastmail,
                    Nextcloud le parlent tous. La surface utilisée ici est
                    minuscule — lister, créer, modifier, relire — et
                    l'interface `CalendarProvider` ne mentionne Google nulle
                    part. Estimé à 2–3 jours pour un adaptateur CalDAV.
                    ⚠ Une propriété serait perdue : l'idempotence par
                    identifiant fourni par le client. CalDAV la permet aussi
                    (l'UID est choisi par le client), donc le coût est réel mais
                    pas structurel.
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
