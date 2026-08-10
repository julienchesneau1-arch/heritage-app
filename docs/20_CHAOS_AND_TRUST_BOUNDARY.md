# 20 — CHAOS, PREUVE ET FRONTIÈRE DE CONFIANCE

**Foundation 4.** Résultats mesurés. Chaque affirmation renvoie à un test
nommé, rejouable par `pnpm test:lab`.

---

## 1. Ce que le sprint a changé

Foundation 3 demandait « ne jamais faire deux fois ». Foundation 4 demandait
autre chose, et de plus difficile :

> Prouver que Jarvis sait déterminer ce qu'il sait, ce qu'il ignore, ce qui
> s'est réellement produit et ce qui reste indéterminé.

Trois corrections en découlent, et la première est la plus structurante.

### 1.1 `FAILED` doit se mériter autant que `CONFIRMED`

`confirmed()` exigeait une preuve depuis la Phase 2. `failed()` n'exigeait
rien. On pouvait donc affirmer un échec sur un `500`, alors qu'affirmer un
succès sur un `200` était interdit — une dissymétrie qui n'avait aucune
justification.

```text
CONFIRMED  ← preuve POSITIVE d'effet
FAILED     ← preuve POSITIVE d'ABSENCE
UNKNOWN    ← aucune preuve suffisante
```

`failed()` prend désormais une `Absence`, dont le champ `conclusiveBecause`
oblige à écrire **pourquoi l'observation tranche**. C'est le champ coûteux à
remplir honnêtement, et c'est le point : « j'ai relu, il n'y a rien » ne suffit
pas face à une file d'attente.

Le typage a immédiatement forcé chaque appel existant à se justifier. Les cinq
outils du noyau ont pu le faire — *lecture transactionnelle après commit, aucun
effet différé possible* — ce qui est une preuve d'absence recevable. L'outil du
banc, lui, ne le pouvait pas.

### 1.2 Trois catégories de vérifiabilité

Plutôt qu'interdire les outils non vérifiables, on interdit **l'illusion de
fiabilité** :

| `verifiability` | Peut prouver | Verdict maximal |
|---|---|---|
| `VERIFIABLE` | présence **et** absence | `CONFIRMED` / `FAILED` |
| `OBSERVABLE` | présence seulement | jamais `FAILED` |
| `UNVERIFIABLE` | ni l'une ni l'autre | `PROBABLE` au mieux |

Le Verification Engine **bride** le verdict à la déclaration. Un outil
`OBSERVABLE` qui rend `FAILED` obtient `UNKNOWN` — on déclare puis on vérifie,
on ne fait pas confiance.

Et la règle d'enregistrement :

```text
effet EXTERNAL + UNVERIFIABLE + autonomie automatique  →  REFUSÉ
```

L'outil reste possible en `L3` (approbation). Un effet externe que le système
ne sait pas observer ne se produit jamais sans qu'un humain l'ait voulu.

### 1.3 Identité d'opération immuable

`OperationIdentity` est un type **marqué** : `operationId: 'abc'` ne compile
plus. Un repli passe par `sameOperation()` ; frapper une clé neuve devient un
acte visible. L'invariant I5 vérifie que `mint()` n'est appelé qu'aux deux
points d'entrée légitimes.

Le typage a révélé au passage une frontière qu'on n'avait pas nommée : la
passerelle web accepte une clé fournie par le **client**. C'est légitime — un
client qui renvoie la même clé après une coupure fait exactement ce qu'il faut
— et cela méritait une fonction dédiée (`fromClient`) plutôt qu'un passage
silencieux.

---

## 2. Le défaut que le chaos a trouvé

**CRIT-5.** Trouvé par tirage aléatoire, pas par relecture. Aucun test écrit à
la main ne l'avait vu, y compris ceux de Foundation 3 qui portaient exactement
sur ce sujet.

### Le contre-exemple, réduit à trois appels

```text
A gagne le compare-and-swap, part exécuter (60 ms)
B lit EXECUTING, interroge le monde — encore VIDE
B conclut NO_EFFECT, rembobine, exécute
   → DEUX EFFETS
```

Mesure brute avant correction :

| Appels simultanés | Effets |
|---|---|
| 2 | 1 ✅ |
| **3** | **2** 🔴 |
| 5 | 2 🔴 |

### Pourquoi la correction de Foundation 3 ne suffisait pas

ADR-029 utilisait `attempts` comme numéro de version, sur ce raisonnement,
écrit noir sur blanc dans le code :

> « L'état seul ne suffit pas : il ne dit pas si le `EXECUTING` observé est
> celui d'un processus mort ou d'un appelant bien vivant. Le compteur, lui,
> les distingue. »

**C'était faux.** Un exécutant vivant porte `EXECUTING, attempts = 1` —
exactement ce que lit un repreneur qui croit succéder à un mort. Le
raisonnement ne tenait que pour un crash, où plus personne ne bouge. Les tests
de crash passaient donc, et masquaient le cas symétrique.

### La correction

Ce qui distingue réellement les deux est **le temps**, pas un compteur. Le
Gateway impose lui-même `withTimeout(def.timeoutMs)` : au-delà de
`executing_at + timeoutMs + marge`, un exécutant vivant a forcément écrit un
état terminal. Détail et arbitrages en ADR-032.

### Le prix, assumé

Une reprise après crash n'est plus immédiate. Elle est bornée par le
`timeoutMs` de l'outil plus 5 s de marge, parce qu'aucun moyen ne permet de
distinguer « mort il y a une seconde » de « encore en train de tourner » sans
battement de cœur.

`lab/crash-concurrency` en fait une **propriété testée** : une reprise
prématurée reçoit `OPERATION_IN_FLIGHT` et le formule sans mentir — « je n'ai
rien tenté ». C'est une latence échangée contre la certitude de ne jamais
doubler un effet.

---

## 3. Les dix invariants

Évalués après chaque scénario, y compris ceux que personne n'a imaginés.

| | Énoncé | Nature |
|---|---|---|
| **I1** | jamais deux effets pour un même `(operation_id, cible)` | état |
| **I2** | aucun `CONFIRMED` sans effet réellement observé | état |
| **I3** | aucun `FAILED` alors qu'un effet existe | état |
| **I4** | aucune opération ne dépasse une tentative sans preuve positive | état |
| **I5** | l'identité n'est frappée qu'au point d'entrée d'une intention | structure |
| **I6** | « RED + sortie réseau → refus », sans exception ni option | structure |
| **I7** | tout effet possède une trace d'intention | état |
| **I8** | toute exécution a été précédée d'un `ALLOW` du Policy Gate | état |
| **I9** | aucun code du noyau n'écrit dans les politiques | structure |
| **I10** | `CONFIRMED` et `FAILED` ne sont fabriqués que par le Verification Engine | structure |

**Le témoin négatif fait partie du dispositif.** Deux tests injectent
délibérément une violation — un doublon fabriqué, un effet orphelin — et
vérifient que le contrôle la voit. Sans eux, « aucune violation » ne
prouverait rien : un contrôle aveugle rend exactement le même verdict qu'un
système correct.

---

## 4. Le chaos runner

### Ce qui le rend utilisable plutôt qu'impressionnant

**Reproductibilité.** Aucun `Math.random()`. Chaque campagne est indexée par
une graine, et une graine donnée produit toujours le même scénario — vérifié
par un test. Un contre-exemple non rejouable ne vaut rien.

**Minimisation.** Un scénario fautif est réduit avant d'être rapporté : moins
d'étapes, moins de concurrence, moins de reprises. On ne conserve une
réduction que si elle reproduit la même famille de violation — réduire jusqu'à
faire disparaître le défaut transformerait un contre-exemple en illusion de
correction.

**Attente des effets différés.** Les invariants s'évaluent après `settle()`.
Un scénario `LATE_SUCCESS` change encore le monde après le retour de l'appel :
mesurer trop tôt donnerait un « aucune violation » qui ne veut rien dire. Le
simulateur est censé mettre ce piège en scène — il ne doit pas y tomber.

### Les seize pathologies

```text
NORMAL · TIMEOUT · LOST_RESPONSE · DUPLICATE_RESPONSE · DELAYED_RESPONSE
429 · 500 · 503 · SUCCESS_AFTER_ERROR · ERROR_AFTER_EFFECT
SUCCESS_WITHOUT_EFFECT · PARTIAL · CONNECTION_RESET · PROCESS_KILLED
LATE_SUCCESS · LATE_FAILURE · OUT_OF_ORDER · DISAPPEARS
```

croisées avec le **moment de l'effet** — `NEVER`, `BEFORE_RESPONSE`,
`AFTER_EFFECT_BEFORE_RESPONSE`, `AFTER_RESPONSE` — et six niveaux de
concurrence, de 1 à 50.

Un test vérifie que le tirage couvre réellement l'espace : un générateur biaisé
produirait cent fois `NORMAL` et ne trouverait jamais rien.

### Résultats

| Campagne | Scénarios | Violations |
|---|---|---|
| par défaut | 25 | 0 |
| étendue (`JARVIS_CHAOS_RUNS=150`) | 150 | 0 |
| combinaisons dirigées | 5 | 0 |

Les combinaisons dirigées sont celles que le mandat nomme explicitement :
`TIMEOUT+LATE_SUCCESS`, `ERREUR APRÈS EFFET + CONCURRENCE`,
`RÉPONSES DÉSORDONNÉES + 50 SIMULTANÉS`, `FOURNISSEUR QUI DISPARAÎT +
REPRISES`, `ACK SANS EFFET + VÉRIFICATION`. Le tirage couvre l'espace ; ces
cinq-là sont joués à coup sûr plutôt que d'attendre qu'une graine les produise.

---

## 5. `PARTIAL` — implémenté, non branché

Le modèle par cible existe (`src/core/tools/outcome.ts`) : `TargetOutcome`,
`projectStatus()`, `resumableTargets()`. `VerificationStatus` porte désormais
`PARTIAL` et `NOT_ATTEMPTED`.

**Il n'est pas branché au Tool Gateway**, qui n'a aucune notion de cible à lui
transmettre. `redteam/wiring` le liste explicitement parmi les modules
qu'aucun point d'entrée n'atteint — la dette reste visible plutôt que
maquillée.

Une garde a bien failli manquer : le test structurel « aucun module ne fabrique
un `CONFIRMED` hors du Verification Engine » a signalé `outcome.ts`. Il avait
raison. La réponse n'a pas été d'assouplir le test mais d'exiger la preuve —
une cible `CONFIRMED` sans `POSITIVE_PRESENCE` ne compte pas dans la
projection.

---

## 6. Garanties démontrées

| Propriété | Preuve |
|---|---|
| 3 / 5 appels concurrents avec vérification → 1 effet | `lab/crash-concurrency` (régression F4) |
| Une reprise prématurée est refusée et le dit | `lab/crash-concurrency` |
| 150 scénarios aléatoires → aucun invariant violé | `lab/chaos` |
| Les 5 combinaisons nommées → aucune violation | `lab/chaos` |
| Le contrôle d'invariants voit un doublon injecté | `lab/chaos` (témoin négatif) |
| Le contrôle voit un effet orphelin | `lab/chaos` (témoin négatif) |
| Une graine produit toujours le même scénario | `lab/chaos` |
| `SUCCESS` sans effet → `UNKNOWN`, jamais `FAILED` | `lab/provider-lies` |
| Un outil aveugle à effet externe est refusé en L2 | `lab/provider-lies` |
| Le même outil est accepté en L3, plafonné à `PROBABLE` | `lab/provider-lies` |
| La projection ne peut pas inventer un `CONFIRMED` | `redteam/failure-modes` |
| Un `FAILED` sans preuve d'absence ne se propage pas | `redteam/failure-modes` |
| `mint()` n'est appelé qu'aux points d'entrée | I5 |

---

## 7. Ce qui reste non démontrable

**La fenêtre irréductible.** Inchangée. Entre l'écriture `EXECUTING` et le
retour de l'appel, un instant existe où le processus peut mourir sans que
personne ne sache. Le bail borne la conséquence ; il ne supprime pas la
fenêtre.

**Le multi-machines.** Toutes les garanties reposent sur PostgreSQL comme point
de sérialisation unique, et le bail est évalué par la base — donc immunisé à la
dérive d'horloge entre machines. Mais aucun test ne fait tourner Jarvis sur
deux machines : la propriété est *argumentée*, pas *mesurée*.

**Le repli à nouvelle clé.** Le type marqué empêche la faute par accident. Il
n'empêche pas quelqu'un d'appeler `mint()` délibérément dans un chemin de
repli. I5 le rend visible en revue — c'est la meilleure garantie disponible
sans routeur, et ce n'est pas une preuve.

**La réconciliation différée.** Un fournisseur asynchrone laisse encore Jarvis
en `UNKNOWN` alors que l'effet arrivera. `UNKNOWN` est désormais le verdict
*correct* — mais rien ne revient le lever plus tard. Dette nommée.

**`PARTIAL` en usage réel.** Le modèle est testé sur des valeurs synthétiques,
jamais sur un vrai outil multi-cibles. Aucun n'existe.

**La charge soutenue.** Le chaos joue 150 scénarios de trois étapes. Pas
1 000 opérations continues, pas de test de plusieurs heures.

---

## 8. Ce que ce sprint dit de la méthode

Le défaut CRIT-5 se trouvait dans du code écrit **six heures plus tôt**, pour
corriger un défaut de la même famille, documenté par un ADR, couvert par sept
tests de crash et trois tests de concurrence — tous verts.

Il n'a pas été trouvé par relecture. Il a été trouvé par un tirage aléatoire
qui a produit une combinaison que personne n'avait imaginée : *un exécutant
lent, un concurrent capable de vérifier, et un monde encore vide au moment de
la vérification*.

C'est l'argument le plus fort en faveur de la discipline que le mandat
imposait :

```text
DISCOVERY → REPRODUCTION → CONTRE-EXEMPLE MINIMAL → INVARIANT
          → ADR → CORRECTION → RÉGRESSION → CHAOS RE-RUN
```

Sans la minimisation, le rapport aurait dit « trois étapes, cinquante appels
concurrents, réponses désordonnées » — impossible à raisonner. Réduit à trois
appels, le défaut devient une phrase : **un exécutant vivant porte le même
état qu'un mort.**

Et sans l'obligation d'écrire l'ADR avant la correction, j'aurais corrigé le
symptôme — ajouter une condition — au lieu de nommer la cause : le compteur ne
mesure pas la vie, seul le temps la mesure.

**Une note d'honnêteté sur le sprint précédent.** Le commentaire de Foundation 3
affirmait que `attempts` distinguait un exécutant mort d'un vivant. C'était une
erreur de raisonnement, pas une omission — elle était écrite, argumentée, et
fausse. Elle est corrigée dans le code et citée telle quelle dans ADR-032,
parce qu'un raisonnement faux qu'on efface a toutes les chances d'être refait.
