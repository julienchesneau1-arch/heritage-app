# 24 — CLOISONNEMENT : MESURE, AUDIT, CORRECTION

**Foundation 5.1.** Suite directe de `docs/23`, qui mesurait sans corriger.
Ce document corrige — et rend compte de ce que la correction ne fait pas.

Périmètre gelé : **le cloisonnement, et rien d'autre.** Pas de battement de
cœur, pas de refonte du bail, pas de multi-hôtes. Tout est local : PostgreSQL
et Node. **0 € de coût opérationnel.**

---

## 1. Les deux mesures préalables

L'arbitrage exigeait de ne pas corriger `now()` isolément, et de formaliser la
sémantique du bail **avant** le correctif. Deux mesures ont donc précédé toute
ligne de code.

### 1.1 Audit des chemins d'écriture

Question : *combien d'endroits peuvent modifier une opération, et lesquels ?*

| | |
|---|---|
| Écritures de `tool_operations` dans `src/` | **8** |
| Fichiers concernés | **1** — `src/core/tools/gateway.ts` |
| Couche de dépôt parallèle | **aucune** |
| Écritures terminales **inconditionnelles** | **2** — `gateway.ts:921`, `gateway.ts:980` |

Les deux dernières lignes sont le trou, et il est exactement celui de
`docs/23 §6`.

### 1.2 Contre-exemple du Gateway enveloppé dans une transaction longue

`docs/23 §3.2` avait établi que `now()` **à l'estampille** ouvre une reprise
prématurée. Restait à savoir si le Gateway y était exposé. Mesure :

```text
now() DANS la transaction enveloppante : 17:04:06.194381+00
executing_at écrit par le Gateway      : 17:04:08.834793+00   (+2,6 s)
âge de l'estampille à la relecture     : 39 ms
```

**Le Gateway est structurellement immun.** `deps.db.query()` prend une
connexion distincte du pool ; la transaction de l'appelant ne l'englobe jamais.

> La protection est **l'isolation de connexion**, pas la fonction d'horloge.

`clock_timestamp()` a tout de même été retenu pour les colonnes de bail — mais
comme **défense en profondeur**, et le document le dit plutôt que de laisser
croire qu'une ligne de SQL a fermé le sujet. C'est précisément ce que
l'arbitrage 🟠 demandait : ne pas traiter le symptôme en croyant traiter la
cause.

---

## 2. Sémantique du bail — la formalisation demandée

| Champ | Horloge | Évaluée | Transaction | Propriété |
|---|---|---|---|---|
| `lease_generation` | **aucune** | à l'acquisition | celle du `UPDATE` | **SÛRETÉ** |
| `lease_expires_at` | `clock_timestamp()` | à l'acquisition | celle du `UPDATE` | vivacité |
| `executing_at` | `clock_timestamp()` | à l'acquisition | celle du `UPDATE` | vivacité |
| contrôle d'expiration | `now()` côté base | à la reprise | celle du `SELECT` | vivacité |
| `lease_owner` | — | à l'acquisition | — | diagnostic seul |

**La première ligne porte tout le poids.** Aucune horloge ne participe à la
sûreté : le droit d'écrire est porté par la génération. Un dérèglement
d'horloge coûte de la disponibilité, jamais de la sûreté.

`now()` est conservé au **contrôle** d'expiration, et c'est délibéré : figé, il
ne peut que SUR-estimer un bail, donc bloquer une reprise. `docs/23 §3.1` le
mesure. L'erreur va dans la direction qui protège.

---

## 3. La matrice des chemins d'écriture audités

Les 8 sites se réduisent à **5 instructions** après le correctif. Chacune est
classée, et la classification est vérifiée mécaniquement par I17.

| Chemin | Rôle | Peut créer | Peut reprendre | Écrit terminal | Écrit issue | Contourne le cloisonnement |
|---|---|---|---|---|---|---|
| `writeAuthoritative` | écriture sous bail | non | non | **oui** | **oui** | **non** — gardé par génération |
| `claimForRecovery` | prise de bail de reprise | non | **oui** | non | non | **non** — gardé par génération |
| `acquireLease` | frappe du bail | non | non | non | non | **non** — CAS sur `COMMITTED_TO_EXECUTION` |
| CAS d'engagement | `PLANNED → COMMITTED` | non | non | non | non | **non** — CAS sur `PLANNED` |
| Rembobinage pré-appel | `COMMITTED → PLANNED` | non | oui | non | non | **non** — CAS sur `COMMITTED` |
| `INSERT … ON CONFLICT` | inscription d'intention | **oui** | non | non | non | s.o. — création |
| Vérification (`readBack`, `verifyAttempt`) | lecture seule | non | non | non | non | s.o. — n'écrit pas |
| Projection / audit | lecture seule | non | non | non | non | s.o. — n'écrit pas |
| Banc (`tests/lab`) | met en scène B et C | oui | oui | oui | oui | **oui, délibérément** |
| Administration | *n'existe pas* | — | — | — | — | — |

Deux lignes méritent qu'on s'y arrête.

**Les écritures pré-bail** ne peuvent pas être cloisonnées : ce sont celles qui
rendent la frappe du bail possible. Leur garde est un **littéral d'état d'où
aucun effet externe n'est possible**. Un exécutant périmé est en `EXECUTING` ou
au-delà, donc exclu par la clause. Ce n'est pas une tolérance : c'est une
catégorie nommée, et **vérifiée par test** — un `UPDATE` pré-bail lancé contre
une opération engagée écrit 0 ligne.

**Le banc contourne délibérément**, et I17 ne balaie que `src/`. Un test
incapable de mettre en scène un autre exécutant ne pourrait rien prouver.

---

## 4. Ce que l'audit a trouvé — deux chemins parallèles, aucun par relecture

### 4.1 Le rembobinage gardé par `attempts`

Le rembobinage `NO_EFFECT → PLANNED` était gardé par `attempts`, tenu depuis
Foundation 3 pour un numéro de version suffisant.

```text
B reprend            →  génération 5, `attempts` INCHANGÉ
B interroge le monde →  NO_EFFECT (la lecture prend du temps)
C reprend            →  génération 6 ; B est périmé
B rembobine          →  `attempts` n'a pas bougé : ÇA PASSE
```

`claimForRecovery` ne touche pas à `attempts` — seule l'exécution l'incrémente
— si bien que **le compteur ne voyait pas passer les reprises**. Un exécutant
sans autorité rouvrait l'exécution d'une opération qu'un autre tranchait.

C'est la troisième fois qu'`attempts` échoue à jouer le rôle qu'on lui prêtait
(Foundation 3, CRIT-5 de Foundation 4, ici). Le motif est constant : *un
compteur d'exécutions ne mesure pas l'autorité.*

### 4.2 Le journal n'était pas cloisonné

Le registre était protégé, le journal ne l'était pas : un exécutant périmé y
inscrivait `…_FAILED`, et `/audit` lisait une histoire contradictoire avec
l'état.

**Le supprimer aurait été pire.** L'événement est parfois la seule trace qu'une
requête est partie vers le monde. Il est donc conservé sous `…_STALE`, statut
`UNKNOWN` : l'exécution reste, l'opinion part.

---

## 5. Ce que la correction change

```sql
lease_generation INTEGER NOT NULL DEFAULT 0   -- le jeton
lease_expires_at TIMESTAMPTZ                  -- échéance, clock_timestamp()
lease_owner      TEXT                         -- diagnostic SEUL
CHECK (state <> 'EXECUTING' OR lease_expires_at IS NOT NULL)
```

La migration attribue aux lignes déjà en `EXECUTING` un bail **déjà expiré** :
elle ne doit pas ressusciter l'autorité d'un exécutant dont plus personne ne
sait s'il existe. `FAIL CLOSED` appliqué à la migration elle-même.

**Une seule garde pour toutes les colonnes.** Un cloisonnement écrit colonne
par colonne aurait la faiblesse qu'il prétend corriger : un `SET` oublié
rouvrirait le passage sans que rien ne le signale.

---

## 6. Les épreuves

### 6.1 Adversariales — `fencing-adversarial.test.ts`, 13 tests

Le scénario du mandat, littéralement : **A(4) → B(5) → A revient.**

Neuf combinaisons — trois états terminaux écrits par B × trois retours de A :

| B écrit | A revient en succès | A revient en erreur | A dépasse son délai |
|---|---|---|---|
| `SUCCEEDED` / `CONFIRMED` | refusé | refusé | refusé |
| `FAILED` / `FAILED` | refusé | refusé | refusé |
| `UNKNOWN` / `UNKNOWN` | refusé | refusé | refusé |

**La vérification porte sur la ligne entière**, pas sur une liste de colonnes :
`to_jsonb(ligne)` est comparé avant et après le retour de A, et l'ensemble des
colonnes modifiées doit être **vide**. Énumérer les colonnes à protéger serait
se condamner à en oublier une le jour où le schéma bouge ; la comparaison
d'instantané couvre aussi celles qui n'existent pas encore.

S'y ajoutent :

- la frontière négative — **l'effet de A existe malgré tout** ;
- le journal marqué plutôt qu'effacé ;
- les écritures pré-bail impuissantes contre une opération engagée ;
- la régression du rembobinage périmé (§4.1).

### 6.2 Le test de sabotage — sans lui, « vert » ne prouve rien

La garde de cloisonnement a été **retirée** de la primitive, et la suite
relancée :

```text
12 échecs sur 13
```

Le survivant est le test des écritures pré-bail, qui par construction ne dépend
pas du cloisonnement. La suite mord donc réellement — ce n'est pas une
suite qui passerait de toute façon.

### 6.3 Structurelles — `fencing-structure.test.ts`, 11 tests

L'invariant **I17** :

> Tout `UPDATE tool_operations` de `src/` est soit cloisonné par
> `lease_generation`, soit cantonné à un état d'où aucun effet n'est possible.

Fermé par défaut : toute forme que l'analyseur ne sait pas lire compte comme
non gardée. Six **contrôles négatifs** l'attaquent, dont la faute exacte de
`docs/23 §6`, une écriture d'une seule colonne, une garde par `attempts`, et
une clause `WHERE` injectée depuis une variable. Deux contrôles positifs
vérifient qu'il ne crie pas au loup.

**I17 a signalé sa propre documentation** à la première exécution : ADR-035
cite `UPDATE tool_operations` en prose, entre accents graves markdown.
L'analyseur filtre désormais les commentaires — une garde qui hurle sur un
commentaire finit désactivée, et le trou se rouvrirait par lassitude plutôt que
par décision.

### 6.4 I15 — le marqueur a fonctionné comme annoncé

`docs/23 §6` écrivait, avant la correction :

> *Le jour où le cloisonnement sera implémenté, Vitest signalera que le test
> « aurait dû échouer » : la correction ne peut pas se faire en silence, et le
> marqueur ne peut pas être oublié.*

C'est exactement ce qui s'est produit. À la première exécution suivant la
migration : `Expect test to fail`. Le marqueur `it.fails()` est retiré parce
que la propriété est tenue — pas parce qu'il gênait.

---

## 7. CE QUE L'ÉPREUVE A CASSÉ AILLEURS — et pourquoi c'est la meilleure nouvelle du sprint

Le passage de `now()` à `clock_timestamp()` a fait cesser de tirer deux points
d'arrêt de la sonde de crash, qui reconnaissaient l'écriture terminale au motif
`observed_at = now()`.

**Aucune suite n'est devenue rouge pour autant :**

| Point | Effet réel | Ce que le test rapportait |
|---|---|---|
| E — crash avant persistance | ne plantait plus | exécution normale → écart visible |
| F — crash après persistance | ne plantait plus | **vert, pour une mauvaise raison** |

La ligne F est la leçon. Un test qui n'éprouve plus rien rend le même verdict
qu'un système correct.

**Deux corrections, pas une :**

1. le motif reconnaît la **colonne**, jamais la fonction qui l'alimente ;
2. `crashThenRecover` vérifie désormais que le point d'arrêt **a bien tiré**.
   Une sonde muette ne peut plus se faire passer pour un test vert.

C'est le même défaut que la sentinelle réseau de Foundation 3, sous une autre
forme. Il ne sera pas le dernier : l'instrumentation qui reconnaît le code par
son texte se périme dès que le code change.

---

## 8. Classification honnête

| Propriété | Verdict |
|---|---|
| Un exécutant périmé ne peut modifier aucune colonne | **PROUVÉ** dans l'environnement testé |
| … y compris colonne par colonne | **PROUVÉ** — comparaison d'instantané complet |
| … quel que soit l'état terminal établi par le repreneur | **PROUVÉ** — 3 états × 3 retours |
| Deux exécutants ne partagent jamais une génération | **PROUVÉ** — frappée dans le CAS |
| Aucune écriture de `src/` ne contourne le cloisonnement | **PROUVÉ STRUCTURELLEMENT** — I17 |
| … et l'analyseur d'I17 n'est pas aveugle | **PROUVÉ** — 6 contrôles négatifs |
| La suite de cloisonnement mord | **PROUVÉ** — 12/13 rouges après sabotage |
| Un repreneur périmé ne peut pas rembobiner | **PROUVÉ** — régression dédiée |
| Le verdict de bail ignore l'horloge du processus | **PROUVÉ** (`docs/23 §4`) |
| Le Gateway est immun à une transaction englobante | **PROUVÉ** — mesuré, par isolation de connexion |
| L'effet externe de A n'est pas annulé | **MESURÉ** — et c'est la frontière, pas un défaut |
| Qu'un exécutant périmé n'ait produit aucun effet | **NON GARANTI** — hors de portée du mécanisme |
| Que sa requête soit annulée | **NON GARANTI** — rien dans la pile ne l'offre |
| Que le bail dise quelque chose de la vie d'un processus | **NON GARANTI** — et le restera |
| Comportement sur deux hôtes physiques | **NON TESTÉ** |
| Dérive d'horloge entre deux serveurs PostgreSQL | **NON TESTABLE** — une seule instance |

> Aucun chiffre global de tests n'est présenté ici comme une preuve de
> sécurité. Le seul chiffre qui informe est **12/13 après sabotage** : il dit
> que la suite mesure quelque chose. Le nombre de tests verts, lui, ne dit
> rien.

---

## 9. LA FRONTIÈRE — à ne jamais déplacer

```text
le cloisonnement PROTÈGE       l'état interne de Jarvis contre ses anciens
                               exécutants

le cloisonnement NE PROTÈGE    le monde extérieur contre une requête déjà
PAS                            partie

    fencing ≠ annulation ≠ idempotence ≠ vérification ≠ absence d'effet
```

Un test mesure explicitement la moitié négative : A est déclaré périmé, son
écriture est refusée, **et son effet existe dans le monde**. Un système qui
conclurait « écriture refusée, donc pas d'effet » aurait remplacé un défaut par
un mensonge — et celui-là serait invisible.

Les sept notions restent séparées. Le cloisonnement n'en rapproche aucune :

| Notion | Ce que F5.1 en établit |
|---|---|
| **CLOCK** | trois horloges, rôles assignés par champ (§2) |
| **LEASE** | acquisition exclusive ; expiration = droit de reprendre, rien d'autre |
| **FENCING** | **implémenté et mesuré** — protège l'état interne, uniquement |
| **PROCESS LIVENESS** | **rien**, et aucune couche ultérieure ne le donnera |
| **REQUEST LIFECYCLE** | hors périmètre |
| **EXTERNAL EFFECT** | hors périmètre |
| **EXTERNAL EFFECT VERIFICATION** | hors périmètre |

---

## 10. Ce qui n'a pas été fait, et pourquoi

| | |
|---|---|
| **Battement de cœur** | non implémenté. Aucune mesure ne montre que la latence de reprise gêne. Il ajouterait une écriture périodique et un mode de panne neuf. À rouvrir sur mesure, pas sur intuition. |
| **`now()` corrigé partout** | non. Le contrôle d'expiration garde `now()` : figé, il ne peut que bloquer une reprise. Corriger ce qui protège déjà aurait été du bruit. |
| **Interdiction d'envelopper le Gateway** | non. La mesure montre que c'est impossible par construction du pool. Une interdiction déclarative ajouterait une règle sans ajouter de garantie. |
| **Multi-hôtes** | non. Une seule instance PostgreSQL ici — l'affirmer serait le genre de chiffre qui ne prouve rien. |
