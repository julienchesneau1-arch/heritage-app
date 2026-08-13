# 23 — COUCHE 01 : HORLOGE ET CLOISONNEMENT

**Foundation 5, couche 01 — rapport de mesures.** Aucune correction n'a été
apportée. Deux défauts sont mesurés et laissés en l'état, conformément au
protocole :

```text
MESURE → CONTRE-EXEMPLE → CONSTATS → INVARIANT → ADR → CORRECTION → RÉGRESSION
```

Ce document s'arrête à **CONSTATS + INVARIANT**. Les ADR et corrections
attendent validation.

Tout est local : PostgreSQL et Node. **0 € de coût opérationnel.**

---

## 1. La question posée

Pas *« quelle fonction donne l'heure exacte ? »* — la réponse est triviale et
sans intérêt.

Mais :

> **Quelle source temporelle permet de décider qu'un bail est expiré sans
> ouvrir la possibilité d'une reprise prématurée ?**

La distinction change la réponse, parce que le contrôle de bail met en jeu
**deux instants**, écrits à deux moments différents :

```text
executing_at  >  now()  −  (timeout + marge)
     ▲                ▲
     │                └── lu au moment du CONTRÔLE
     └── écrit au moment de l'ENGAGEMENT
```

Une défaillance sur l'un n'a pas la même conséquence qu'une défaillance sur
l'autre. C'est le résultat principal de cette couche.

---

## 2. Mesures — les trois horloges de PostgreSQL

`tests/lab/clock.test.ts`, 8 tests.

### Hors transaction explicite

| Fonction | Écart mesuré sur 1,2 s réelles |
|---|---|
| `transaction_timestamp()` (= `now()`) | > 1 000 ms — avance |
| `statement_timestamp()` | > 1 000 ms — avance |
| `clock_timestamp()` | > 1 000 ms — avance |

Chaque requête isolée est sa propre transaction implicite : les trois
coïncident. **PROUVÉ dans l'environnement testé.**

### Dans une transaction longue

| Fonction | Écart mesuré sur 2,0 s réelles |
|---|---|
| `transaction_timestamp()` (= `now()`) | **0 ms — FIGÉ** |
| `statement_timestamp()` | > 1 500 ms |
| `clock_timestamp()` | > 1 500 ms |

`now()` rend l'heure de **début de transaction**. Sur deux secondes réelles, il
ne bouge pas d'un millième. **PROUVÉ dans l'environnement testé.**

---

## 3. Les deux directions de l'erreur — le constat qui compte

### 3.1 `now()` figé au CONTRÔLE → sur-estimation du bail

Mesure : opération démarrée il y a 2 s, bail de 1 s.

| Évalué avec | Verdict | Juste ? |
|---|---|---|
| `clock_timestamp()` | expiré | ✅ |
| `now()` figé | **encore vivant** | ❌ |

Le verdict est faux, mais **dans la direction qui protège** :

```text
bail SUR-estimé   →  reprise BLOQUÉE      →  perte de DISPONIBILITÉ
bail SOUS-estimé  →  reprise PRÉMATURÉE   →  perte de SÛRETÉ
```

`transaction_timestamp() ≤ clock_timestamp()` toujours. Un `now()` figé ne peut
donc **jamais** produire une reprise prématurée par ce chemin.

### 3.2 CONTRE-EXEMPLE TROUVÉ — `now()` figé à l'ÉCRITURE

C'est l'inverse, et c'est celui qui menace la sûreté.

Si `executing_at = now()` est écrit **à l'intérieur** d'une transaction longue,
l'estampille porte l'heure du début de cette transaction — donc trop ancienne.

**Mesure :** transaction ouverte, 2 s d'attente, puis écriture. L'estampille
naît vieille de **plus de 1 500 ms**.

```text
l'opération commence      →  executing_at déjà vieux de 2 s
bail court                →  déclarée expirée à l'instant même où elle démarre
un exécutant bien vivant  →  déclaré mort
                             ⟹ REPRISE PRÉMATURÉE
```

> **Ce n'est pas `now()` au contrôle qui est dangereux. C'est `now()` à
> l'estampille, combiné à une transaction longue.**

### 3.3 Exposition réelle du code

| Vérification | Résultat |
|---|---|
| Le Gateway ouvre-t-il une transaction ? | **non** — `deps.db.transaction` : 0 occurrence |
| Où `executing_at` est-il écrit ? | `gateway.ts:873`, requête isolée |
| Où le bail est-il lu ? | `gateway.ts:744`, requête isolée |
| Seul usage de `transaction()` dans `src/` | `ledger.ts:112` — n'englobe aucun appel d'outil |

**Le défaut est LATENT, pas actif.** Il s'activerait le jour où quelqu'un
envelopperait le Gateway dans `db.transaction()` — geste parfaitement naturel
pour « rendre l'opération atomique », et qui casserait la sûreté du bail sans
qu'aucun test existant ne le signale.

---

## 4. Mesure — dérive de l'horloge applicative (I14)

L'horloge du processus a été décalée de **± un an** pendant l'évaluation d'un
bail.

| Décalage appliqué | Verdict du bail |
|---|---|
| aucun | expiré |
| +1 an | expiré |
| −1 an | expiré |

Le verdict est **inchangé** : le bail est évalué par la base, jamais par le
processus. **PROUVÉ dans l'environnement testé.**

C'est la propriété qui rendait le multi-machines défendable, et elle est
désormais mesurée plutôt qu'argumentée.

---

## 5. Mesure — acquisition concurrente

20 tentatives simultanées du compare-and-swap d'engagement réel sur une même
opération :

```text
gagnants = 1
```

**PROUVÉ dans l'environnement testé.** Confirme ADR-029 sur le mécanisme
d'acquisition lui-même, indépendamment du bail.

---

## 6. CONTRE-EXEMPLE TROUVÉ — le cloisonnement n'existe pas

Séquence mesurée :

```text
opération en EXECUTING, démarrée il y a une heure
B reprend et clôt      →  state = SUCCEEDED, « repris par B »
A, zombie, revient     →  state = UNKNOWN,   « écriture tardive de A »
                          ═══════════════════════════════════════════
état final : celui de A
```

**L'écriture de A écrase celle de B.** Le système raconterait l'histoire de A à
propos d'un monde façonné par B.

### Pourquoi c'est possible

L'écriture terminale du Gateway est inconditionnelle :

```sql
UPDATE tool_operations SET state = $2, status = $3, … WHERE operation_id = $1
```

Aucune notion de génération. Un exécutant périmé a exactement les mêmes droits
qu'un exécutant courant.

### La propriété souhaitée, encodée comme telle

`tests/lab/clock.test.ts` porte un test marqué `it.fails()` qui énonce I15 :

> Une écriture portant une génération de bail périmée est refusée.

Il échoue aujourd'hui — la colonne `lease_generation` n'existe pas. Le jour où
le cloisonnement sera implémenté, Vitest signalera que le test « aurait dû
échouer » : **la correction ne peut pas se faire en silence, et le marqueur ne
peut pas être oublié.**

---

## 7. Les sept notions, séparées

Aucune n'est utilisée comme preuve implicite d'une autre.

| Notion | Ce que la couche 01 en établit |
|---|---|
| **CLOCK** | trois horloges distinctes, comportements mesurés |
| **LEASE** | acquisition exclusive prouvée ; expiration dépendante de l'estampille |
| **PROCESS LIVENESS** | **rien** — aucune mesure ne l'établit, et aucune ne le peut |
| **FENCING** | **inexistant** — défaut mesuré, propriété encodée en `it.fails()` |
| **REQUEST LIFECYCLE** | hors périmètre de la couche 01 |
| **EXTERNAL EFFECT** | hors périmètre |
| **EXTERNAL EFFECT VERIFICATION** | hors périmètre |

La ligne `PROCESS LIVENESS` est la plus importante du tableau : **la couche 01
n'apporte aucune information sur la vie d'un processus, et il ne faut pas
espérer qu'une couche ultérieure le fasse.**

---

## 8. Invariants issus de la mesure

| | Énoncé | État |
|---|---|---|
| **I14** | le verdict de bail est indépendant de l'horloge du processus | **PROUVÉ** |
| **I15** | aucune écriture d'un exécutant de génération périmée | **NON TENU** — mesuré, `it.fails()` |
| **I16** | `executing_at` est estampillé avec une horloge murale, jamais avec `now()` dans une transaction | **PROPOSÉ** — défaut latent mesuré |

> **Ce tableau est daté, et le reste.** Il décrit l'état au moment de la
> mesure — c'est un relevé, pas un tableau de bord. Foundation 5.1 a depuis
> tenu I15 et I16 (ADR-035, `docs/24`). Le corriger ici effacerait la seule
> chose qui rend un relevé utile : ce qu'on savait, et quand.

---

## 9. Classification honnête

| Propriété | Verdict |
|---|---|
| Les trois horloges se comportent comme documenté | **PROUVÉ** dans l'environnement testé |
| `now()` fige dans une transaction | **PROUVÉ** |
| Un `now()` figé au contrôle ne cause pas de reprise prématurée | **PROUVÉ** |
| Un `now()` figé à l'écriture cause une reprise prématurée | **PROUVÉ** — contre-exemple construit |
| Le code actuel n'est pas exposé | **PROUVÉ** — 0 occurrence de `transaction()` englobante |
| Le verdict de bail ignore l'horloge du processus | **PROUVÉ** |
| Acquisition concurrente exclusive | **PROUVÉ** |
| Un exécutant périmé peut écrire | **DÉFAUT PROUVÉ** |
| Le bail dit quelque chose de la vie d'un processus | **NON GARANTI** — et le restera |
| Comportement sur deux hôtes physiques | **NON TESTABLE** ici |
| Dérive d'horloge entre deux serveurs PostgreSQL | **NON TESTABLE** — une seule instance |

---

## 10. Décisions à prendre — pas prises ici

Trois questions ouvertes, volontairement laissées à l'arbitrage.

### 10.1 Faut-il passer l'estampille à `clock_timestamp()` ?

**Pour :** ferme le contre-exemple §3.2 définitivement, coût nul.
**Contre :** aucun argument technique. C'est une correction d'une ligne.
**Réserve :** elle traite le symptôme. Un futur `db.transaction()` englobant
casserait d'autres choses que le bail — la vraie question est de savoir si le
Gateway doit *interdire* d'être enveloppé.

### 10.2 Le cloisonnement vaut-il son coût ?

Ton avertissement s'applique directement ici : *« si une partie n'apporte
aucune garantie supplémentaire mesurable, on la supprime »*.

Ce qu'il apporterait, mesuré : la cohérence de l'état interne face à un
exécutant zombie — §6 montre le défaut réel.
Ce qu'il n'apporte pas : aucune protection du monde extérieur.

**Mon avis :** il vaut son coût, mais uniquement parce que §6 est un défaut
constaté et non une hypothèse. Une colonne, une garde dans deux `UPDATE`.

### 10.3 Faut-il un battement de cœur ?

**Mon avis : non, et pas maintenant.** Il donnerait une détection plus rapide
d'un exécutant mort, au prix d'une écriture périodique et d'un nouveau mode de
panne. Aucune mesure ne montre aujourd'hui que la latence de reprise gêne. À
rouvrir si une mesure le montre — pas avant.

---

## 11. Ce que la couche 01 n'a pas trouvé

Honnêteté sur les non-découvertes, qui comptent autant que les découvertes :

- aucun défaut dans l'acquisition concurrente ;
- aucune sensibilité du bail à l'horloge applicative ;
- aucune exposition **actuelle** au défaut de l'estampille ;
- aucun comportement inattendu des trois horloges.

Le seul défaut **actif** est l'absence de cloisonnement. Le défaut de
l'estampille est **latent** — réel, mais non atteignable par le code tel qu'il
est écrit aujourd'hui.

Distinguer les deux est le travail de cette couche. Les confondre aurait
produit soit une urgence injustifiée, soit une fausse sérénité.
