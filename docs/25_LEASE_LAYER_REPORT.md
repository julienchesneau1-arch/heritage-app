# 25 — COUCHE 02 : LE BAIL

**Foundation 5, couche 02.** La couche 01 a mesuré les horloges ; celle-ci
mesure ce que le bail en fait — acquisition, expiration, concurrence, gel,
absence de renouvellement, partition.

Tout est local : PostgreSQL et Node. **0 € de coût opérationnel.**

---

## 1. Le défaut, et il venait d'un audit et non du chaos

`docs/24 §7 bis` avait consigné une découverte sans la corriger :
`lease_expires_at` était **écrit et jamais lu**. Le contrôle d'expiration
reconstituait l'échéance avec le `timeoutMs` que **le repreneur** connaissait.

### Le contre-exemple minimal

Reproduit **sans aucun `sleep`**, sur un état que le système sait produire :

```text
A part avec timeoutMs = 30 000        →  échéance réelle : +35 s
6 secondes passent
le contrat change, redéploiement      →  timeoutMs = 2 000
B reprend et RECALCULE                →  seuil à 7 s : « expiré depuis 800 ms »
                                         ⟹ REPRISE PRÉMATURÉE de 29 s
```

Et sa symétrie, qui coûte de la disponibilité plutôt que de la sûreté : un
`timeoutMs` **allongé** faisait paraître vivant un bail expiré depuis dix
secondes.

### La quatrième occurrence du même motif

| Sprint | La phrase qu'on croyait vraie | Verdict |
|---|---|---|
| Foundation 3 | `attempts` distingue un mort d'un vivant | **faux** |
| Foundation 4 | idem — retrouvé par le chaos (CRIT-5) | **faux** |
| F5.1 | `attempts` garde le rembobinage | **faux** |
| F5.2 | le `timeoutMs` du repreneur donne l'échéance | **faux** |

> **L'OBSERVATEUR REDÉFINIT LE PASSÉ** — quatre fois, sous quatre déguisements.

C'est ce qui justifie un **invariant** plutôt qu'un correctif. Voir ADR-036.

---

## 2. La correction

```sql
COALESCE(lease_expires_at, 'infinity'::timestamptz) > now()
```

`def.timeoutMs` ne participe plus à aucune décision de reprise : il ne sert
qu'à **fixer** l'échéance, à l'acquisition.

`COALESCE(…, 'infinity')` est du **FAIL CLOSED**. `now()` est **conservé** :
figé, il ne peut que sur-estimer le bail, donc bloquer — la direction qui
protège (`docs/23 §3.1`).

**Effet de bord bénéfique :** `LEASE_MARGIN_MS` était appliqué deux fois, à
l'acquisition puis au contrôle. Il ne l'est plus qu'une.

### Sabotage

Ligne corrigée remise dans son état antérieur, suite relancée :

```text
3 échecs sur 7
```

Les quatre survivants ne dépendent pas de l'échéance (acquisition, concurrence
de reprise, renouvellement, partition). La correction est bien ce qui rend les
trois autres verts.

---

## 3. CE QUE LES TESTS EXISTANTS CACHAIENT

La correction a fait rougir **quatre tests de `crash-concurrency`** qui
passaient depuis Foundation 3. Le diagnostic est le plus instructif du sprint :

```text
sonde de crash        →  prend son bail avec timeoutMs = 20 000  →  échéance +25 s
pile de reprise       →  recalcule avec timeoutMs = 300          →  seuil 5,3 s
l'attente du test     →  5 500 ms
```

**Les tests passaient GRÂCE au défaut.** Ils encodaient la reprise prématurée :
le repreneur et le test s'accordaient sur une échéance que *personne n'avait
fixée*, et qui ne correspondait à aucun bail réel.

Deux corrections, et la seconde compte plus que la première :

| | |
|---|---|
| La sonde prend son bail avec le **même** délai que le repreneur | supprime le désaccord |
| `waitForLease` **lit** `lease_expires_at` au lieu de l'estimer | supprime la possibilité du désaccord |

La seconde applique au banc la leçon exacte d'ADR-036 : *on n'estime plus
l'échéance, on la lit.* Un test qui reconstitue un fait qu'il pourrait
interroger finit par mesurer sa propre reconstitution.

---

## 4. Ce que la couche 02 a mesuré

### 4.1 Acquisition

30 appels simultanés à travers le **Gateway complet** — politique, journal,
vérification comprises, et non un compare-and-swap en SQL nu comme en
couche 01.

```text
exécutions réelles     = 1
attempts               = 1
lease_generation       = 1
```

Un goulot correct en SQL mais contourné par la couche au-dessus ne vaudrait
rien ; c'est pourquoi la mesure passe par la pile entière.

### 4.2 Concurrence de reprise — et une assertion de MOI qui était fausse

20 reprises simultanées sur un bail expiré. J'attendais « exactement un
vainqueur ». **La mesure en a rendu quatre, et le système avait raison :**

- le bail ne garde que la reprise depuis `EXECUTING` ;
- une opération en `UNKNOWN` n'a plus d'exécutant vivant — celui qui a écrit
  `UNKNOWN` avait terminé — donc plus de bail à respecter ;
- les repreneurs se succèdent par génération et re-constatent la même
  ignorance.

C'est répétitif, pas dangereux. La propriété n'a jamais été « un seul
vainqueur ». C'est :

```text
attempts = 1                          aucune seconde exécution
tout verdict rendu = UNKNOWN          aucune ignorance levée sans preuve
générations consommées = vainqueurs   sérialisation réelle
```

### 4.3 Gel — la propriété la plus importante est une LIMITE

Un exécutant **bel et bien vivant** attend dans `execute`. Son bail est forcé à
expiration. B reprend — légitimement du point de vue du bail, à tort du point
de vue de la réalité. A se réveille et se voit refuser toute écriture.

| Mécanisme | Ce qu'il a fait ici |
|---|---|
| **bail** | a autorisé B à reprendre — sans savoir que A vivait |
| **cloisonnement** | a refusé l'écriture de A |

Les deux sont **distincts**, et c'est le cloisonnement qui a protégé l'état,
pas le bail. Aucune mesure ne permet de distinguer « gelé » de « mort ».
`docs/21` l'avait établi ; la couche 02 le confirme au lieu de l'espérer résolu.

### 4.4 Absence de renouvellement — le coût de la décision 🟢

Le battement de cœur a été explicitement écarté. **Cette décision a un coût, et
le taire serait malhonnête.** Mesuré :

```text
échéance à T0                         inchangée à T0+300 ms
aucun code, nulle part, ne la repousse
⟹ passé l'échéance, une opération devient reprenable
   même si son exécutant se porte bien
```

Le test ne demande pas de correction. Il **mesure le coût de la décision**,
pour qu'une révision éventuelle se fonde sur un chiffre plutôt que sur une
intuition.

### 4.5 Partition — ce qui est réellement mesurable

La partition réseau complète n'est pas mesurable sur une machine unique, et le
prétendre serait exactement le genre de chiffre qui ne prouve rien.

Ce qui **est** mesurable : la base injoignable. La propriété qui compte alors
n'est pas « Jarvis continue », c'est **« Jarvis ne tente rien »** — un bail ne
peut pas être frappé sans la base, donc aucun effet ne peut partir sans trace
d'intention.

```text
PROVIDER_UNAVAILABLE  ·  « Rien n'a été tenté »
```

---

## 5. L'invariant I18

> L'échéance d'un bail est lue dans `lease_expires_at`, jamais recalculée à
> partir d'`executing_at` et du `timeoutMs` de l'observateur.

Mécanique : toute **comparaison** portant sur `executing_at` dans `src/` est une
violation. `executing_at` est un fait d'archive — *quand l'appel est parti* — et
en faire une borne de décision oblige à lui ajouter une durée, donc à laisser
l'observateur trancher.

I16 et I18 se partagent la colonne sans se recouvrir :

| | Garde | Question posée |
|---|---|---|
| **I16** | `executing_at =` | avec quelle horloge l'écrit-on ? |
| **I18** | `executing_at <` `>` | s'en sert-on pour décider ? |

Quatre contrôles, dont le contre-exemple exact de ce sprint et une vérification
que l'**écriture** d'`executing_at` n'est pas signalée — confondre les deux
ferait « corriger » l'acquisition, qui est parfaitement légitime.

---

## 6. Classification honnête

| Propriété | Verdict |
|---|---|
| L'échéance appartient à l'acquisition, pas à l'observateur | **PROUVÉ** — contre-exemple + sabotage |
| Un `timeoutMs` raccourci ne raccourcit pas un bail déjà pris | **PROUVÉ** |
| Un `timeoutMs` allongé ne prolonge pas un bail expiré | **PROUVÉ** |
| Acquisition exclusive à travers le Gateway complet | **PROUVÉ** — 30 concurrents |
| Aucune seconde exécution sous 20 reprises concurrentes | **PROUVÉ** |
| Aucun repreneur ne lève l'ignorance sans preuve | **PROUVÉ** |
| Aucune décision de bail ne recalcule l'échéance | **PROUVÉ STRUCTURELLEMENT** — I18 |
| Sans base, rien n'est tenté | **PROUVÉ** |
| Le bail distingue un exécutant gelé d'un mort | **NON GARANTI** — mesuré impossible |
| Un bail est prolongé tant que l'exécutant vit | **NON TENU** — aucun renouvellement, coût mesuré |
| Comportement sous partition réseau réelle | **NON TESTABLE** — une seule machine |
| Dérive d'horloge entre deux serveurs PostgreSQL | **NON TESTABLE** — une seule instance |

> Le seul chiffre qui informe est **3/7 après sabotage** et **4 tests
> historiques démasqués**. Le nombre de tests verts ne dit rien.

---

## 7. Ce qui n'a pas été ajouté, et pourquoi

L'avertissement du mandat s'applique littéralement ici : *« si une partie
n'apporte aucune garantie supplémentaire mesurable, on la supprime »*.

| | |
|---|---|
| **Battement de cœur / renouvellement** | non. Le coût de son absence est désormais **mesuré** (§4.4) plutôt que supposé. À rouvrir sur ce chiffre, pas sur une intuition. |
| **Détection de partition** | non. Une seule machine ; ce qui était mesurable l'a été, le reste est classé NON TESTABLE plutôt que simulé. |
| **Renouvellement automatique du bail** | non. S'il arrive un jour, il devra passer par `writeAuthoritative` — un renouvellement non cloisonné ressusciterait le défaut qu'ADR-035 a fermé (condition de révision d'ADR-036). |
