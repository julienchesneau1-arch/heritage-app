# 22 — EXTERNAL REALITY & FAILURE LABORATORY : conception

**Foundation 5, phase DISCOVERY.** Aucune ligne de banc n'est écrite. Ce
document existe pour que la conception soit critiquable **avant** d'être
coûteuse à changer.

**Discipline appliquée à chaque affirmation de ce document :**

```text
HYPOTHÈSE → CONTRE-EXEMPLE CHERCHÉ → PROPRIÉTÉ → TEST ENVISAGÉ
          → GARANTIE RÉELLEMENT OBTENUE → LIMITE NON TESTABLE
```

Aucune correction n'est apportée pendant cette phase. Là où une mesure a déjà
été faite, elle est signalée comme telle.

---

## 1. Les six invariants imposés avant implémentation

Ils encadrent tout le reste du document.

| | Invariant |
|---|---|
| **F5-1** | Un bail n'est **jamais** une preuve de mort d'un processus. |
| **F5-2** | Un bail n'est **jamais** une preuve d'absence d'effet externe. |
| **F5-3** | Toute écriture interne postérieure à une reprise exige un **jeton de cloisonnement** (*fencing token*). |
| **F5-4** | Le banc distingue **la réalité du fournisseur** de **ce que Jarvis peut observer**. Jarvis n'accède jamais à la première. |
| **F5-5** | L'autonomie ne découle pas de la seule preuve : **Policy, risque et réversibilité restent souverains**. |
| **F5-6** | Toutes les identités d'une opération restent traçables **de l'intention jusqu'à l'effet externe**. |

> **Un bail est un mécanisme de COORDINATION.** Il répond à « qui a le droit de
> travailler maintenant ? ». Il ne répond ni à « l'autre est-il mort ? », ni à
> « le monde a-t-il changé ? ».

---

## 2. Six réalités qu'on avait fondues en une

C'est la correction conceptuelle centrale du sprint. Chacune est mesurable
séparément, et les confondre a déjà produit deux défauts.

```text
DATABASE TIME               quelle heure la base rend-elle, et laquelle ?
PROCESS LIVENESS            le processus tourne-t-il encore ?
LEASE OWNERSHIP             qui détient le droit d'agir ?
FENCING                     quelle GÉNÉRATION de propriétaire est valide ?
EXTERNAL REQUEST LIFECYCLE  la requête est-elle encore en vol ?
EXTERNAL EFFECT             le monde a-t-il changé ?
```

### 2.1 Le temps de la base — **déjà mesuré**

| Hypothèse | `now()` reflète l'heure courante |
|---|---|
| **Contre-exemple cherché** | une transaction longue qui fige `now()` |
| **Mesure** | ✅ effectuée — `now()` a rendu **0 s d'écart sur 2,5 s réelles** dans une transaction ouverte ; `clock_timestamp()` avance |
| **Propriété** | `now()` = `transaction_timestamp()` = heure de DÉBUT de transaction |

**Où en est le code aujourd'hui.** Le contrôle de bail utilise `now()` dans une
requête isolée, donc dans sa propre transaction implicite : il est **correct
aujourd'hui**.

**La direction de l'erreur latente compte, et elle rassure.** Si le contrôle se
retrouvait un jour dans une transaction longue, `now()` serait *antérieur* au
temps réel. La condition `executing_at > now() − bail` deviendrait alors **plus
souvent vraie** : le bail paraîtrait vivant plus longtemps.

```text
erreur possible  →  bail sur-estimé  →  reprise BLOQUÉE
erreur exclue    →  bail sous-estimé →  reprise PRÉMATURÉE
```

C'est un risque de **disponibilité**, jamais de **sûreté**. Le distinguer est
exactement ce que ce document doit faire — et ne pas le distinguer aurait
produit soit une panique injustifiée, soit une fausse sérénité.

**Test envisagé** : mesurer les trois horloges (`transaction_timestamp`,
`statement_timestamp`, `clock_timestamp`) dans et hors transaction, et vérifier
qu'un contrôle de bail exécuté dans une transaction longue **bloque** au lieu
d'autoriser.

**Limite non testable** : rien ici ne dit quoi que ce soit sur les requêtes en
vol. Une horloge parfaite ne résout pas §2.2.

### 2.2 Ce qu'aucune horloge ne résout

```text
« Quelle heure est-il ? »            → clock_timestamp() répond
« L'ancienne requête est-elle
   encore en vol chez Stripe ? »     → RIEN ne répond
```

C'est la limite dure du système, et elle est indépendante de la qualité du
bail. Elle justifie F5-2 à elle seule.

---

## 3. Le jeton de cloisonnement — le mécanisme manquant

### 3.1 Le problème

```text
A détient le bail #41
A ──► fournisseur          (requête en vol)
  ✗  A disparaît
     le bail expire
B acquiert le bail #42
B ──► fournisseur
     A revient et tente d'écrire son résultat
```

Sans cloisonnement, l'écriture tardive de A **écrase** l'état établi par B. Le
système raconterait alors l'histoire de A à propos d'un monde façonné par B.

### 3.2 Ce qu'il protège, et ce qu'il ne protège pas

| Protégé par le fencing | **Non** protégé |
|---|---|
| l'état PostgreSQL | un SMTP |
| les transitions d'état | une API distante |
| les décisions de reprise | un virement |
| les écritures tardives | une réservation externe |

> **F5-3 — Le cloisonnement protège Jarvis contre ses anciens exécutants. Il ne
> protège pas le monde extérieur contre une requête déjà partie.**

### 3.3 Conception envisagée

`tool_operations` gagne une **génération** monotone, incrémentée à chaque prise
de bail. Toute écriture d'un exécutant porte la génération qu'il détenait, et
la clause devient :

```sql
UPDATE tool_operations SET … WHERE operation_id = $1 AND lease_generation = $2
```

Un exécutant périmé obtient `rowCount = 0` et n'écrit rien.

| Hypothèse | une génération monotone suffit à cloisonner |
|---|---|
| **Contre-exemple cherché** | deux exécutants obtenant la même génération |
| **Propriété visée** | la génération s'incrémente dans le même compare-and-swap que la prise de bail — donc atomiquement |
| **Test envisagé** | A#41 tente d'écrire après que B a pris #42 → écriture refusée, et Jarvis le journalise |
| **Garantie obtenue** | cohérence de l'état interne face à un exécutant zombie |
| **Limite non testable** | l'effet externe déjà produit par A reste hors d'atteinte |

---

## 4. Deux mondes, et Jarvis n'en voit qu'un

C'est F5-4, et c'est ce qui rend le banc capable de juger l'honnêteté de Jarvis
plutôt que sa conformité à un scénario.

```text
        JARVIS                          LE BANC
   ─────────────────              ──────────────────────
   request émise                  request_received
   response │ timeout             effect_started
   HTTP 500 │ 429                 effect_committed
   connection reset               effect_id · effect_count · effect_time
                                  response_sent · response_delay
```

**Jarvis n'a jamais accès à la colonne de droite.** Le banc, si.

C'est ce qui permet d'énoncer la propriété la plus intéressante du sprint :

> **Jarvis avait raison de dire `UNKNOWN` alors que l'effet avait réellement eu
> lieu.**

Un test unitaire ne peut pas exprimer cela. Deux mondes, oui.

### Ce que le monde doit enregistrer en plus d'aujourd'hui

| Table | Ce qu'elle établit |
|---|---|
| `lab_world_effects` | le monde a changé — *existe déjà* |
| `lab_provider_requests` | le fournisseur a **reçu** une demande — *à créer* |

Sans la seconde, « requête jamais reçue » et « effet produit, réponse perdue »
sont indiscernables **y compris pour le banc** — qui perdrait alors toute
capacité de juger.

---

## 5. Preuve et vérité ne sont pas la même chose

```text
RÉALITÉ  →  OBSERVATION  →  PREUVE  →  VÉRIFICATION  →  VERDICT
```

et surtout **pas** `RÉALITÉ = VERDICT`.

Deux propositions peuvent être vraies en même temps :

```text
réalité :        EFFET = OUI
ce que Jarvis sait : EFFET = UNKNOWN
```

> Ne jamais confondre « ce n'est pas observable » et « cela ne s'est pas
> produit ».

C'est la chaîne `SOURCE → EVIDENCE → INTERPRETATION → DECISION → ACTION →
OBSERVATION` d'ADR-025, poussée jusqu'à sa conséquence : **le verdict décrit
l'état de nos connaissances, pas l'état du monde.**

### Corollaire opérationnel

> **L'absence d'événement n'est jamais un événement.**

```text
REQUEST_SENT + aucune RESPONSE
    ≠  REQUEST_FAILED
    =  RESPONSE_UNKNOWN
```

---

## 6. Les huit couches du banc

| # | Couche | Ce qu'elle éprouve |
|---|---|---|
| **01** | Clock | temps de transaction, d'instruction, horloge murale, dérive, transactions longues |
| **02** | Lease | acquisition, renouvellement, expiration, concurrence, crash, gel, partition |
| **03** | Fencing | génération #41 vs #42, écriture périmée refusée |
| **04** | Request lifecycle | créée, émise, reçue, perdue, dupliquée, retardée |
| **05** | Provider reality | ce qui s'est **réellement** produit — invisible pour Jarvis |
| **06** | Observation | la projection partielle dont Jarvis dispose |
| **07** | Verdict | transitions autorisées, et uniquement sur preuve admissible |
| **08** | Recovery | crash, timeout, effet tardif, doublon, concurrence, byzantin |

### Le harnais temporel

Chaque famille de panne se définit comme une contrainte sur cinq instants, ce
qui rend la matrice énumérable au lieu d'anecdotique :

```text
t0  requête émise
t1  requête reçue par le fournisseur
t2  effet produit
t3  réponse émise
t4  réponse reçue par Jarvis   (ou jamais)
```

---

## 7. La matrice de vérité — le contrat du laboratoire

Pour chaque ligne : ce qui s'est réellement passé, ce que Jarvis voit, ce qu'il
a le droit de conclure, et s'il a le droit de rejouer.

| Réalité fournisseur | Ce que voit Jarvis | Verdict autorisé | Rejeu |
|---|---|---|---|
| aucune requête reçue | timeout | `UNKNOWN` | selon contrat |
| requête reçue, pas exécutée | timeout | `UNKNOWN` | selon contrat |
| **effet produit, réponse perdue** | timeout | `UNKNOWN` | **non**, sauf garantie |
| effet produit, réponse reçue | succès | `CONFIRMED` | non |
| effet impossible + preuve d'absence | réponse vérifiée | `FAILED` | oui |
| **effet produit, réponse `500`** | `500` | `UNKNOWN` | **non** |
| `429` avant traitement | `429` | `UNKNOWN` | selon contrat |
| requête dupliquée, fournisseur idempotent | 2 requêtes / 1 effet | selon observation | oui, même identité |
| **fournisseur prétend idempotent, produit 2 effets** | 2 effets | `PROVIDER_CONTRACT_VIOLATION` | **STOP** |
| `200` sans effet métier | `200` | `PROBABLE` au mieux | non |
| effet sur 3 cibles sur 5 | réponse partielle | `PARTIAL` | par cible |

Les trois lignes en gras sont celles où l'intuition se trompe. Elles sont
toutes indiscernables, depuis Jarvis, d'une situation où rien ne s'est produit.

---

## 8. Les trois propriétés globales

Plus importantes que n'importe quel décompte de tests.

```text
POUR TOUT scénario :

  external_effect_count > 1
      ⟹  Jarvis n'a JAMAIS produit un rejeu autonome
          qu'il présentait comme sûr

  external_effect_count = 1
      ⟹  Jarvis n'affirme JAMAIS FAILED
          sans preuve positive d'absence

  external_effect_count inconnu
      ⟹  Jarvis n'invente AUCUNE certitude
```

La première mérite d'être lue deux fois : elle n'interdit pas le double effet —
c'est impossible face à un fournisseur byzantin. Elle interdit que Jarvis en
**soit la cause en se croyant sûr**.

---

## 9. Le fournisseur byzantin, et la classification obligatoire

Un fournisseur byzantin n'est pas exotique : c'est un service qui a un bogue,
une version qui change sans préavis, ou une documentation optimiste.

Quatre formes à simuler : deux effets pour une identité ; `200` sans effet ;
deux réponses contradictoires à la même question ; `500` puis effet.

### Classifier plutôt que promettre

| Classe | Signification |
|---|---|
| **A** | violation que Jarvis peut **empêcher** |
| **B** | violation **impossible** à empêcher depuis Jarvis |
| **C** | violation **détectable** après coup |
| **D** | violation **non détectable** |

> **Ne jamais annoncer A quand seul C est possible.**

Un fournisseur qui double sur une identité unique relève de **B et C** : on ne
l'empêche pas, on le voit.

### Ce que Jarvis doit alors faire

| Exigence | Vérifiable |
|---|---|
| ne jamais masquer la violation | ✅ |
| ne jamais traiter une assertion fournisseur comme preuve absolue | ✅ |
| journaliser la violation comme **rupture de confiance** | ✅ |
| dégrader la confiance accordée à ce fournisseur | ✅ |
| n'engager aucune action nouvelle sur une information compromise | ✅ |
| empêcher physiquement le second effet | ❌ **impossible** |

Un état terminal nouveau est nécessaire : `PROVIDER_CONTRACT_VIOLATION`. Il ne
qualifie pas l'action mais **la source**, et il est plus fort qu'`UNKNOWN` : on
ignore ce qui s'est passé, *et* on sait que la source n'est plus fiable.

| Hypothèse | une violation byzantine est toujours détectable |
|---|---|
| **Contre-exemple cherché** | deux effets sur deux cibles **différentes** — indiscernables d'un succès partiel légitime |
| **Propriété** | détectable **seulement si** les cibles attendues sont connues à l'avance |
| **Garantie obtenue** | détection sur cible unique ou ensemble déclaré |
| **Limite** | ensemble de cibles non déclaré → classe **D**, non détectable |

---

## 10. Conservation des identités

F5-6. Le jour où la question sera « pourquoi cet email est-il parti ? », il
faudra remonter **du monde extérieur jusqu'à la décision**.

```text
Intent I1
  └── Operation O1                     (OperationIdentity — déjà typée)
        ├── Attempt A1
        │     └── Request R1
        │           └── ProviderRequest P1
        │                 └── Effect E1
        └── leaseGeneration #41
```

**État actuel :** `OperationIdentity` existe et est marquée. `intentId`,
`attemptId`, `requestId`, `providerRequestId`, `effectId` et
`leaseGeneration` n'existent pas. Le Gateway ne journalise pas l'appel
lui-même.

**Test envisagé** : partir d'une ligne de `lab_world_effects` et reconstruire la
chaîne complète jusqu'à l'intention — puis vérifier qu'aucun maillon ne peut
être reconstruit par déduction plutôt que par lecture.

### La chaîne de provenance à produire

```text
T0  INTENTION
T1  OPERATION_PLANNED
T2  REQUEST_CREATED
T3  REQUEST_SENT
T4  REQUEST_ACCEPTED     ?
T5  RESPONSE_RECEIVED    ?
T6  EFFECT_OBSERVED      ?
T7  OUTCOME
```

Jarvis doit pouvoir répondre à deux questions — et la seconde est celle qu'on
oublie :

```text
« Pourquoi affirmes-tu que c'est fait ? »
« Pourquoi refuses-tu de recommencer ? »
```

Et ceci doit être **impossible à produire** :

```text
REQUEST → TIMEOUT → « probablement fait » → CONFIRMED
```

| Hypothèse | la chaîne de provenance prouve pourquoi Jarvis affirme |
|---|---|
| **Contre-exemple cherché** | une chaîne complète et cohérente bâtie sur une observation elle-même erronée |
| **Propriété** | la provenance prouve le **raisonnement**, jamais le monde |
| **Limite** | une observation fausse produit une chaîne valide et un verdict faux |

---

## 11. L'autonomie n'est pas une fonction de la preuve seule

F5-5, et c'est une correction que je dois à la relecture : j'avais proposé
« l'autonomie se calcule depuis la qualité de preuve ». Insuffisant.

```text
AUTONOMIE = f( preuve, contrat d'effet, réversibilité,
               risque de l'action, policy, portée, règles utilisateur )
```

Le contre-exemple qui le montre :

```text
preuve          = excellente
contrat d'effet = parfaitement idempotent
action          = virement de 50 000 €
                  ⟹ sûrement pas AUTO
```

> **La preuve détermine ce que Jarvis peut AFFIRMER et REPRENDRE.
> La Policy détermine ce que Jarvis peut FAIRE.**

Ces deux axes ne doivent jamais fusionner. La preuve peut seulement **abaisser**
l'autonomie, jamais l'élever — même mécanique que `strictest()`.

---

## 12. Classification des résultats

Aucun décompte global ne sera présenté comme une preuve. Chaque ligne du
rapport final portera une catégorie :

| Catégorie | Signification |
|---|---|
| **PROVEN** | test nommé, reproductible, avec témoin négatif |
| **PARTIALLY PROVEN** | tenu dans les conditions testées, limite écrite |
| **NOT TESTABLE** | l'environnement ne le permet pas — raison explicite |
| **NOT GUARANTEED** | le système ne le garantit pas, et le dit |

### Multi-machine : ce qui est réellement mesurable ici

| Aspect | Verdict attendu |
|---|---|
| Deux processus, pools distincts, même base | **PROVEN** (Foundation 3) |
| Immunité à la dérive d'horloge | **PROVEN** visé — bail évalué par la base, testé avec `Date.now` décalé |
| Ordonnancement non déterministe | **PROVEN** visé |
| Partition entre Jarvis et PostgreSQL | **PROVEN** visé |
| Deux hôtes physiques distincts | **NOT TESTABLE** — un seul conteneur |
| Latence réseau réelle vers la base | **PARTIALLY PROVEN** — simulable |

Je ne présenterai pas la deuxième ligne sous le nom de l'avant-dernière.

---

## 13. Coût

Le banc est **entièrement local** : PostgreSQL, simulateur de fournisseur,
moteur de chaos, Verification Engine, Event Ledger, tests adversariaux. Aucun
modèle cloud, aucune API distante, aucun service tiers.

```text
tout ce qui précède  →  0 € / mois
```

Un fournisseur réel ne devient nécessaire que pour une **campagne de validation
contractuelle** ponctuelle — vérifier qu'un service tient ce qu'il déclare — et
jamais pour le fonctionnement quotidien du système.

---

## 14. Ordre d'implémentation

Chaque étape reste soumise à
`DISCOVERY → CONTRE-EXEMPLE → MESURE → INVARIANT → ADR → CODE → TEST → RÉGRESSION`.

| # | Étape | Pourquoi à ce rang |
|---|---|---|
| 1 | Couche Clock : les trois horloges, transactions longues | invaliderait le bail une troisième fois |
| 2 | `lab_provider_requests` — le second monde | sans lui, rien d'autre n'est démontrable |
| 3 | Chaîne `REQUEST` / `RESPONSE` au journal | prérequis du byzantin et de la provenance |
| 4 | Jeton de cloisonnement (génération de bail) | protège l'état interne avant tout le reste |
| 5 | Fournisseurs **honnêtes**, un par contrat | référence avant déviation |
| 6 | Harnais temporel (cinq instants) | rend la matrice énumérable |
| 7 | Fournisseur byzantin + `PROVIDER_CONTRACT_VIOLATION` | le cœur du sprint |
| 8 | Dérive d'horloge injectée | ferme la dette du bail |
| 9 | Identités : `intentId` … `effectId` | provenance de bout en bout |
| 10 | Invariants I11–I15 + témoins négatifs | |
| 11 | Extension du chaos aux nouveaux axes | |
| 12 | Rapport classé PROVEN / PARTIAL / NOT TESTABLE / NOT GUARANTEED | |

### Invariants candidats

| | Énoncé |
|---|---|
| **I11** | toute violation de contrat détectée est journalisée comme rupture de confiance |
| **I12** | aucune action nouvelle après une violation détectée |
| **I13** | tout état terminal possède une chaîne de provenance complète |
| **I14** | le comportement du bail est indépendant de l'horloge locale |
| **I15** | aucune écriture d'un exécutant dont la génération de bail est périmée |

---

## 15. Ce que je crois, et que le banc devra attaquer

Quatre affirmations que je tiens pour vraies aujourd'hui. Les écrire ici, c'est
s'engager à chercher leur contre-exemple **avant** de construire dessus.

| # | Affirmation | Contre-exemple à chercher | État |
|---|---|---|---|
| 1 | Le bail évalué par la base est immunisé à la dérive d'horloge | transaction longue figeant `now()` | ✅ **mesuré** — le défaut existe, mais penche vers le blocage, jamais vers le double effet |
| 2 | `lab_provider_requests` établit qu'une requête a été reçue | l'enregistrement lui-même échoue | ⏳ à éprouver |
| 3 | Un fournisseur byzantin est toujours détectable | deux effets sur deux cibles distinctes, indiscernables d'un partiel légitime | ⏳ à éprouver — probablement **faux** |
| 4 | La chaîne de provenance prouve pourquoi Jarvis affirme | chaîne cohérente bâtie sur une observation erronée | ⏳ à éprouver — probablement **faux** |

Les points 3 et 4 sont vraisemblablement faux, et je préfère l'écrire avant de
les tester. La méthode des trois derniers sprints est constante : **ce ne sont
pas les tests qui ont trouvé les défauts, ce sont les phrases qu'on a osé
écrire puis attaquer.**
