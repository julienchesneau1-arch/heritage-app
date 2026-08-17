# 26 — REGISTRE DES ZONES D'OMBRE

**Balayage systématique.** Objectif : qu'il ne reste **aucune incertitude non
énumérée**.

Il faut dire tout de suite ce que ce document ne prétend pas être. Certaines
incertitudes sont **irréductibles** — aucune mesure, aucun code, aucun budget
ne les fera disparaître. Prétendre les supprimer serait le mensonge le plus
coûteux du dépôt.

> Une zone d'ombre **nommée et bornée** n'est plus une zone d'ombre.
> C'est une limite connue. Le danger n'est pas l'inconnu — c'est **l'inconnu
> qu'on ignore être inconnu**.

Trois classes, et une seule est acceptable en silence :

| Classe | Sens |
|---|---|
| **SUPPRIMÉE** | mesurée, corrigée, gardée par un invariant |
| **IRRÉDUCTIBLE** | démontrée impossible à lever ; doit rester écrite |
| **DIFFÉRÉE** | levable, non levée ; avec sa condition de réouverture |

---

## 1. Méthode

Quatre balayages, dans cet ordre :

1. **Couverture** — quel code n'est jamais exécuté ?
2. **Motif récurrent** — le même défaut a frappé quatre fois ; où frappe-t-il
   une cinquième ?
3. **Affirmations non mesurées** — quels « NON TESTABLE » sont des
   suppositions déguisées ?
4. **Énumération** — tout le reste, classé.

---

## 2. SUPPRIMÉES — mesurées et fermées pendant ce balayage

### 2.1 Les échéances persistées étaient frappées par l'horloge du processus

**Trouvé par le balayage §2 (motif récurrent).** Ce n'est pas le motif
d'ADR-036 — c'est son **voisin**, et il est resté invisible pour cette raison :

```text
ADR-036   l'observateur RECALCULE une échéance qu'il n'a pas fixée
ici       l'échéance est bien fixée UNE fois — mais par l'horloge du
          PROCESSUS, puis comparée à celle de LA BASE
```

`docs/23 §4` avait établi I14 : *le verdict de bail est indépendant de
l'horloge du processus*. **Elle ne valait que pour le bail.** Deux autres
tables portaient des échéances, et personne n'avait regardé.

**Mesuré, avant correction :**

| Table | TTL déclaré | Avec une dérive applicative de +1 an | Conséquence |
|---|---|---|---|
| `action_snapshots` | 7 jours | **371 jours** | rétention d'un état antérieur `ORANGE` (`docs/14`) |
| `memory_candidates` | 30 jours | **394 jours** | proposition jamais périmée |

Et en dérive **inverse**, l'instantané naissait **déjà expiré** : l'annulation
devenait silencieusement impossible — le genre de défaut qu'on ne découvre
qu'au moment où on en a besoin.

**Corrigé** (ADR-037) : `clock_timestamp() + ($n || ' days')::interval`.
**Gardé** par I19. **Contrôlé négativement** : le détecteur voit le défaut
exact et ignore `Date.now()` là où il mesure une durée.

### 2.2 « Deux machines » était classé NON TESTABLE — à tort

`docs/24` et `docs/25` l'affirmaient. C'était une **supposition**, pas une
mesure : `pg_createcluster` est disponible et la place disque ne manque pas.

Mais monter une seconde instance n'aurait **rien prouvé de plus**, et c'est le
vrai résultat. « Deux machines » se décompose :

| Différence | État |
|---|---|
| pool de connexions distinct | déjà couvert (`multiprocess.test.ts`) |
| mémoire distincte | déjà couvert |
| ordonnancement distinct | déjà couvert |
| **horloges divergentes** | **c'était la seule qui manquait** |

Fermée : quatre processus, décalés de **+1 an / −1 an / +6 mois / 0**, en
concurrence sur la même clé. `external_effect_count ≤ 1`, `attempts ≤ 1`,
aucune erreur inattendue.

> Deux ans de divergence entre les hôtes ne déplacent aucune décision de
> sûreté — parce qu'aucune n'est prise par l'horloge d'un appelant.

### 2.3 Un test d'intégrité laissait la chaîne ROMPUE pour toute la suite

**Trouvé en ajoutant un fichier de test, pas en cherchant.** Le défaut était
latent depuis toujours, masqué par l'ordre d'exécution.

`ledger-chain.test.ts` corrompt **délibérément** le journal — triggers
désactivés, ligne réécrite — pour prouver que le chaînage par hash détecte
l'altération quand les deux premières barrières tombent. C'est un bon test.
Deux de ses cas ne remettaient pourtant pas l'état :

| Cas | Ce qui restait après |
|---|---|
| modification de contenu | `status = 'FAILED'` sur un maillon — chaîne rompue |
| **suppression de maillon** | **le maillon manquant, définitivement** |

Le second se « réparait » incidemment parce que le test suivant, dans le même
fichier, remettait le statut du premier. **Une dépendance d'ordre entre deux
`it()` n'est pas un mécanisme** — c'est une coïncidence qu'on remarque le jour
où elle cesse.

Et le journal est **partagé par toute la suite** : quatre fichiers y appellent
`verifyChain()`, plus `system_status` qui le fait en production.

**Mesuré :** `intent/flow.test.ts` — « la chaîne d'audit reste intacte après
une session complète » — **vert seul, rouge en suite complète**. Ajouter
`web-search.test.ts` a suffi à déplacer l'ordonnancement et à révéler le
défaut.

> L'assertion avait raison. La tentation était de l'affaiblir — elle est la
> seule vérification d'intégrité de bout en bout du dépôt.

**Corrigé** sur les deux fronts :

- le maillon supprimé est **sauvegardé puis réinséré** (`CREATE TABLE … AS
  SELECT *`, pour ne pas énumérer des colonnes qui se périmeraient à la
  prochaine migration — ce qui est exactement arrivé aux champs d'égression) ;
  le statut altéré est restauré dans son propre `finally` ;
- la fenêtre de corruption est protégée par `withLedgerExclusive`, un verrou
  consultatif **côté tests uniquement** : on ne peut pas vérifier globalement
  l'intégrité d'un objet pendant qu'on le corrompt volontairement ailleurs.

**Sabotage :** retirer la réinsertion, puis la restauration du statut — chaque
retrait fait rougir le test concerné. Les deux sabotages reproduisent l'état
antérieur du dépôt.

### 2.4 Un scénario CRITIQUE compté couvert par collision de chaîne

**Trouvé en contestant ma propre recommandation, pas en cherchant un défaut.**

Avant d'écrire le Model Router, j'ai vérifié que « référencé » voulait dire
quelque chose. Mesure sur les trente scénarios de `docs/05` : **16 cités dans du
code**, **11 en commentaire seul**.

Première conclusion, et elle était **fausse** : les commentaires ne sont pas un
défaut. `A3`, `A5`, `A10`, `B6` sont attachés à des fichiers entièrement
consacrés à leur propriété — la citation en tête est une forme légitime.

En resserrant sur un rattachement non ambigu (`05/C2`, `**C2**`, titre de test),
**un seul scénario tombe** : `C2` — **Arrêt d'urgence**, marqué `CRITIQUE`. Le
seul « C2 » du dépôt vivait dans « matrice adversariale **ligne C2** », la ligne
d'un tout autre tableau. Aucune capacité d'arrêt d'urgence n'existait.

> Un identifiant de deux caractères est trop court pour valoir preuve.

Et le premier filtre strict était **trop strict** : il perdait `B3`, cité dans
« scénarios 05/B1, B2, B3, B10 » où seul B1 porte le préfixe. Un filtre qui
resserre trop invente des trous et fait perdre confiance dans les vrais.

**Corrigé** : reconnaissance rattachée (ADR-057), et **C2 écrit** plutôt que
déclaré bloqué — l'arrêt d'urgence ne dépend d'aucun fournisseur, donc rien ne
justifiait de le différer.

**Le chiffre publié n'a pas bougé** — 27/30 avant, 27/30 après. Sa vérité, si.

### 2.5 Quatre gardes de sécurité qu'aucun test n'éprouvait

**Trouvé en transformant une anecdote en hypothèse.** ADR-057 s'était terminée
sur un sabotage qui n'avait rien fait rougir. Plutôt que de corriger et passer,
on en a fait une question : *combien d'autres ?*

Méthode : prendre les branches non couvertes des modules de sécurité, et
**saboter chacune**. Pas viser un pourcentage — viser une réponse.

```text
ledger.ts    validation à la frontière retirée   → 89 tests verts
vault.ts     inspection rendant le secret NU     → 72 tests verts
halt.ts      levée sans note acceptée            → 16 tests verts
event.ts     empreinte sans repli                → 89 tests verts
```

`Secret[inspect.custom]` est la plus grave : c'est la garde anti-fuite de la
Phase 0, celle que Node appelle pour `console.log(secret)`. `toString()` et
`toJSON()` étaient éprouvés — la concaténation et la sérialisation. **Pas
l'affichage**, qui est le plus fréquent des trois.

Et la validation du journal contredisait ADR-016, qui en fait une obligation.

**Corrigé** : `tests/security/refus-eprouves.test.ts`, 13 tests. Chaque
sabotage rejoué fait rougir exactement le test visé.

**Restent NON testées, et déclarées :** deux gardes sur états impossibles
(`INSERT … RETURNING` sans ligne, arrêt inscrit sans identifiant). Les tester
demanderait de fabriquer un monde qui n'existe pas ; les supprimer
transformerait un refus nommé en plantage plus loin. On les garde et on dit
pourquoi (ADR-059).

### 2.6 Un test qui ne passait que 23 heures sur 24

**Trouvé par accident, pendant le balayage ci-dessus.**

`reminders.test.ts` plaçait un rappel « dans une heure » et attendait de le voir
dans le briefing. Or le briefing borne à `date_trunc('day', clock_timestamp())
+ 1 day`. **Entre 23 h et minuit UTC, « dans une heure » tombe demain.**

Le produit avait raison : un rappel de demain n'est pas dans le briefing
d'aujourd'hui. C'est le TEST qui supposait que « dans une heure » restait
aujourd'hui.

> Il aurait été classé « flaky » par quiconque l'aurait croisé une fois — et
> c'est exactement ainsi qu'un défaut d'horloge survit.

**Corrigé** par la doctrine du dépôt (ADR-036/037) : la fenêtre est calculée par
la BASE, jamais devinée par le processus. Le test demande à la base où finit la
journée et place le rappel à l'intérieur.

Vérification la plus forte possible : le correctif a été validé **à 23 h 12
UTC**, dans la fenêtre précise où le test échouait.

### 2.7 Deux fichiers à 0 % de couverture — faux positif

`src/core/policy/evaluator.ts` et `src/providers/contract.ts` : **types purs**,
zéro code émis. Vérifié, pas supposé.

---

## 3. Ce que le balayage a trouvé sur MOI, et pas sur le code

Honnêteté sur la méthode, parce qu'elle change la conclusion.

J'ai construit un invariant `I20 — aucun module orphelin`, l'ai branché, et il
a signalé `quarantine/processor.ts` et `observability/logger.ts`.

**Le dépôt le savait déjà.** `tests/redteam/wiring.test.ts` fait une analyse
d'**atteignabilité transitive depuis les points d'entrée** — strictement plus
forte qu'un contrôle d'importation — et maintient un inventaire **figé et
justifié** de **cinq** modules orphelins. Le mien n'en voyait que deux.

I20 a été **retiré**. La leçon vaut d'être écrite :

> Une zone d'ombre *pour moi* n'est pas une zone d'ombre *pour le dépôt*.
> Avant d'ajouter une garde, vérifier qu'il n'en existe pas déjà une — sinon
> on ajoute une garantie plus faible qui donne l'illusion d'en ajouter une.

---

## 4. DIFFÉRÉES — levables, non levées, avec leur condition

### 4.1 Cinq modules de logique hors circuit

Inventoriés et figés par `wiring.test.ts`. Ils sont **implémentés et testés,
jamais atteints par le produit**.

| Module | Ce qui manque | Condition de réouverture |
|---|---|---|
| ~~`quarantine/processor.ts`~~ | **LEVÉE (ADR-055)** — `web_search` est la première ingestion du dépôt, et le Tool Gateway appelle `sealExternal` | — |
| `context/packet.ts` · `resolver.ts` | la boucle réelle ne résout pas les entités | `QUICKSTART` promet la levée d'ambiguïté — dette visible |
| `observability/logger.ts` | aucun appelant | exigences de log de `03 §9` non satisfaites |
| `cost/gate.ts` | aucun fournisseur cloud à facturer | dès le premier fournisseur payant branché |
| `tools/outcome.ts` | le Gateway n'a pas de notion de cible | dès qu'un outil multi-cibles existe |

**Ce compteur a une histoire, et elle vaut d'être lue :**

```text
5   état initial
6   + cost/gate.ts (ADR-040) — écrit avant d'avoir un appelant, délibérément
7   + privacy/classify.ts (F1) — classification branchée à rien, délibérément
6   − privacy/classify.ts (F2) — le Policy Gate l'appelle
5   − quarantine/processor.ts (ADR-055) — web_search ingère, le Gateway scelle
```

> **Le titre a dit « Cinq » pendant toute la période où il valait six.**
> `wiring.test.ts` l'affirmait pourtant (`toHaveLength(6)`) ; ce document non.
> Le test avait raison contre le registre — c'est l'ordre qu'on veut, mais
> l'écart aurait dû être rattrapé le jour même. Il revient à cinq pour une
> raison entièrement différente de celle qui l'y avait mis.

**Conséquence à énoncer sans détour :** `PARTIAL` est spécifié (`docs/19`),
implémenté et testé — et **aucune opération réelle ne peut aujourd'hui le
produire**.

La deuxième moitié de cette phrase disait : « La séparation
Privileged/Quarantined (ADR-004), défense principale contre T1, est hors circuit
faute d'ingestion externe. » **Ce n'est plus vrai depuis ADR-055.** Elle est
appelée par le Tool Gateway sur toute sortie déclarée `EXTERNAL_UNTRUSTED`, et
`web_search` en produit. Ce qui reste vrai : **un seul outil l'emprunte**, et
la protection ne vaut donc que pour ce qu'il rapporte.

Ce n'est pas un défaut : c'est une capacité **déclarée non disponible**. Elle
serait un défaut le jour où quelqu'un croirait qu'elle protège.

### 4.2 Le CLI n'est exercé par aucun test

`src/apps/cli/main.ts` — **0 % de couverture, 240 lignes**. C'est la surface
produit réelle. Aucun test ne la traverse.

Ce que ça ne remet PAS en cause : le CLI n'exécute aucune action en propre, il
appelle l'Assistant — donc le même Policy Gate, le même Memory Guard, le même
journal, tous couverts. Le risque porte sur l'**ergonomie et le rendu**, pas
sur la sûreté.

**Condition :** à couvrir avant toute promesse de disponibilité produit.

### 4.3 Couverture globale — 83,89 % des lignes

> ⚠ **MESURE DATÉE, ET C'EST UN CHOIX ASSUMÉ.** Contrairement aux autres
> chiffres du dépôt, celui-ci ne peut pas être lié mécaniquement (ADR-058) :
> le vérifier exige d'exécuter la suite entière sous instrumentation, ce
> qu'aucun test ne peut faire sur lui-même. Il est donc traité comme les
> rapports `docs/09` et `docs/11` — **un constat à une date**, à remesurer par
> `pnpm test:coverage`, jamais à recopier.
>
> Relevé après ADR-057 (arrêt d'urgence). Le précédent disait 83,28 %, celui
> d'avant 80,97 %.

| | Taux | Fraction |
|---|---|---|
| Lignes · instructions | **83,89 %** | 5397 / 6433 |
| Branches | **79,11 %** | 1034 / 1307 |
| Fonctions | **91,54 %** | 249 / 272 |

Zones sous 80 %, hors points d'entrée :

| Fichier | Lignes | Ce que ça signifie |
|---|---|---|
| `providers/contract.ts` · `policy/evaluator.ts` | 0 % | **types purs** — il n'y a rien à exécuter (§2.7) |
| `tools/outcome.ts` | 55 % | orphelin déclaré (§4.1) |
| `tools/identity.ts` | 65 % | `sameOperation` / `isSameOperation` jamais appelés en production |
| `apps/runtime.ts` | 62 % | assemblage ; le CLI et la passerelle ne sont pas traversés (§4.2) |
| `tools/files.ts` | 74 % | chemins de refus de `readWithinRoot` |
| `config/load.ts` | 75 % | chemins d'erreur de configuration |
| `providers/policy/cedar.ts` | 75 % | chemins d'échec du chargeur |
| `tools/reminders.ts` | 77 % | branches d'échéance non exercées |

**Le taux de BRANCHES reste le seul qui mérite de l'inquiétude** : 79,11 %
contre 91,54 % de fonctions. L'écart dit ce qu'on attend de lui — les fonctions
sont appelées, mais leurs **chemins de refus** le sont moins que leurs chemins
nominaux. Or dans ce dépôt, le chemin de refus *est* la fonctionnalité.

`safety/halt.ts` en est l'illustration fraîche : 92,77 % de lignes mais
**70,37 % de branches**. Un sabotage y a d'ailleurs montré qu'un chemin d'erreur
non couvert n'était pas seulement non mesuré — il était **non éprouvé**
(ADR-057).

### 4.4 Couches 04 à 08 du banc — non construites

`docs/22 §6` en définit huit. État réel :

| Couche | État |
|---|---|
| 01 Clock | **faite** (`docs/23`) |
| 02 Lease | **faite** (`docs/25`) |
| 03 Fencing | **faite** (`docs/24`) |
| 04 Request lifecycle | **non construite** |
| 05 Provider reality — les deux mondes | **non construite** |
| 06 Observation | partielle |
| 07 Verdict | partielle |
| 08 Recovery | couverte par les crash tests |

`lab_provider_requests` — le second monde — n'existe pas. `docs/22 §14`
l'ordonne en position 2 avec la mention *« sans lui, rien d'autre n'est
démontrable »*. **C'est la plus grande zone d'ombre différée du dépôt**, et
elle bloque : fournisseur byzantin, `PROVIDER_CONTRACT_VIOLATION`, chaîne de
provenance `intentId → effectId`, invariants I11 à I13.

> **LEVÉE — voir `docs/27`.** Le second monde existe, les couches 04-05 sont
> faites, `PROVIDER_CONTRACT_VIOLATION` et I11 aussi. Ce paragraphe reste
> écrit tel qu'il l'était : un registre qu'on réécrit cesse d'être un registre.
> Ce qui a pris sa place — **I12** (aucune action nouvelle après violation) et
> **I13** (chaîne de provenance complète) — est nommé en `docs/27 §8`.

### 4.5 ~~`egress` est un booléen là où il y a DEUX questions~~ — **LEVÉE**

> **LEVÉE à l'étape F2 du Data Firewall — ADR-051.** Le paragraphe reste écrit
> tel qu'il l'était : un registre qu'on réécrit cesse d'être un registre.
>
> `networkRequired` est désormais **dérivé du fournisseur branché**
> (`privacy/egress.ts`), au seul moment où l'information existe. Un CalDAV
> local ne déclare plus d'égression ; un agenda cloud si.
>
> **Ce qui l'a rendue urgente :** F2 applique « niveau ≥ SENSITIVE + egress →
> DENY ». L'agenda est `SENSITIVE`, et les quatre outils sortants du dépôt
> manipulent tous de l'agenda — **tous devenaient définitivement refusés, y
> compris sur un fournisseur purement local.** Le défaut de modélisation
> cessait d'être une gêne théorique pour devenir un blocage complet.
>
> **Le test qui la portait avait annoncé sa propre fin** — « il DATE le constat
> et échouera le jour où le Data Firewall le rendra faux » — et il a échoué. Il
> est retourné en preuve de la fermeture.
>
> ⚠ **CE QUE LA LEVÉE COÛTE, ET IL FAUT LE DIRE.** `capabilities.local` est une
> DÉCLARATION du fournisseur. Un adaptateur qui mentirait — `local: true` en
> pointant vers Internet — échapperait au Gate. Avant, `networkRequired: true`
> était inconditionnel et ce chemin n'existait pas.
>
> Ce n'est pas un troc gratuit, c'est un troc **assumé** : l'alternative rendait
> la capacité inutilisable. Voir la nouvelle entrée **§4.9**.

#### Le constat d'origine, conservé

### 4.5-bis `egress` était un booléen là où il y a DEUX questions

**Trouvé en écrivant `calendar_read`, pas en relisant le modèle.**

Le premier outil sortant du dépôt a rendu mesurable ce qui n'était jusque-là
qu'une élégance de schéma : `egress` est dérivé de `networkRequired`
(`gateway.ts:801`), puis confronté à un interrupteur nommé `cloudEnabled`.
Deux questions distinctes sont écrasées sur un seul bit.

| Question | Champ qui la porte |
|---|---|
| l'appel quitte-t-il le **processus** ? | `ToolDefinition.networkRequired` |
| la destination est-elle hors de la **machine** ? | *(personne)* |

Un CalDAV sur `127.0.0.1` sort du processus sans sortir de la machine. Le
modèle ne sait pas l'exprimer, et les deux issues sont mauvaises :

- `networkRequired: false` ferait sortir un agenda **cloud** sans que le Gate
  le voie ;
- `networkRequired: true` — le choix retenu, fail-closed — oblige l'utilisateur
  à laisser `cloudEnabled` armé pour un usage quotidien. **Un interrupteur de
  sûreté qu'il faut désarmer pour se servir de la machine cesse d'être un
  interrupteur de sûreté.**

Mesuré : `tests/tools/calendar-read.test.ts`, dernier test — un fournisseur
dont `capabilities.local === true` est refusé sans `cloudEnabled`, autorisé
avec.

**Ce n'est pas réparable dans un outil.** `ProviderCapabilities.local` porte
déjà la réponse ; ce qui manque est le composant qui croise le contrat de
l'outil et les capacités du fournisseur — le **Data Firewall** de `docs/02`
Phase 4, dont la mission est littéralement « classification, redaction,
**décision d'égression** ».

**Conséquence sur l'ordre des chantiers.** Tout agenda cloud exige que ce
composant existe D'ABORD. Aujourd'hui, la règle censée protéger l'agenda
(`docs/14` : agenda = `SENSITIVE`, cloud interdit) **n'est pas en vigueur dans
le code** — `DataLevel` n'est pas implémenté, `PrivacyClass` en est encore à
trois valeurs, et la politique dure ne refuse que `RED + egress`. Un outil
d'agenda déclare `ORANGE` et passe. Ouvrir le cloud avant le Data Firewall
reviendrait donc à lui donner pour première mission de rattraper un trou déjà
ouvert.

**Condition de levée :** `DataLevel` implémenté et Data Firewall branché. Le
dernier test de `calendar-read.test.ts` échouera ce jour-là — c'est ce qu'on
demande à une zone d'ombre : se signaler quand elle disparaît.

### 4.6 `CalendarProvider` ne peut pas vérifier une tentative

**Trouvé en écrivant `calendar_create`, contre la prescription de `docs/16`.**

`docs/16 §3` prescrit pour cet outil :

```text
| futur calendar.create | EXTERNE | READ_BACK | BY_RESOURCE | clé d'opération |
```

L'interface déclarée ne peut pas l'honorer :

```ts
createEvent(event, operationId): Promise<Result<CalendarEvent>>
verifyEvent(id):                 Promise<Result<CalendarEvent | null>>
```

`verifyEvent` exige **l'identifiant de l'événement** — précisément ce qu'on n'a
pas si le processus est mort avant de l'avoir enregistré. La question à laquelle
une vérification de tentative doit répondre est *« as-tu déjà traité l'opération
8f2a… ? »*, et `CalendarProvider` ne sait pas l'entendre.

D'où `attemptVerification: 'NONE'`. Déclarer `BY_OPERATION_KEY` exigerait un
`verifyAttempt` qu'on ne pourrait pas écrire honnêtement — c'est exactement
l'**illusion de fiabilité** que le validateur de contrat existe pour empêcher
(`contract.ts:397`).

**Conséquence assumée :** après un `UNKNOWN`, on ne rejoue pas et on demande.
C'est la conduite prescrite par ADR-027, et elle est correcte ; simplement, elle
sera demandée plus souvent qu'elle ne devrait.

**Divergence document ↔ document, à trancher.** La règle de `docs/16 §3` —
*« aucun outil `effect: EXTERNAL` ne peut être enregistré avec
`attemptVerification: NONE` »* — n'est **pas** celle que le code applique, et ce
n'est pas un oubli : **ADR-030 l'a explicitement remplacée.**

> *« Interdire aurait exclu des familles entières d'outils légitimes — un webhook
> chez un tiers sans API de consultation reste utile. On n'interdit donc pas
> l'OUTIL : on interdit l'ILLUSION DE FIABILITÉ. »*

Le code interdit désormais : effet externe + `UNVERIFIABLE` + autonomie L1/L2.
`docs/16 §3` est donc **périmé sur ce point** et devrait renvoyer à ADR-030.

**Condition de levée :** un `findByOperationId` sur `CalendarProvider`, à ajouter
le jour où un adaptateur réel est écrit — et à ne pas ajouter avant, faute de
savoir si un CalDAV donné sait y répondre.

### 4.7 La fenêtre entre lecture et écriture, chez un fournisseur

**Trouvée en transposant ADR-042 hors de PostgreSQL.**

`task_complete` fusionne mutation et capture dans une seule instruction
(`UPDATE … FROM tasks AS prior`) : aucune fenêtre où l'état changerait entre les
deux. Chez un fournisseur distant, cette fusion **n'existe pas** — il n'y a ni
transaction commune, ni comparaison-et-échange.

ADR-045 déplace l'obligation plutôt que de fermer la fenêtre : le fournisseur
rend `previous`, l'état qu'il a lui-même remplacé. C'est strictement mieux qu'une
lecture préalable de notre part — mais **ce n'est pas une atomicité**, et la
différence doit être écrite.

**Ce qui reste ouvert :**

| Résidu | Ce qui le couvre aujourd'hui |
|---|---|
| le fournisseur peut mentir sur `previous` | vérifié : un identifiant qui ne correspond pas ⇒ `INTEGRITY`, refus |
| son `previous` peut être périmé de quelques millisecondes | **rien** — irréductible sans mise à jour conditionnelle |
| deux modifications concurrentes peuvent s'écraser | **rien** — c'est le même manque |

Le mécanisme qui fermerait les deux dernières lignes existe et porte un nom :
**la mise à jour conditionnelle** (`If-Match` sur un ETag, que CalDAV expose).
Elle n'est pas ajoutée à `CalendarProvider` aujourd'hui, et c'est délibéré —
ajouter un champ qu'aucun adaptateur ne remplit serait spéculatif au sens de
`docs/04`, et donnerait l'illusion d'une garantie.

**Condition de levée :** au premier adaptateur réel, mesurer si le fournisseur
expose un jeton de version. S'il l'expose, `updateEvent` doit le prendre et le
renvoyer, et cette entrée disparaît. S'il ne l'expose pas, elle devient
**irréductible pour ce fournisseur** et doit remonter en §5.

### 4.8 La composition d'outils n'est pas éprouvée

**Mesuré avant d'écrire `briefing_generate` :** aucun outil du dépôt n'invoque le
Tool Gateway.

```bash
grep -rn "gateway\.\|invoke(" src/tools/*.ts   # → aucun appel
```

Un outil qui en appellerait un autre créerait une opération **imbriquée** dans
une opération : second bail, second identifiant, seconde entrée au journal, et
un verdict qui dépendrait de trois sous-verdicts. Rien de tout cela n'est
interdit par le code — et rien n'est éprouvé non plus.

`briefing_generate` **évite** la question : il lit les sources directement, et un
test structurel interdit à son fichier de contenir `gateway` ou `.invoke(`.
C'est un contournement assumé, pas une solution.

**Ce qui reste ouvert, et qu'il faudra trancher un jour :**

| Question | État |
|---|---|
| un bail imbriqué se comporte-t-il correctement ? | inconnu |
| le journal doit-il montrer une ou N opérations ? | non décidé |
| le verdict composite se déduit-il des sous-verdicts ? | non spécifié |
| une sous-opération refusée annule-t-elle la parente ? | non spécifié |

**Condition de levée :** un chantier de composition, avec son banc — pas un effet
de bord du prochain outil qui en aurait besoin. Le test structurel de
`briefing.test.ts` sera le premier à retirer, et sciemment.

### 4.9 `capabilities.local` est CRU, pas vérifié

**Créée par la levée de §4.5, et c'est la moitié qu'il ne faut pas oublier.**

Depuis ADR-051, la décision d'égression repose sur ce que le fournisseur déclare
de lui-même :

```ts
export function leavesMachine(provider: Provider | null): boolean {
  if (provider === null) return false;
  return !provider.capabilities.local;   // ← une DÉCLARATION
}
```

Un adaptateur qui annoncerait `local: true` en pointant vers Internet
échapperait au Policy Gate. Aucun mécanisme ne le contredit aujourd'hui.

**Pourquoi c'est accepté :** l'alternative — `networkRequired: true`
inconditionnel — rendait tout outil manipulant de l'agenda **définitivement
refusé**, y compris sur un CalDAV local. Une protection qui interdit l'usage
normal n'est pas conservée par les utilisateurs, elle est désactivée.

**Ce qui le borne déjà :** aucun adaptateur n'existe. Le seul fournisseur du
dépôt est une doublure de test, dont le `local` est fixé par le test lui-même.

**Condition de levée — et le mécanisme existe déjà.** `isPrivateAddress`
(`src/apps/server/auth.ts`) reconnaît `127.*`, `10.*`, `192.168.*`,
`172.16-31.*`, lien-local et ULA IPv6. Au premier adaptateur réel,
`capabilities.local` doit être **corroboré** par l'adresse effective du
fournisseur, pas cru sur parole. C'est la même discipline que
`PROVIDER_CONTRACT_VIOLATION` : un fournisseur qui ment sur lui-même est un
problème de SOURCE, et il se constate.

### 4.10 S12 — la capture existe, l'exécution du défaire n'existe pas

**Trouvée en rendant `docs/03` mécanique (ADR-054).** L'invariant S12 dit « le
rollback reste possible ». Mesure :

| | |
|---|---|
| `src/core/undo/` | **un seul fichier** — `snapshots.ts`, la capture |
| Outils inverses déclarés | `task_cancel` · `note_delete` · `memory_forget` · `calendar_delete` · `reminder_cancel` |
| Outils inverses **écrits** | **zéro** |
| Moteur qui rejoue une capture | **aucun** |

L'invariant est donc vrai au sens des **données** — on sait quoi défaire, et
`ADR-019` garantit 7 jours de rétention — et faux au sens de l'**action** :
rien ne peut défaire.

**Pourquoi ce n'est pas classé « fait » :** parce que l'écart est exactement du
type que `docs/12` proscrit. « Le rollback est possible » lu par un humain
signifie « je peux revenir en arrière », pas « la donnée nécessaire est
conservée quelque part ».

**Condition de levée :** le premier outil inverse écrit et éprouvé de bout en
bout — capture, rejeu, vérification. La réserve est chiffrée dans
`invariants-contract.test.ts` et ne peut plus disparaître silencieusement.

### 4.11 S13 — le cloud est éteint EN DUR, il n'y a pas d'interrupteur

**Le motif « CostGate » une deuxième fois : tenu par ABSENCE, pas par mécanisme.**

`config/default.json` expose `cloud.enabled`. Le runtime écrit
`cloudEnabled: false` en littéral, et l'Assistant aussi. **La clé de
configuration n'a aucun effet** — c'est `wiring.test.ts` qui le démontre, pas
qui le corrige.

Le résultat va dans le bon sens aujourd'hui. Le piège est ailleurs : une clé
exposée laisse croire qu'un interrupteur existe. Or l'invariant S13 ne dit pas
« le cloud est éteint », il dit **« l'utilisateur peut désactiver le cloud »** —
ce qui suppose qu'il puisse aussi l'activer, donc que la clé pilote quelque
chose.

**Ce qui le borne :** aucun fournisseur cloud n'existe. L'interrupteur n'aurait
aujourd'hui rien à commander, et le brancher avant serait un interrupteur qui
ment dans l'autre sens.

**Condition de levée :** au premier fournisseur cloud branché, `cloud.enabled`
doit piloter `cloudEnabled` — au même moment que le branchement du CostGate
(§4.1), et pour la même raison.

---

## 5. IRRÉDUCTIBLES — et elles le resteront

Aucune ne se lèvera par plus de code. Les écrire est la seule chose à faire.

| | Pourquoi c'est impossible |
|---|---|
| **Savoir si un processus est vivant** | « gelé » et « mort » sont indiscernables de l'extérieur. Mesuré `docs/21`, reconfirmé `docs/25 §4.3`. |
| **Savoir si un exécutant périmé a produit un effet** | le cloisonnement protège l'état interne, jamais le monde. Mesuré : l'effet de A existe pendant que son écriture est refusée. |
| **Annuler une requête déjà partie** | rien dans la pile ne l'offre. Ni `withTimeout`, ni le bail, ni le cloisonnement. |
| **Déduire l'absence d'effet d'une absence d'observation** | au moment où on regarde, il n'y a rien À VOIR. Ce n'est pas un défaut de vérification, c'est une limite de l'observation (`docs/21 §2`). |
| **Vérifier qu'un fournisseur dit vrai** | une réponse est une OBSERVATION, jamais une preuve. Croire un `500` est la faute symétrique de croire un `200`. |
| **Garantir qu'une garantie de tiers tient** | `PROVIDER_IDEMPOTENT` repose sur la parole du fournisseur. Le banc peut mettre en scène un menteur ; il ne peut pas le rendre honnête. |

Une seule règle en découle, et elle est déjà dans `CLAUDE.md` :

> Une fonctionnalité ne peut jamais être plus autonome que la qualité de la
> preuve disponible sur son effet.

---

## 6. NON TESTABLE ICI — et ce qui en reste vraiment

Après le §2.2, la liste a beaucoup rétréci. Ce qui subsiste :

| | Pourquoi, précisément |
|---|---|
| Partition réseau **réelle** entre application et base | une seule machine. Ce qui est mesurable — base injoignable — l'est (`docs/25 §4.5`), et la propriété tenue est « Jarvis ne tente rien ». |
| Dérive d'horloge entre **deux serveurs PostgreSQL** | sans objet : ADR pose une source de vérité unique. Deux serveurs seraient deux Jarvis, pas un Jarvis distribué. |
| Comportement d'un **fournisseur réel** | par construction du gel fonctionnel : aucun SaaS, aucun appel sortant, 0 €. |

La deuxième ligne est un changement de statut, pas un aveu : elle passe de
« non testable » à **« sans objet »**, ce qui n'est pas la même chose.

---

## 7. Ce que ce balayage ne garantit pas

La phrase la plus importante du document.

**Ce registre est exhaustif sur ce que je sais chercher.** Les quatre défauts
majeurs de ce dépôt ont tous été trouvés par la **mesure**, jamais par la
relecture — et le cinquième, corrigé au §2.1, l'a été en cherchant le voisin
d'un motif connu.

Un sixième existe probablement, et il ne ressemblera à aucun des cinq
précédents. La seule défense connue reste celle qui a fonctionné cinq fois :

```text
MESURER · CHERCHER LE CONTRE-EXEMPLE · SABOTER SES PROPRES GARDES
```

Et la règle méthodologique qui l'accompagne, qui n'a pas bougé :

> Ne jamais considérer « tests verts » comme synonyme de « système sûr ».
