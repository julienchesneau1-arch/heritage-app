# 27 — COUCHES 04-05 : LES DEUX MONDES

**Foundation 5.** `docs/22 §14` ordonnait le second monde en **position 2**,
avec la mention *« sans lui, rien d'autre n'est démontrable »*. `docs/26 §4.4`
le désignait comme **la plus grande zone d'ombre différée du dépôt**.

Il existe. Tout est local : PostgreSQL et Node. **0 € de coût opérationnel.**

---

## 1. La phrase qu'aucun test unitaire ne savait écrire

```text
        JARVIS                          LE BANC
   ─────────────────           ──────────────────────
   requête émise               request_received_at      t1
   réponse │ timeout           effect_started_at        t2
   HTTP 500 │ 429              effect_committed_at      t3
   connexion coupée            response_sent_at         t4 · delivered
```

**Jarvis n'a jamais accès à la colonne de droite. Le banc, si.**

C'est ce qui permet d'énoncer — et désormais de **mesurer** :

> **Jarvis avait RAISON de dire `UNKNOWN` alors que l'effet avait réellement
> eu lieu.**

Mesuré :

| Ce que le banc sait | Ce que Jarvis dit |
|---|---|
| requête reçue : **1** | ni `CONFIRMED` |
| effet validé : **1** | ni `FAILED` |
| réponse émise : **1** | |
| réponse **délivrée : 0** | |

L'effet **existe**. Jarvis ne l'affirme pas, et il a raison de ne pas
l'affirmer. Il n'affirme pas non plus l'échec, et c'est là que tout se joue.

> « Ce n'est pas observable » et « cela ne s'est pas produit » sont deux choses
> différentes.

### Le corollaire, mesuré lui aussi

```text
REQUEST_SENT + aucune RESPONSE
    ≠  REQUEST_FAILED
    =  RESPONSE_UNKNOWN
```

Deux scénarios que Jarvis voit **identiques** :

| Réalité | `request_received_at` | Ce que Jarvis voit |
|---|---|---|
| fournisseur injoignable | `NULL` | identique |
| reçue, jamais traitée, jamais répondue | **rempli** | identique |

Sans le second monde, ces deux mondes seraient indiscernables **y compris pour
le banc** — qui perdrait alors toute capacité de juger.

---

## 2. La matrice de vérité, exécutable

`docs/22 §7` la posait comme *« le contrat du laboratoire »*. Elle tourne.

| Réalité fournisseur | Effet réel | Verdicts autorisés |
|---|---|---|
| aucune requête reçue — timeout | 0 | `UNKNOWN` · `TIMEOUT` |
| **effet produit, réponse perdue** | **1** | `UNKNOWN` · `PROVIDER_UNAVAILABLE` |
| effet produit, réponse reçue | 1 | `CONFIRMED` |
| **effet produit, puis réponse 500** | **1** | `UNKNOWN` · `PROVIDER_UNAVAILABLE` |
| `429` avant traitement | 0 | `UNKNOWN` · `PROVIDER_UNAVAILABLE` |
| `200` sans effet métier | 0 | `UNKNOWN` · `PROBABLE` · `FAILED` |

Deux règles traversent chaque ligne, et sont vérifiées à chacune :

```text
effet réel = 0  ⟹  jamais mayClaimSuccess()
effet réel > 0  ⟹  jamais FAILED
```

Les lignes en gras sont celles où l'intuition se trompe : **toutes sont
indiscernables, depuis Jarvis, d'une situation où rien ne s'est produit.**

---

## 3. Le fournisseur byzantin

### Ce qui est détecté — classe C

Un fournisseur **déclaré idempotent** qui produit deux effets pour une identité
unique et une **même cible** :

```text
status  = PROVIDER_CONTRACT_VIOLATION
detail  = « Contrat rompu par le fournisseur. Promis : au plus un effet par
           (identité d'opération, cible). Constaté : 2 effets sur une MÊME
           cible. »
```

Et la violation est **journalisée** — pas seulement inscrite au registre. Le
journal est append-only et chaîné : c'est la seule trace qu'un audit ne peut
pas voir disparaître (I11).

### Ce qui n'est PAS détecté — classe D, mesuré

`docs/22 §9` cherchait un contre-exemple. Il existe, et il est **testé** :

> deux effets sur deux cibles **différentes** — indiscernables d'un succès
> partiel légitime

La détection n'est possible **que si l'ensemble des cibles attendues est connu
d'avance**. Il ne l'est pas : le Gateway n'a aucune notion de cible.

**Aucune violation n'est détectée, et c'est correct.** Jarvis n'annonce pas non
plus un succès : il dit son ignorance.

### La classification, sans promesse excessive

| Classe | Ce fournisseur | |
|---|---|---|
| **A** — empêchable | non | |
| **B** — impossible à empêcher | **oui** | on ne l'empêche pas |
| **C** — détectable après coup | **oui** | cible unique ou ensemble déclaré |
| **D** — non détectable | **oui** | ensemble de cibles non déclaré |

> **Ne jamais annoncer A quand seul C est possible.**

---

## 4. Les trois propriétés globales — `docs/22 §8`

La première mérite d'être lue deux fois :

```text
external_effect_count > 1
    ⟹  Jarvis n'a JAMAIS produit un rejeu autonome qu'il présentait
        comme sûr
```

Elle **n'interdit pas** le double effet — c'est impossible face à un
fournisseur byzantin. Elle interdit que **Jarvis en soit la cause en se croyant
sûr**.

Mesuré : deux effets dans le monde, `attempts = 1` côté Jarvis. Le second effet
vient du banc, et le second monde le confirme indépendamment.

---

## 5. Ce que la construction a révélé — trois défauts, aucun par relecture

### 5.1 `FAILED` annoncé sur un double effet

`hostile-tool.ts` rendait `FAILED` quand `count > 1`. Or `FAILED` signifie
**preuve positive d'absence**. Annoncer « ça n'a pas marché » à propos de deux
virements passés violait I3 et constituait le mensonge le plus coûteux
possible.

### 5.2 Le type et le schéma divergeaient — dans DEUX tables

`VerificationStatus` déclarait **six** valeurs depuis Foundation 3. Les `CHECK`
SQL n'en autorisaient que **quatre** :

| Table | Trouvé |
|---|---|
| `tool_operations.status` | en écrivant la migration |
| `event_ledger.status` | **en exécutant le premier test byzantin** |

`PARTIAL` et `NOT_ATTEMPTED` auraient été refusés par la base. C'était une
**seconde raison, indépendante et non documentée**, pour laquelle `PARTIAL`
était inatteignable — `docs/26 §4.1` n'en connaissait qu'une.

Pour `event_ledger`, la conséquence était pire : le registre acceptait le
verdict, le journal le refusait, et l'opération échouait en `INTERNAL`. **Une
rupture de confiance qui fait planter au lieu d'être consignée.**

> Un type et un schéma qui divergent en silence, c'est la validation aux
> frontières prise en défaut **à l'intérieur**.

### 5.3 Ma descente de migration bloquait toute la suite

Première version : re-poser la contrainte étroite sur `event_ledger`. Elle
échouait dès qu'une violation avait été journalisée — et `global-setup` fait
descendre puis remonter le schéma **à chaque exécution**.

Purger les lignes fautives était exclu : cela romprait la chaîne de hachage.
`NOT VALID` est la réponse juste — la contrainte s'applique aux écritures
**futures**, l'histoire écrite reste intacte et vérifiable.

---

## 6. Deux erreurs de MA part, corrigées par la mesure

| Ce que j'avais écrit | Ce que la mesure a dit |
|---|---|
| violation = `count > 1` | trois cibles servies n'est pas une violation, c'est un succès partiel |
| classe D via `provider.send` | `send` réutilise la cible par défaut — il fallait injecter sur une cible **différente** |

Les deux ont été trouvées par un test rouge, pas par relecture. C'est la
sixième et la septième fois dans ce projet.

---

## 7. Classification honnête

| Propriété | Verdict |
|---|---|
| Le banc distingue « jamais reçue » de « reçue, non traitée » | **PROUVÉ** |
| Le banc distingue « pas de réponse » de « réponse perdue » | **PROUVÉ** |
| Jarvis a raison de dire `UNKNOWN` quand l'effet existe | **PROUVÉ** — les deux mondes concordent |
| Six lignes de la matrice de vérité | **PROUVÉ** |
| Aucun `mayClaimSuccess` quand l'effet réel est absent | **PROUVÉ** sur toute la matrice |
| Aucun `FAILED` quand l'effet réel existe | **PROUVÉ** sur toute la matrice |
| Double effet sur une même cible → violation détectée | **PROUVÉ** — classe C |
| Violation journalisée comme rupture de confiance | **PROUVÉ** — I11 |
| Double effet sur deux cibles → **non** détecté | **MESURÉ** — classe D, limite, pas défaut |
| Jarvis n'est jamais la cause d'un rejeu qu'il croyait sûr | **PROUVÉ** — `attempts = 1` sous double effet |
| Empêcher physiquement le second effet | **IMPOSSIBLE** — classe B, et le dire est tout ce qu'on peut faire |
| Détecter une violation sur cibles non déclarées | **NON GARANTI** — classe D |

---

## 8. Ce qui reste, après cette couche

| | État |
|---|---|
| Couches 01-05 | **faites** |
| I12 — aucune action nouvelle après violation détectée | **FAIT** — ADR-039, avec rétablissement réservé à l'humain |
| I13 — chaîne de provenance complète | **PARTIEL** — la chaîne se reconstruit par lecture (ADR-039) ; les identifiants typés `intentId`…`effectId` n'existent pas |
| Couche 06 Observation · 07 Verdict | partielles |
| `PARTIAL` branché au Gateway | toujours pas — il faut un outil multi-cibles |

I12 et I13 ont été traités dans la foulée (ADR-039). Ce qui reste différé est
désormais énuméré et chiffré dans `docs/28` : la lacune la plus actionnable
n'est plus dans le banc, elle est dans `docs/05` — **quatorze scénarios dorés
sur trente ne sont référencés par aucun test**.
