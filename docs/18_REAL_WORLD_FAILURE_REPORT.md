# 18 — RAPPORT DU BANC DE DÉFAILLANCE

**Foundation 3.** Résultats mesurés, pas raisonnés. Chaque affirmation de ce
document renvoie à un test nommé, reproductible par `pnpm test:lab`.

---

## 1. Ce que le banc a trouvé

Quatre défauts, dont **deux critiques**. Tous corrigés et reprouvés par le test
qui les avait révélés.

| # | Sévérité | Défaut | Preuve | État |
|---|---|---|---|---|
| **CRIT-3** | 🔴 | Double exécution sous concurrence | `lab/concurrency` — **20 effets** pour une clé | corrigé (ADR-029) |
| **CRIT-4** | 🔴 | Une reprise rembobine une opération en vol | `lab/crash-concurrency` — 2 effets | corrigé (ADR-029) |
| **HIGH-8** | 🟠 | `FAILED` affirmé sur la parole du fournisseur | `lab/provider-lies` | corrigé (ADR-028) |
| **MED-7** | 🟡 | Une reprise lente écrase un verdict établi | revue de `settle()` | corrigé |

### CRIT-3 — le défaut qui se cachait entre deux charges

C'est le résultat le plus important du sprint, et pas seulement parce qu'il
était grave.

| Appels simultanés, même clé | Effets externes produits |
|---|---|
| 2 | 1 ✅ |
| 10 | 1 ✅ |
| **100** | **20** 🔴 |
| 1 000 | 1 ✅ |

Le défaut **dépend de la charge**. À 1 000 appels, la saturation du pool de
connexions sérialise fortuitement les appelants et le résultat redevient
correct. Un banc qui n'aurait éprouvé qu'une seule charge — la plus élevée,
comme le veut l'intuition — aurait conclu que tout allait bien.

> **Leçon transférable :** un test de concurrence à une seule charge ne prouve
> rien. La fenêtre de course a une taille, et il faut la traverser.

**Cause.** Trois transitions d'état étaient des `UPDATE` inconditionnels,
précédées d'une lecture puis d'une insertion. Le journal d'intention protégeait
du TEMPS et pas de l'ESPACE.

**Correction.** Chaque transition est un compare-and-swap en base. Détail et
arbitrages en ADR-029.

### CRIT-4 — celui que la correction de CRIT-3 a rendu visible

Le chemin `NO_EFFECT` — le seul qui autorise une nouvelle exécution — ramenait
l'opération à `PLANNED` sans condition. Deux reprises concurrentes pouvaient
donc **rembobiner un appel déjà en vol**.

Une garde d'état ne suffisait pas : `EXECUTING` ne dit pas si l'exécutant est
mort ou vivant. Il a fallu un numéro de version (`attempts`).

### HIGH-8 — croire un `500` est aussi grave que croire un `200`

Le Gateway concluait `FAILED` de toute erreur non-timeout. Le banc a mis en
scène un fournisseur qui produit l'effet **puis** répond `500` : Jarvis
affirmait alors que rien n'avait eu lieu.

C'est la faute exactement symétrique de celle que le Verification Engine
existait pour empêcher. La règle vaut dans les deux sens :

> Une réponse de fournisseur est une **observation**, jamais une preuve —
> qu'elle soit favorable ou défavorable.

Corrigé par le champ `effect` (ADR-028), que `docs/16 §1` avait spécifié sans le
mettre en vigueur.

---

## 2. Une découverte qui n'était pas un défaut : l'inégalité était mal écrite

Depuis `docs/17`, tout le projet se ramène à :

```text
external_effect_count ≤ 1
```

Le scénario de succès partiel montre que c'est **faux**. Un envoi à cinq
destinataires produit légitimement cinq effets. La formulation correcte est :

```text
external_effect_count(clé, CIBLE) ≤ 1
```

Tant qu'aucun outil n'avait plusieurs cibles, la distinction restait invisible
— et l'énoncé restait faux. `lab/partial` vérifie désormais les deux lectures
séparément.

---

## 3. Garanties réellement démontrées

Chacune a un test nommé. `pnpm test:lab` les rejoue toutes.

### Concurrence

| Propriété | Preuve |
|---|---|
| 2 / 10 / 100 / 1 000 appels simultanés → au plus 1 effet | `lab/concurrency` |
| 4 **processus** × 25 appels → exactement 1 engagement, tous processus confondus | `lab/multiprocess` |
| Le perdant d'une course dit « rien tenté », jamais « échec » | `lab/multiprocess` |
| `attempts` ne dépasse jamais 1 | `lab/concurrency`, `lab/multiprocess` |
| Reprise concurrente depuis `PLANNED` → 1 effet | `lab/concurrency` |

Le test **multi-processus** est celui qui compte : une exclusion mutuelle en
mémoire aurait passé tous les autres.

### Crash pendant un effet externe

| Propriété | Preuve |
|---|---|
| Mort après l'effet → `EXECUTING`, 1 effet | `lab/crash-concurrency` |
| Mort avant l'effet → `EXECUTING`, 0 effet — **état indiscernable** | idem |
| 30 reprises concurrentes après crash → toujours 1 effet | idem |
| Reprise avec vérification, effet trouvé → `CONFIRMED` **sans réexécution** | idem |
| Reprise avec vérification, aucun effet → exécution, et **une seule** | idem |
| Un `UNKNOWN` ne mûrit jamais en succès (5 reprises) | idem |

Les deux premières lignes forment le cœur du problème : **les deux crashs
laissent le même état.** Aucune inspection locale ne les distingue. C'est ce qui
rend `UNKNOWN` inévitable, et le refus de rejeu obligatoire.

### Le fournisseur n'est pas une autorité

| Propriété | Preuve |
|---|---|
| `SUCCESS` sans effet → `FAILED`, jamais `CONFIRMED` | `lab/provider-lies` |
| `SUCCESS` sans effet et sans relecture → `PROBABLE` au mieux | idem |
| `ERROR` après effet → `UNKNOWN`, jamais `FAILED` | idem |
| Reprise après erreur fournisseur → aucun second effet | idem |
| `429` / `500` / `503` → 0 effet, `attempts = 1`, **aucun rejeu** | idem |
| Timeout après effet → `UNKNOWN` + `PROVIDER_TIMEOUT` | idem |

### Repli entre fournisseurs

| Propriété | Preuve |
|---|---|
| Repli **sur la même clé** après timeout de A → B n'exécute pas | `lab/provider-fallback` |
| 20 replis concurrents → B reste à 0 effet | idem |
| Un outil `EXTERNAL` laisse `UNKNOWN`, jamais une conclusion d'absence | idem |

### Exfiltration

| Propriété | Preuve |
|---|---|
| La sentinelle **détecte** une sortie réseau (témoin négatif) | `lab/exfiltration` |
| La boucle locale n'est pas comptée comme exfiltration | idem |
| Donnée de santé mémorisée → `DATA_EXFILTRATION = 0` | idem |
| Recherche mémoire, **cloud activé** → 0 sortie | idem |
| Les cinq outils enchaînés → 0 sortie, 0 résolution DNS | idem |

Mesuré en interceptant `net.Socket.prototype.connect` et `dns.lookup`, donc
**sous** tout le code applicatif. Un SDK bavard ou une télémétrie oubliée serait
vu, même si le Policy Gate n'en savait rien.

> Le témoin négatif a servi immédiatement : la première version de la sentinelle
> lisait mal les arguments de `net.connect` et enregistrait chaque sortie comme
> `localhost:0`. Elle était aveugle, et tous les tests passaient.

### Innocuité du banc

| Propriété | Preuve |
|---|---|
| Aucun module de `src/` n'importe `tests/` | `lab/lab-isolation` |
| `tool.execute` n'est appelé qu'**une fois** dans le Gateway | idem |
| Un seul `gateway.invoke` récursif, dans la branche `NO_EFFECT` | idem |
| `maxRetries` reste déclaré et lu par personne | idem |
| `lab_world_effects` n'existe dans aucune migration de production | idem |

---

## 4. Coût effectif — mesures réelles

| Scénario | p50 | succès annoncé | **vérifié** | `UNKNOWN` | coût/tâche accomplie | doublons |
|---|---|---|---|---|---|---|
| fournisseur sain | 15 ms | 100 % | **100 %** | 0 % | 0,0100 € | 0 |
| fournisseur menteur | 13 ms | 0 % | **0 %** | 0 % | **∞** | 0 |
| timeout après effet | 210 ms | 0 % | **0 %** | 100 % | **∞** | 0 |
| échecs transitoires | 14 ms | 60 % | **60 %** | 40 % | 0,0167 € | 0 |

Deux choix de calcul portent tout le tableau :

**Seul `CONFIRMED` compte au dénominateur.** Ni `PROBABLE`, ni `UNKNOWN`. Sinon
on divise par des succès supposés — c'est l'erreur de tout tableau de bord de
fournisseur d'IA, et elle est flatteuse par construction.

**`∞` n'est pas une anomalie.** Un fournisseur qui ne confirme jamais n'a pas un
coût par succès élevé : il n'en a pas, faute de succès. La ligne « menteur »
serait affichée « 100 % de réussite » par n'importe quel tableau de bord fondé
sur les codes HTTP.

**Le coût dominant n'est pas monétaire.** Chaque `UNKNOWN` consomme une décision
humaine : quelqu'un doit aller vérifier si l'email est parti. La colonne
`UNKNOWN` mérite d'être lue avant la colonne « coût ».

---

## 5. Garanties encore impossibles à démontrer

Aucune ne le deviendra en écrivant un test.

**La fenêtre irréductible.** Entre l'écriture `EXECUTING` et le retour de
l'appel, un instant existe où le processus peut mourir sans que personne ne
sache. Le compare-and-swap ne la ferme pas — il ne fait que garantir qu'un seul
appelant y entre. La supprimer exigerait une transaction distribuée avec le
fournisseur, qu'aucune API réelle n'offre.

**Le fournisseur asynchrone.** `lab/provider-lies` documente le cas : le
fournisseur accuse réception, Jarvis relit, ne trouve rien, conclut `FAILED` —
et l'effet arrive trois cents millisecondes plus tard. La réconciliation
différée n'existe pas. C'est une **dette nommée**, pas une propriété.

**Le repli à nouvelle clé.** `lab/provider-fallback` le mesure sans le corriger :
deux clés, deux effets, une seule intention utilisateur. Le noyau ne voit pas
les intentions, seulement des clés. Aucune correction n'est possible à ce
niveau — c'est un invariant de routeur (`docs/19 §3`).

**Le multi-machines.** Toutes les garanties reposent sur PostgreSQL comme point
de sérialisation unique. Une base répliquée en écriture les invaliderait toutes.
Non testé, parce que non architecturé.

**Le changement de sémantique d'un fournisseur.** Un service peut modifier son
comportement d'idempotence entre deux versions, sans préavis. Aucun test écrit
aujourd'hui ne le détectera.

**Le succès partiel.** `PARTIAL` n'existe pas. `lab/partial` prouve
qu'aucun des quatre statuts ne peut décrire trois envois réussis sur cinq —
preuve exhaustive sur l'énumération, donc solide si un cinquième statut
apparaît. Spécifié en `docs/19`, non implémenté.

---

## 6. Risques résiduels assumés

| Risque | Pourquoi il est accepté |
|---|---|
| N−1 appels concurrents reçoivent un refus | Comportement des API à clé d'idempotence. `FAIL CLOSED` appliqué à la concurrence. |
| Un outil `EXTERNAL` peut encore déclarer `attemptVerification: NONE` | L'interdire exclurait des familles d'outils légitimes. Choix produit, pas correction — `docs/16 §3`. |
| La valeur de retour et le registre ne disent pas la même chose sur timeout | L'appelant reçoit une erreur, le journal écrit `UNKNOWN`. Incohérence de forme, pas de fond — à unifier en Foundation 4. |
| `CONFLICTING_EVIDENCE` reste inatteignable | Une seule source d'observation par outil. Reconduit de `docs/16 §5`. |
| Le banc mesure un « monde » qui est une base PostgreSQL | Plus fiable qu'un vrai fournisseur, mais plus régulier aussi. Un vrai service réordonne, ce que le banc ne simule pas encore. |

---

## 7. Reproduire

```bash
pnpm test:lab                                    # les 53 tests du banc
npx vitest run tests/lab/concurrency.test.ts     # CRIT-3
npx vitest run tests/lab/crash-concurrency.test.ts  # CRIT-4
npx vitest run tests/lab/exfiltration.test.ts    # DATA_EXFILTRATION
npx vitest run tests/lab/cost.test.ts            # tableau du §4
```

Pour **revoir** CRIT-3 : retirer `AND state = 'PLANNED'` de la première
transition dans `src/core/tools/gateway.ts`, puis relancer
`tests/lab/concurrency.test.ts`. Le test à 100 appels redevient rouge.

---

## 8. Ce que ce sprint dit du reste du projet

Trois des quatre défauts se trouvaient dans du code **écrit pour la sécurité**,
relu, documenté par un ADR, et couvert par des tests verts. Aucun n'a été
trouvé par relecture ; tous l'ont été par mesure.

C'est l'argument le plus solide en faveur du banc, et il vaut d'être retenu
avant Foundation 4 : **ce qui n'est pas mesuré sous panne n'est pas su.**

Une note d'hygiène pour finir. Ce dépôt compte désormais **19 documents**, et
`docs/17` a dû être corrigé par `docs/18` sur son énoncé central. C'est
précisément le mécanisme que `docs/14 §1` dénonce à propos des classifications :
deux sources qui coexistent finissent par diverger. La passe de consolidation
n'est plus une amélioration souhaitable — elle est due.
