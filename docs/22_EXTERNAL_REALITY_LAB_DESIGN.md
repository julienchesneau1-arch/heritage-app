# 22 — EXTERNAL REALITY LAB : conception

**Foundation 5, phase DISCOVERY.** Aucune ligne de banc n'est écrite. Ce
document existe pour que la conception soit critiquable **avant** d'être
coûteuse à changer.

---

## 1. Ce que ce sprint doit prouver — et ce qu'il ne doit pas faire

**Objectif unique :**

> Prouver que le noyau se comporte correctement quand le monde extérieur se
> comporte mal.

**Hors périmètre, explicitement :** aucun outil produit, aucune intégration
réelle, aucun email, aucun agenda, aucun paiement. Le banc ne teste pas des
fonctionnalités : il teste la frontière.

**La question posée à chaque scénario :**

```text
même intention · mêmes paramètres · même OperationIdentity
                        ↓
        conditions extérieures différentes
                        ↓
              résultat VÉRIFIABLE
```

---

## 2. Architecture du banc

Quatre couches, et la séparation est ce qui rend les mesures crédibles.

```text
┌──────────────────────────────────────────────────────────┐
│  SCÉNARIO           déclaratif — temps × réseau × process │
│                     × contrat × honnêteté                 │
├──────────────────────────────────────────────────────────┤
│  ORCHESTRATEUR      lance les processus, injecte les      │
│                     pannes, ordonne les instants          │
├──────────────────────────────────────────────────────────┤
│  JARVIS             le noyau RÉEL — jamais simulé         │
├──────────────────────────────────────────────────────────┤
│  MONDE              table hors transaction + journal des  │
│                     requêtes REÇUES par le fournisseur    │
└──────────────────────────────────────────────────────────┘
```

### Ce que le monde doit enregistrer en plus d'aujourd'hui

Le banc actuel compte les **effets**. Il ne voit pas les **requêtes**. Or la
distinction est exactement celle que Foundation 4.1 a rendue centrale :

| Table | Ce qu'elle établit |
|---|---|
| `lab_world_effects` | le monde a changé |
| `lab_provider_requests` | le fournisseur a **reçu** une demande |

Sans la seconde, on ne peut pas distinguer « requête jamais reçue » de
« requête reçue, effet produit, réponse perdue » — deux situations que Jarvis
voit à l'identique et qui n'ont pas la même vérité.

### Le harnais temporel

Les scénarios manipulent des instants relatifs, jamais des `sleep` dispersés :

```text
t0   requête émise
t1   requête reçue par le fournisseur
t2   effet produit
t3   réponse émise
t4   réponse reçue par Jarvis   (ou jamais)
```

Chaque famille de panne se définit alors comme une contrainte sur ces cinq
instants — ce qui rend la matrice §5 énumérable au lieu d'anecdotique.

---

## 3. Modèle de fournisseur

### 3.1 Les cinq contrats, et ce qu'ils autorisent après `UNKNOWN`

| Contrat | `FAILED` possible | Rejeu | Ce que le fournisseur doit garantir |
|---|---|---|---|
| `NO_EXTERNAL_EFFECT` | ✅ | ✅ | rien : il n'y a pas d'effet |
| `LOCAL_TRANSACTIONAL` | ✅ | ✅ | rollback atomique avec le journal |
| `PROVIDER_IDEMPOTENT` | ❌ | ✅ | même identité ⟹ au plus un effet |
| `EXTERNALLY_VERIFIABLE` | ❌ | ❌ | interrogation autoritaire sur l'existence |
| `UNVERIFIABLE` | ❌ | ❌ | rien |

Chaque contrat exige **un fournisseur honnête de référence** : une
implémentation qui respecte exactement ce qu'elle déclare. Sans elle, on ne
saurait pas si un échec vient du noyau ou du simulateur.

### 3.2 Honnête vs byzantin

```text
HONNÊTE     déclare C, respecte C
BYZANTIN    déclare C, viole C
```

Le fournisseur byzantin n'est pas un cas exotique : c'est un service qui a un
bogue, une version qui change sans préavis, une documentation optimiste. Quatre
formes à simuler :

- déclare `PROVIDER_IDEMPOTENT`, produit **deux** effets pour une identité ;
- répond `200` sans effet ;
- répond deux choses contradictoires à la même question ;
- répond `500` puis produit l'effet.

### 3.3 Ce que Jarvis doit faire face à une violation

**Il ne peut pas l'empêcher.** Un fournisseur qui double un virement le double,
et aucun code local n'y changera rien. La propriété visée est donc ailleurs :

| Exigence | Vérifiable ? |
|---|---|
| ne jamais **masquer** la violation | ✅ |
| ne jamais traiter une assertion fournisseur comme preuve absolue | ✅ |
| **journaliser** la violation comme rupture de confiance | ✅ |
| dégrader la confiance accordée à ce fournisseur | ✅ |
| n'entreprendre aucune action nouvelle sur une information compromise | ✅ |
| empêcher physiquement le second effet | ❌ **impossible** |

Un état terminal nouveau est nécessaire :
`PROVIDER_CONTRACT_VIOLATION`. Il ne décrit pas l'action mais **le
fournisseur** — et il doit être plus fort qu'`UNKNOWN` : on ne sait pas ce qui
s'est passé, *et* on sait que la source n'est plus fiable.

---

## 4. Modèle de panne

### 4.1 Temps

`1 ms · 100 ms · 800 ms · 5 s · 30 s`, plus quatre positions relatives qui
comptent davantage que les durées :

```text
réponse après le timeout local
réponse après l'expiration du bail
réponse après un crash de Jarvis
réponse après un redémarrage complet
```

### 4.2 Réseau

```text
requête jamais reçue              (t1 n'existe pas)
requête reçue, réponse perdue     (t1, t2, pas de t4)
effet produit, réponse perdue     (t1, t2, t3, pas de t4)
partition pendant l'exécution
rétablissement après reprise
connexion interrompue
```

Les trois premières lignes sont **indiscernables depuis Jarvis**. C'est le cœur
du sprint : le banc, lui, les distingue grâce à `lab_provider_requests`, et
peut donc dire si le verdict de Jarvis était honnête.

### 4.3 Processus

```text
crash avant l'appel · pendant · après
SIGKILL · freeze > bail · redémarrage
deux processus simultanés · deux machines
```

### 4.4 Multi-machine — ce qui est réellement mesurable ici

`docs/20 §7` classait cette propriété « argumentée, pas mesurée ». Il faut être
précis sur ce que ce sprint peut fermer, et sur ce qu'il ne peut pas.

| Aspect | Mesurable dans cet environnement ? |
|---|---|
| Deux processus, pools distincts, même base | ✅ déjà fait (Foundation 3) |
| **Dérive d'horloge** entre exécutants | ✅ en injectant un décalage sur `Date.now` |
| Ordonnancement non déterministe entre exécutants | ✅ par jitter |
| Partition réseau **entre Jarvis et PostgreSQL** | ✅ en coupant la base |
| Deux hôtes physiques distincts | ❌ un seul conteneur |
| Latence réseau réelle vers la base | ◐ simulable, non native |

**Ce que je propose de mesurer, et qui ferme la vraie question :** le bail est
évalué par la base. Sa correction ne doit donc rien devoir à l'horloge locale.
Un test qui fait tourner un exécutant avec `Date.now` décalé de ±1 heure et
vérifie que le comportement du bail est inchangé **prouve la propriété qui
importe** — l'immunité à la dérive d'horloge — sans prétendre au multi-hôte.

Je ne présenterai pas cela comme « multi-machine testé ». Ce sera :
*« immunité à la dérive d'horloge : PROVEN. Deux hôtes physiques : NOT
TESTABLE ici. »*

---

## 5. Matrice des scénarios

Le produit cartésien complet est inutilisable. La matrice se construit sur les
axes qui **changent la vérité**, pas sur ceux qui changent les chiffres.

| Axe | Valeurs | Pourquoi il change la vérité |
|---|---|---|
| Contrat d'effet | 5 | décide du droit de rejouer |
| Honnêteté | 2 | décide si la déclaration vaut |
| Position de l'effet | 5 instants | décide si un rejeu double |
| Panne | ~12 | décide de ce que Jarvis observe |
| Concurrence | 1 · 2 · 10 · 50 | décide si l'exclusion tient |
| Processus | 1 · 2 · crash · redémarrage | décide si l'état survit |

Deux régimes d'exécution :

**Dirigé** — les combinaisons nommées dans le mandat, jouées à coup sûr. Une
combinaison qu'on juge importante ne doit pas dépendre d'une graine.

**Aléatoire** — le chaos existant (`docs/20 §4`), étendu aux nouveaux axes, avec
graine déterministe et minimisation du contre-exemple.

---

## 6. Invariants

### L'invariant global

```text
Pour toute OperationIdentity :   external_effect_count(identité, cible) ≤ 1
```

Vérifié après **chaque** scénario, toutes familles confondues — jamais comme un
test parmi d'autres.

### La distinction que le fournisseur byzantin impose

Quand la violation vient du fournisseur, il faut classer plutôt que promettre :

| Classe | Signification |
|---|---|
| **A** | violation que Jarvis peut **empêcher** |
| **B** | violation **impossible** à empêcher depuis Jarvis |
| **C** | violation **détectable** après coup |
| **D** | violation **non détectable** |

> **Ne jamais annoncer A quand seul C est possible.**

Un fournisseur qui double un effet sur une identité unique relève de **B et C** :
on ne l'empêche pas, on le voit. C'est une propriété honnête, et très
différente d'une garantie.

### Nouveaux invariants candidats

| | Énoncé | Famille |
|---|---|---|
| **I11** | toute violation de contrat détectée est journalisée comme telle | byzantin |
| **I12** | aucune action nouvelle n'est engagée après une violation détectée | byzantin |
| **I13** | tout état terminal possède une chaîne de provenance complète | provenance |
| **I14** | le comportement du bail est indépendant de l'horloge locale | temps |

Chacun devra, comme I1–I10, disposer d'un **témoin négatif** : un test qui
injecte la violation et vérifie qu'elle est vue.

---

## 7. Provenance de la vérité

Jarvis doit pouvoir répondre à deux questions, et la seconde est celle qu'on
oublie toujours :

```text
« Pourquoi affirmes-tu que c'est fait ? »
« Pourquoi refuses-tu de recommencer ? »
```

La chaîne à reconstruire :

```text
INTENTION → OPERATION → REQUEST → RESPONSE → OBSERVATION → VERIFICATION → OUTCOME
```

Deux exemples de ce qui doit être produit :

```text
INTENTION → OPERATION → REQUEST → RESPONSE 200 → OBSERVATION(effet vu)
          → VERIFICATION(POSITIVE_PRESENCE) → CONFIRMED

INTENTION → OPERATION → REQUEST → TIMEOUT → OBSERVATION(néant)
          → VERIFICATION(aucune preuve) → UNKNOWN → PAS DE REJEU
                                          (contrat EXTERNALLY_VERIFIABLE)
```

Et ce qui doit être **impossible à produire** :

```text
REQUEST → TIMEOUT → « probablement fait » → CONFIRMED
```

**État actuel :** l'Event Ledger porte déjà `INTENTION → OPERATION → OUTCOME`.
Manquent `REQUEST` et `RESPONSE` — le Gateway ne journalise pas l'appel
lui-même. C'est la principale addition de structure du sprint, et elle sert
directement le fournisseur byzantin : sans trace de la requête, une violation
n'est pas démontrable.

---

## 8. États terminaux — l'invariant verrouillé

```text
CONFIRMED   preuve positive d'effet
FAILED      preuve positive d'absence
UNKNOWN     preuve insuffisante
```

et les cinq inégalités, chacune devant avoir son test :

```text
timeout       ≠ FAILED        ✅ déjà tenu
crash         ≠ FAILED        ✅ déjà tenu
bail expiré   ≠ FAILED        ✅ déjà tenu
HTTP 500      ≠ FAILED        ✅ déjà tenu
HTTP 200      ≠ CONFIRMED     ◐ tenu pour les outils OBSERVABLE
```

La dernière mérite attention. Un `200` n'est pas une preuve de l'**effet
métier** : une API peut accuser réception d'une demande d'envoi sans que
l'email parte jamais. Le Verification Engine plafonne déjà à `PROBABLE` en
l'absence de relecture — ce qui est correct — mais aucun test ne met en scène un
`200` **structurellement mensonger sur le plan métier**, par opposition à un
`200` simplement non recoupé. À ajouter.

---

## 9. Classification des résultats

Aucun chiffre global ne sera présenté comme une preuve. Quatre catégories, et
chaque ligne du rapport final en portera une :

| Catégorie | Signification |
|---|---|
| **PROVEN** | un test nommé, reproductible, avec témoin négatif |
| **PARTIALLY PROVEN** | tenu dans les conditions testées, avec la limite écrite |
| **NOT TESTABLE** | l'environnement ne le permet pas — raison explicite |
| **NOT GUARANTEED** | le système ne le garantit pas, et on le dit |

`NOT GUARANTEED` n'est pas un aveu d'échec. C'est la seule façon de rendre
utilisables les garanties qui, elles, tiennent.

---

## 10. Ordre d'implémentation proposé

Chaque étape reste soumise à la discipline
`DISCOVERY → CONTRE-EXEMPLE → MESURE → INVARIANT → ADR → CODE → TEST → RÉGRESSION`.

| # | Étape | Pourquoi à ce rang |
|---|---|---|
| 1 | Journal des requêtes fournisseur | sans lui, rien d'autre n'est démontrable |
| 2 | Chaîne de provenance `REQUEST`/`RESPONSE` | prérequis du fournisseur byzantin |
| 3 | Fournisseurs honnêtes, un par contrat | référence avant déviation |
| 4 | Harnais temporel (les cinq instants) | rend la matrice énumérable |
| 5 | Fournisseur byzantin + `PROVIDER_CONTRACT_VIOLATION` | le cœur du sprint |
| 6 | Injection de dérive d'horloge | ferme la dette du bail |
| 7 | I11–I14 avec témoins négatifs | |
| 8 | Extension du chaos aux nouveaux axes | |
| 9 | Rapport classé PROVEN / PARTIAL / NOT TESTABLE / NOT GUARANTEED | |

---

## 11. Ce que je crois déjà, et que je vais donc essayer de casser

Méthode retenue des deux sprints précédents : **une phrase d'architecture qui
semble raisonnable doit d'abord recevoir son contre-exemple.** Quatre phrases
que je tiens actuellement pour vraies, et que le banc devra attaquer :

1. *« Le bail évalué par la base est immunisé à la dérive d'horloge. »*
   → contre-exemple à chercher : une transaction longue qui fige `now()`.
   PostgreSQL rend l'heure de **début de transaction** — si la vérification du
   bail se produit dans une transaction ouverte de longue date, `now()` ment.

2. *« `lab_provider_requests` établit qu'une requête a été reçue. »*
   → contre-exemple : une requête reçue mais dont l'enregistrement échoue.
   Le journal du monde a lui aussi ses pannes.

3. *« Un fournisseur byzantin est toujours détectable après coup. »*
   → contre-exemple : deux effets sur deux cibles différentes, indiscernables
   d'un succès partiel légitime. Détectable seulement si les cibles sont
   connues à l'avance.

4. *« La chaîne de provenance prouve pourquoi Jarvis affirme. »*
   → contre-exemple : une chaîne complète et cohérente construite sur une
   observation elle-même erronée. La provenance prouve le **raisonnement**,
   jamais le monde.

Le point 1 est le plus inquiétant, et je le traiterai en premier : il
invaliderait ADR-032 une troisième fois.
