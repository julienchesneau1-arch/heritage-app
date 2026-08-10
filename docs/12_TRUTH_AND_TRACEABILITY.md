# 12 — ARCHITECTURE DE VÉRITÉ ET TRAÇABILITÉ

**Sprint Foundation 2 puis 2.1.** Le gel a été levé pour **une seule**
correction — le journal d'intention (ADR-027), désormais implémenté et éprouvé
par sept scénarios de crash réels. Tout le reste de ce document reste de la
spécification.

Trois livrables :

1. le contrat de vérité, éprouvé sur des cas réels (§1–§2) ;
2. la **matrice adversariale**, avec l'état vérifié de chaque ligne (§4) ;
3. trois chantiers spécifiés, non implémentés (§5–§7), chacun avec les huit
   rubriques demandées.

Les décisions sont ratifiées en **ADR-025** (vérité) et **ADR-026** (mémoire
bitemporelle). Ce document est le travail qui les a produites et les éprouve.

---

## 1. Le contrat, appliqué à un cas réel

Un contrat qu'on ne déroule pas sur un cas concret est une figure de style. Voici
`SOURCE → EVIDENCE → INTERPRETATION → DECISION → ACTION → OBSERVATION` sur la
demande la plus banale qui soit.

> **« Prépare le mail à Jean pour lui demander où en est le devis. »**

```text
SOURCE          conversation, tour #938, saisie clavier
                provenance USER — la seule source fiable par nature

EVIDENCE        ─ contact « Jean Dupont », dernier échange le 8 août
                ─ mémoire : « le devis du carreleur est attendu »
                chaque élément porte SA provenance ; aucune n'est fusionnée

INTERPRETATION  « Jean » → Jean Dupont, et non Jean Martin
                ⚠ C'EST UNE DÉDUCTION. Provenance MODEL_OUTPUT (ADR-024).
                Elle ne peut pas alimenter un destinataire sans confirmation.

DECISION        Policy Gate : préparer un brouillon = L3
                → PRÉPARER, NE PAS ENVOYER
                le destinataire vient d'une déduction → confirmation sur la VALEUR

ACTION          gmail.create_draft(...)   opération 8f2a…
                inscrite EXECUTING AVANT l'appel (ADR-027)

OBSERVATION     draft_id = r-9931  ← preuve du fournisseur
                relecture indépendante : le brouillon existe, destinataire conforme
                → CONFIRMED
```

Et le même cas qui tourne mal :

```text
ACTION          gmail.create_draft(...)   opération 8f2a…
                inscrite EXECUTING

OBSERVATION     ─ pas de réponse en 5 s
                ─ relecture impossible : Gmail ne répond pas
                → UNKNOWN
```

Jarvis dit alors :

> « Je n'ai pas pu terminer : Gmail n'a pas répondu. Le brouillon n'est pas
> confirmé comme créé. »

Et surtout — **il ne réessaie pas**. Au rejeu, il trouve la ligne `EXECUTING`
sans observation, interroge le fournisseur si celui-ci sait répondre, et ne
tranche que sur ce qu'il constate.

### Ce que le contrat interdit, formulé en une ligne

> Aucune étape ne peut emprunter la confiance de la précédente.

Une `INTERPRETATION` ne devient jamais une `EVIDENCE`. Une `ACTION` ne devient
jamais une `OBSERVATION`. C'est le même principe qu'ADR-024 appliqué au temps
plutôt qu'à l'origine.

---

## 2. Ce qui existe déjà, ce qui manque

Distinguer les deux évite de reconstruire ce qui est là, et de croire acquis ce
qui ne l'est pas.

| Élément du contrat | État | Où |
|---|---|---|
| Provenance par valeur (`SOURCE`) | ✅ | `types/domain.ts`, 6 provenances |
| Distinction outil-dit / j'ai-constaté | ✅ | `verification/engine.ts` — `PROVIDER_PROOF` vs `READ_BACK` |
| `CONFIRMED` exige une preuve | ✅ | `confirmed()`, fabrique unique |
| Décision séparée de l'exécution | ✅ | Policy Gate, `01 §ADR-005` |
| Journal chaîné de ce qui a été tenté | ✅ | Event Ledger |
| **`PARTIAL`** | ❌ | *aucune façon d'exprimer « 3 sur 5 »* |
| **Identité de l'observation** | ❌ | on sait qu'une relecture a eu lieu, pas laquelle |
| **`INTERPRETATION` explicite** | ❌ | l'Intent Engine va de la phrase à l'outil |
| **Enregistrement avant exécution** | ✅ | **ADR-027** — implémenté, 7 crashs éprouvés |
| **Vérification de tentative** | ✅ | `attemptVerification` + `verifyAttempt` |
| **États de connaissance** | ◐ | trois axes définis (`domain.ts`) ; seul `coverage` porte des données réelles |

---

## 3. Mémoire bitemporelle — forme de la migration

Ratifiée en ADR-026. **Non écrite** : gel.

```sql
-- Forme cible. Les noms sont indicatifs, la structure ne l'est pas.
ALTER TABLE memories
  ADD COLUMN subject        TEXT,        -- « projet mariage »
  ADD COLUMN predicate      TEXT,        -- « date »
  ADD COLUMN valid_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN valid_until    TIMESTAMPTZ,          -- NULL = toujours vrai
  ADD COLUMN superseded_at  TIMESTAMPTZ;          -- NULL = jamais remplacé
-- `created_at` tient déjà lieu de `recorded_at`.

CREATE VIEW memories_current AS
  SELECT * FROM memories
   WHERE valid_until IS NULL AND superseded_at IS NULL AND state = 'ACTIVE';
```

**La vue n'est pas un confort, c'est la condition de tenabilité.** Sans elle,
chaque `SELECT` du dépôt devra porter deux conditions temporelles pendant des
années, et l'une sera oubliée.

Tests exigés avant de considérer la migration acquise :

1. deux valeurs successives du même `(subject, predicate)` → la première est
   close, aucune n'est supprimée ;
2. « que savais-tu le 10 juin ? » rend l'ancienne valeur ;
3. « que sais-tu ? » rend uniquement la nouvelle ;
4. la descente de migration restitue exactement l'état antérieur ;
5. `memories_current` et une requête manuelle équivalente donnent le même
   résultat sur 1 000 lignes générées ;
6. une mémoire close reste lisible par `/audit` — clore n'est pas effacer.

---

## 4. Matrice adversariale

**Ce tableau n'est pas une intention.** La colonne « vérifié » dit l'état réel
au commit `b25e58a`, test à l'appui. `UNVERIFIED` signifie : *le comportement
attendu est spécifié, rien ne le prouve encore.*

| # | Situation | Comportement exigé | Vérifié | Preuve |
|---|---|---|---|---|
| A1 | Base coupée | refus d'agir, message explicite | ✅ | `redteam/failure-modes` |
| A2 | Base coupée puis revenue | reprise seule + `DATABASE_RECOVERED` | ✅ | exécution réelle, `docs/11 §16` |
| A3 | Connexion inactive tuée | le processus survit | ✅ | `redteam/db-resilience` |
| A4 | Redémarrage du serveur | état récupéré depuis la base | ◐ | la base porte tout l'état ; non testé de bout en bout |
| B1 | Outil indisponible | aucun succès déclaré | ✅ | `fault_error` |
| B2 | Outil qui lève | `Result` typé + trace au journal | ✅ | `redteam/failure-modes` |
| B3 | Retour d'outil mensonger (200, rien fait) | `FAILED` — la parole de l'outil n'est pas une preuve | ✅ | `fault_lies` |
| B4 | Outil externe malveillant | isolé derrière le contrat | ◐ | isolation des fournisseurs testée ; aucun outil externe n'existe |
| C1 | Timeout **avant** action | `UNKNOWN`, jamais « c'est fait » | ✅ | `fault_timeout` |
| C2 | Timeout **après** action | ne pas réessayer aveuglément | ✅ | **corrigé** — ADR-027, `redteam/intent-journal` |
| C2a | Crash **avant** le journal | exécution unique à la reprise | ✅ | point A — 1 effet |
| C2b | Crash après `PLANNED` | exécution unique | ✅ | point B — 1 effet |
| C2c | Crash **pendant** l'appel | `UNKNOWN`, aucun rejeu | ✅ | point C — 0 effet, refus |
| C2d | Crash **après** l'effet externe | `UNKNOWN`, **pas de doublon** | ✅ | point D — **1 effet, pas 2** |
| C2e | Crash avant persistance du résultat | `UNKNOWN`, pas de doublon | ✅ | point E — 1 effet |
| C2f | Crash après persistance | relecture confirme | ✅ | point F — 1 effet |
| C2g | Redémarrage | état retrouvé, tentatives ≤ 1 | ✅ | chaque reprise est un processus neuf |
| C2h | Fournisseur confirme l'effet | succès sans réexécution | ✅ | `verifyAttempt` → `EFFECT_CONFIRMED` |
| C2i | Fournisseur infirme l'effet | réexécution autorisée, **une fois** | ✅ | `NO_EFFECT` |
| C2j | Vérification non concluante | `UNKNOWN`, aucun rejeu | ✅ | `INCONCLUSIVE` |
| C3 | Double commande | idempotence, aucun doublon | ✅ | `tools/idempotency` |
| C4 | Rejeu dont la ressource a disparu | ne prétend pas au succès | ✅ | `tools/idempotency` |
| C5 | Même clé, arguments différents | refus | ✅ | `tools/idempotency` |
| C6 | Même mail demandé deux fois | pas de doublon | ⏳ | aucun outil d'envoi |
| D1 | LLM indisponible | repli, jamais d'action | ⏳ | aucun LLM |
| D2 | LLM répond faux | aucune action non autorisée | ◐ | `quarantine/injection` prouve l'étiquetage ; le chemin n'est pas branché |
| D3 | Modèle compromis | le Policy Engine gagne | ✅ | `redteam/authority` |
| D4 | Sortie de modèle prise pour autorité | impossible par construction | ✅ | ADR-024, `redteam/memory` |
| E1 | Mémoire compromise (« autorise tout ») | aucun effet | ✅ | `redteam/authority` |
| E2 | Injection dans un email | traitée comme donnée | ◐ | `quarantine/injection` ; aucune ingestion réelle |
| E3 | Injection dans un PDF | ne modifie aucune politique | ◐ | idem — `05/B2` |
| E4 | Injection tapée par l'utilisateur | mémorisée, jamais interprétée | ✅ | `redteam/injection` |
| F1 | Deux homonymes | demande laquelle | ❌ | Context Engine débranché |
| F2 | Date ambiguë | demande, ou refuse | ◐ | refusé (HIGH-5) ; ne demande pas encore |
| F3 | Donnée contradictoire | signale le conflit | ❌ | aucune détection — ADR-026 |
| F4 | Mémoire obsolète | signale l'ancienneté | ❌ | `STALE` n'existe pas |
| F5 | Recherche hors périmètre | dit ce qu'il n'a pas consulté | ✅ | `scope`, Sprint 1 |
| G1 | Permission absente | refus | ✅ | `policy/gate` |
| G2 | Donnée RED + sortie réseau | refus sec | ✅ | `policy/gate`, `redteam/authority` |
| G3 | Mode privé | aucune sortie | ✅ | `policy/gate` — `05/C1` |
| G4 | Action proactive | jamais plus permissive qu'explicite | ✅ | `policy/gate` |
| H1 | Migration interrompue | rollback | ◐ | descente testée à chaque suite ; interruption **au milieu** non testée |
| H2 | Mise à jour défectueuse | rollback automatique | ⏳ | aucun Update Engine |

**Décompte au commit courant : 30 vérifiés · 8 partiels · 3 défauts ouverts ·
3 impossibles à tester aujourd'hui.**

Les trois `❌` restants sont `F3`, `F4` (mémoire sans contradiction ni
fraîcheur) et `F1` (désambiguïsation). Tous trois relèvent de Foundation 3.
`C2` — le plus grave — est fermé, avec dix lignes de preuve.

> **Sur les 345 tests.** Le brief a raison de ne pas leur accorder de valeur en
> soi : une suite de 10 000 tests peut éprouver le mauvais système. Ce tableau
> est la seule métrique qui compte — **la couverture des invariants dangereux**,
> ligne par ligne, avec le nom du test en face. Un chiffre global n'aurait
> jamais montré `C2`.

---

## 5. Journal d'intention — **implémenté** (ADR-027)

Le seul chantier pour lequel le gel a été levé. Il ferme `C2`.

### Résultats des sept scénarios de crash

Chaque ligne : un processus enfant réellement tué au point indiqué, puis un
**second processus** qui rejoue la même clé d'opération. Ce n'est pas une
simulation de redémarrage — c'en est un.

| Point | Où le processus meurt | État retrouvé | Effets externes | Réexécution |
|---|---|---|---|---|
| **A** | avant l'écriture du journal | `SUCCEEDED` | **1** | oui — légitime, rien n'avait eu lieu |
| **B** | après `PLANNED` | `SUCCEEDED` | **1** | oui — aucun appel n'était parti |
| **C** | pendant l'appel, avant l'effet | `UNKNOWN` | **0** | **non** |
| **D** | après l'effet externe | `UNKNOWN` | **1** | **non** — le doublon est évité |
| **E** | avant la persistance du résultat | `UNKNOWN` | **1** | **non** |
| **F** | après la persistance | `SUCCEEDED` | **1** | non — la relecture confirme |
| **G** | redémarrage | — | ≤ 1 | compteur de tentatives ≤ 1 partout |

**Le cas C mérite d'être lu attentivement.** L'effet n'avait en réalité *pas*
eu lieu, et Jarvis refuse quand même de rejouer. C'est le coût assumé du
modèle, et il est du bon côté : le doute penche toujours vers ce qui ne produit
pas de doublon.

### Analyse initiale, conservée pour mémoire

| Rubrique | |
|---|---|
| **Avantages** | Ferme la double exécution avant qu'un outil externe n'existe. Rend `ACTION` et `OBSERVATION` distinctes dans les données, pas seulement dans le discours. Coût de mise en œuvre faible : le Gateway sait déjà relire l'état réel. |
| **Inconvénients** | Une écriture supplémentaire par opération. Des lignes `ATTEMPTED` orphelines s'accumulent après un crash : il faut une purge, donc un processus de plus. |
| **Dépendances** | Aucune nouvelle. `tool_operations` existe. |
| **Risques** | Une ligne `ATTEMPTED` sans observation est **ambiguë par nature** : le système ne peut pas savoir si l'action a eu lieu. Le risque est qu'un futur développeur la traite comme un échec pour simplifier — et réexécute. À verrouiller par test. |
| **Coût** | ~1 ms par opération (une insertion locale). 0 €. |
| **Remplaçable par** | Rien de standard. C'est un write-ahead log applicatif, motif classique — la logique tient en trente lignes. Aucune dépendance ne se justifierait. |
| **Vérification** | Tuer le processus **entre** l'enregistrement et l'exécution, puis rejouer la même clé : aucune réexécution, statut `UNKNOWN` si la relecture ne tranche pas. |
| **Tests nécessaires** | (1) rejeu après crash simulé → pas de doublon ; (2) `ATTEMPTED` + relecture positive → `CONFIRMED` ; (3) `ATTEMPTED` + relecture négative → `FAILED` ; (4) `ATTEMPTED` + relecture impossible → `UNKNOWN` ; (5) purge des orphelines ne touche jamais une ligne observée. |

---

## 6. Chantier — Update Engine

`docs/07` spécifie déjà le pipeline complet — TUF, Sigstore, LAB, canary,
rollback, backups, mode dégradé. **Ce chantier n'est donc pas une spécification
nouvelle : c'est un audit de l'existant contre le brief.** Trois écarts.

### Écart 1 — « immutable » est plus fort que « validation humaine »

`docs/07 §3` range les politiques de sécurité parmi les changements exigeant
« une validation étagée **et** une décision humaine explicite ». Le brief exige
autre chose :

> une mise à jour ne doit jamais **pouvoir** modifier le Policy Engine depuis
> l'extérieur.

La différence est structurelle. Une approbation peut être donnée par erreur, par
fatigue, ou par un opérateur trompé. Une **impossibilité** ne le peut pas.

Correction proposée : les politiques dures sortent du périmètre de l'artefact de
mise à jour. Le canal distant ne les transporte pas — il n'y a donc rien à
approuver. Leur modification passe par un chemin distinct, exigeant une action
locale sur la machine.

### Écart 2 — le problème d'amorçage

Si l'Update Engine peut se mettre à jour par le canal qu'il contrôle, une mise à
jour malveillante de l'Update Engine désarme toutes les vérifications
suivantes — y compris celles qui l'auraient détectée. `docs/07` ne traite pas ce
cas.

Correction proposée : l'Update Engine est le seul composant qui ne se met pas à
jour automatiquement.

### Écart 3 — le LAB doit rejouer la matrice, pas un échantillon

`docs/07 §5` décrit le shadow testing. Il ne dit pas **quoi** rejouer. La
réponse est le §4 de ce document : une version candidate ne passe que si elle
tient **toutes** les lignes vérifiées, sans exception ni régression.

| Rubrique | |
|---|---|
| **Avantages** | Jarvis évolue sans que son propriétaire devienne administrateur système. Un rollback automatique vaut mieux qu'une vigilance humaine continue. |
| **Inconvénients** | C'est le sous-système le plus complexe du projet, et celui dont l'échec est le plus silencieux. Il double la surface de code à maintenir. |
| **Dépendances** | TUF, Sigstore, un bac à sable d'exécution, une base LAB, des instantanés restaurables. **Quatre dépendances lourdes** — aucune n'existe aujourd'hui. |
| **Risques** | Le plus grave : un Update Engine bogué qui refuse *toutes* les mises à jour, y compris les correctifs de sécurité. Le second : une confiance excessive dans le canary, qui ne détecte que ce qu'il mesure. |
| **Coût** | 0 € récurrent (TUF et Sigstore sont libres). Coût réel : le temps de construction et un LAB qui double le stockage. |
| **Remplaçable par** | La mise à jour manuelle — c'est-à-dire l'état actuel. Ce n'est pas absurde tant qu'il y a un seul utilisateur qui sait lancer `git pull`. |
| **Vérification** | Publier une mise à jour volontairement cassée et vérifier qu'elle est bloquée avant la production. Publier une mise à jour signée par une clé révoquée et vérifier le refus. |
| **Tests nécessaires** | Les 34 lignes du §4 rejouées en LAB ; une mise à jour non signée refusée ; une clé révoquée refusée ; un rollback déclenché par régression de métrique ; **une tentative de modification de politique par le canal distant, refusée par absence de chemin**. |

> **Recommandation de séquencement.** Ce chantier ne devrait pas commencer avant
> que la matrice du §4 soit majoritairement verte. Un Update Engine dont le LAB
> rejoue une matrice trouée valide des versions contre des critères incomplets —
> il donnerait une garantie **plus dangereuse que son absence**.

---

## 7. Chantier — Routage coût-conscient

| Rubrique | |
|---|---|
| **Avantages** | Conserve la propriété « 0 € » mesurée en `docs/11 §10` au lieu de la perdre au premier modèle. Rend le coût explicite et gouvernable plutôt que subi. |
| **Inconvénients** | Un routeur est un point de décision de plus, donc un point de défaillance et un point d'attaque de plus. |
| **Dépendances** | Au moins un fournisseur local et un fournisseur cloud — **aucun n'existe** (`docs/11 §2`). Ce chantier ne peut pas commencer avant eux. |
| **Risques** | Le risque principal est traité ci-dessous : que le coût décide de la confidentialité. |
| **Coût** | Le routeur lui-même : 0 €. Son objet est de borner le reste. |
| **Remplaçable par** | Un choix de modèle en configuration, sans routage. Suffisant tant qu'il n'y a qu'un modèle. |
| **Vérification** | Rejouer un corpus de requêtes réelles et mesurer la répartition par palier ainsi que le coût total. Le banc `ops/bench` existe pour ça. |
| **Tests nécessaires** | (1) une donnée RED n'atteint jamais un palier cloud, quel que soit le coût ; (2) le budget épuisé bloque, sans dégrader silencieusement ; (3) une boucle de modèle est arrêtée par le plafond par opération ; (4) le palier déterministe reste choisi pour « ajoute du café à ma liste ». |

### La correction que je propose au diagramme

Le brief décrit :

```text
DÉTERMINISTE → LOCAL → CLOUD BON MARCHÉ → PREMIUM
```

**Pris littéralement, cet enchaînement laisse le coût décider de la
confidentialité.** Si le modèle local échoue sur un document médical, la
séquence escalade vers le cloud — non parce que c'est autorisé, mais parce que
c'est l'étape suivante. La classification de la donnée n'apparaît nulle part.

Ordre proposé, **confidentialité d'abord** :

```text
requête
   ↓
CLASSIFICATION            RED / ORANGE / GREEN         ← Data Firewall
   ↓
PALIERS ÉLIGIBLES         RED → {déterministe, local} exclusivement
   ↓                      ORANGE → + cloud si autorisé par requête
COMPLEXITÉ                le plus petit palier ÉLIGIBLE qui suffit
   ↓
BUDGET                    jour / mois / plafond par opération
   ↓
EXÉCUTION
```

La différence tient en une phrase : **un palier non éligible n'est pas
« coûteux », il n'existe pas.** L'escalade ne peut jamais franchir la barrière
de confidentialité, parce qu'elle ne voit pas ce qu'il y a derrière.

Le brief a par ailleurs raison sur un point que je souligne : *« le modèle
premium ne devrait jamais décider seul du niveau de dépense »*. C'est
exactement la forme du Policy Gate — **le modèle propose un palier, le Budget
Engine décide** — et cela doit être le même code, pas un second mécanisme qui
lui ressemble.

### Sur les « 80 % en local »

Le brief refuse de partir de ce chiffre comme hypothèse. **C'est le bon
réflexe**, et le dépôt le confirme déjà : la matrice `docs/11 §8` montre que
**6 actions sur 30 ne nécessitent aucun modèle du tout**. Le palier
déterministe n'est pas un repli, c'est le meilleur choix technique sur ces
phrases — 7,9 ms de latence médiane, 0 €, aucune variabilité.

La répartition réelle se mesurera avec `ops/bench` sur un corpus de requêtes
vécues. Pas avant.

---

## 8. Ce que ce sprint n'a délibérément pas fait

- Aucun code fonctionnel. Le gel tient.
- Aucun Knowledge Graph. `docs/11` et le brief convergent : PostgreSQL,
  `pg_trgm` et la recherche plein texte suffisent tant que la résolution de
  contexte n'a pas fait ses preuves. Le graphe doit être une représentation
  **émergente**, jamais le produit.
- Aucun outil supplémentaire, aucune voix, aucune proactivité.

## 9. Les trois décisions — arbitrées le 10 août 2026

| | Décision | Issue |
|---|---|---|
| 1 | Décomposer les états de connaissance en trois axes | ✅ **validée** — `KnowledgeVerdict` / `KnowledgeQuality` / `KnowledgeScope` |
| 2 | Retirer `status` et `superseded_by` du modèle mémoire | ✅ **validée** — dérivés, jamais stockés |
| 3 | Implémenter le journal d'intention | ✅ **validée, P0** — gel levé pour cette seule correction |

L'axe 2 (`VERIFIED / UNVERIFIED / STALE`) a été retenu dans la forme proposée
par le brief plutôt que dans la mienne : trois valeurs exclusives valent mieux
qu'un jeu de qualificatifs cumulables, parce qu'une information ne peut pas être
à la fois fraîchement vérifiée et périmée.

---

## 10. Ce qui reste impossible à garantir aujourd'hui

Cette section existe pour qu'aucune des lignes ci-dessus ne soit lue comme plus
forte qu'elle ne l'est.

**Les cinq outils du noyau ne savent pas vérifier une tentative.** Ils déclarent
`NONE`, donc un crash en cours d'appel les laisse en `UNKNOWN` — sans jamais
produire de doublon, mais sans jamais trancher non plus. Les rendre vérifiables
suppose d'écrire la clé d'opération dans la ressource créée. **Chantier nommé,
non fait.**

**`PARTIAL` n'existe toujours pas.** Aucune façon d'exprimer « 3 destinataires
sur 5 ». Doit exister avant le premier outil capable de réussir à moitié.

**L'identité de l'observation reste absente.** On sait qu'une relecture a eu
lieu, pas contre quelle source ni avec quel identifiant de preuve. Une
observation sans identité n'est pas rejouable.

**Les axes de connaissance ne sont pas alimentés.** `KnowledgeVerdict` et
`KnowledgeScope` portent des valeurs réelles pour `memory_search` ;
`KnowledgeQuality` vaut toujours `UNVERIFIED`, faute de fraîcheur et de
relecture — deux notions qui attendent la mémoire bitemporelle.

**La bitemporalité n'est pas migrée.** Le gel n'a été levé que pour ADR-027.

**Le crash entre l'écriture `EXECUTING` et l'appel produit un faux `UNKNOWN`.**
Une action qui n'a jamais eu lieu sera rapportée comme incertaine. C'est le
biais assumé du modèle, et il ne peut pas être éliminé : il faudrait une
transaction distribuée avec le fournisseur, ce qu'aucune API réelle n'offre.

**Rien de tout cela n'a été éprouvé sous charge**, ni avec un fournisseur
distant réel. Les sept crashs tournent contre PostgreSQL local, où le temps de
vol est de l'ordre de la milliseconde. Un fournisseur à 800 ms de latence
élargit chaque fenêtre — sans changer la logique, mais en rendant les états
transitoires beaucoup plus fréquents.
