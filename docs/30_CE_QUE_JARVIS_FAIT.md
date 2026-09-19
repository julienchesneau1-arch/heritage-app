# 30 — CE QUE JARVIS FAIT, EXACTEMENT

**Le document que tu m'as demandé : tout l'intérêt, tout le détail, aucune zone
d'ombre, et les limites.**

Rien ici n'est une estimation. Chaque nombre vient d'une mesure, et la dernière
section te dit comment refaire chaque mesure toi-même sans me croire sur parole.

---

## 1. En une phrase

> **Jarvis est un assistant personnel qui tourne entièrement sur ta machine, et
> qui ne dit jamais avoir fait quelque chose qu'il n'a pas vérifié.**

Tout le reste découle de ces deux propriétés. Elles ne sont pas des slogans :
elles sont chacune tenues par un mécanisme, et chaque mécanisme a été saboté
pour vérifier qu'il tient.

---

## 2. L'intérêt — pourquoi ça, plutôt qu'un ChatGPT vocal

La question honnête est : *qu'est-ce que ça fait que les autres ne font pas ?*
Il y a cinq réponses, et elles ne sont pas de même nature.

### 2.1 Il ne ment pas sur ce qu'il a fait

C'est **la** différence, et elle est structurelle plutôt que morale.

Un assistant généraliste répond en produisant du texte plausible. Quand il dit
« c'est envoyé », il produit la phrase qui suit statistiquement une demande
d'envoi. Il n'a pas consulté le monde — il a continué une conversation.

Jarvis ne peut pas faire ça. La chaîne est :

```text
ta phrase → proposition → politique → outil typé → exécution
                                                      ↓
                             RELECTURE de l'état réel ← ┘
                                                      ↓
                                         « c'est fait » OU « UNKNOWN »
```

Sept états existent, et **aucune fonction du dépôt ne sait fabriquer un
`CONFIRMED`** en dehors du moteur de vérification, sur preuve :

| État | Ce qu'il veut dire |
|---|---|
| `CONFIRMED` | preuve **positive** que l'effet a eu lieu |
| `PROBABLE` | le fournisseur atteste, aucune relecture indépendante |
| `PARTIAL` | une partie a abouti, une autre non — et il dit laquelle |
| `UNKNOWN` | **on ne sait pas**, et c'est une réponse valide |
| `FAILED` | preuve que ça n'a pas eu lieu |
| `NOT_ATTEMPTED` | rien n'a été tenté |
| `PROVIDER_CONTRACT_VIOLATION` | le fournisseur a dit quelque chose d'incohérent |

`UNKNOWN` est la trouvaille du projet. Un timeout réseau ne devient jamais
`FAILED` : la requête est peut-être arrivée. Dire « ça a échoué » serait un
mensonge aussi grave que « c'est fait ».

### 2.2 Rien ne sort de la machine sans passer par une porte

Un seul outil sur 22 fait sortir quelque chose (`web_search`), et il est le
seul à porter `networkRequired: true`. Tout le reste tourne en local sur
PostgreSQL.

Et chaque sortie est **journalisée avant de partir** : `/audit` et
`egress_review` répondent depuis le journal, pas depuis une reconstruction.

### 2.3 Le modèle propose, le système décide

C'est la règle qui te protège d'un LLM manipulé.

Un modèle local peut proposer une action. Il ne peut pas l'autoriser. La
proposition traverse un Policy Gate qui **ne sait que durcir** : il n'existe
volontairement aucune fonction capable d'abaisser un niveau d'autonomie.

```text
Politique dure : un paiement exige toujours confirmation.
Mémoire        : Julien approuve généralement les achats sous 50 €.
Résultat       : le paiement exige toujours confirmation.
```

Concrètement : si le contenu d'un email te dit « virement urgent », ce texte
est étiqueté `EXTERNAL_UNTRUSTED`. S'il atteint un paramètre sensible, le
niveau monte automatiquement à **L4** — confirmation sur la **valeur**, pas sur
l'intention. Tu ne confirmes pas « faire un virement », tu confirmes « virer
4 000 € à FR76… ».

### 2.4 Tes données ont un niveau, et ce niveau est imposé par la base

Quatorze catégories, cinq niveaux, et un **plancher** que la catégorie impose :

```text
CREDENTIAL                                      → RESTRICTED
HEALTH · FINANCIAL                              → HIGHLY_SENSITIVE
EMAIL · MESSAGE · CALENDAR · CONTACT
DOCUMENT · LOCATION                             → SENSITIVE
TASK · PROJECT · PERSONAL_MEMORY                → PERSONAL
WEATHER                                         → PUBLIC
OTHER                                           → PERSONAL   (défaut FERMÉ)
```

Le niveau peut monter, jamais descendre. Et depuis ADR-092 ce n'est plus
l'application qui le tient : c'est une contrainte de base de données. Le jour
où un bug applicatif essaierait d'écrire un bilan de santé en `PUBLIC`,
PostgreSQL refuse la ligne.

### 2.5 Tout est réversible ou refusé

Chaque action qui crée quelque chose capture un instantané et nomme son inverse.
`/annule` défait la dernière.

Et — détail qui dit tout sur l'esprit du projet — **défaire coûte plus cher que
faire** : `memory_add` est `L2` (exécution directe), `memory_forget` est `L4`
(confirmation obligatoire). Effacer est irréversible ; créer ne l'est pas.

---

## 3. Ce qu'il fait exactement — les 22 outils

`L1` = lecture, aucune confirmation · `L2` = écriture réversible, directe ·
`L3` = confirmation requise · `L4` = confirmation + irréversible

| Outil | Niveau | Réversible | Catégorie | Vérification | Ce qu'il fait |
|---|---|---|---|---|---|
| `memory_add` | L2 | oui | PERSONAL_MEMORY | relecture | Mémoriser une information, via le Memory Guard |
| `memory_search` | L1 | — | PERSONAL_MEMORY | — | Chercher en mémoire, **trois voies** |
| `memory_forget` | **L4** | non | PERSONAL_MEMORY | relecture | Effacer définitivement une mémoire **et ses dérivés** |
| `note_create` | L2 | oui | PERSONAL_MEMORY | relecture | Créer une note |
| `note_delete` | **L4** | non | PERSONAL_MEMORY | relecture | Supprimer définitivement une note |
| `task_create` | L2 | oui | TASK | relecture | Créer une tâche |
| `task_list` | L1 | — | TASK | — | Lister les tâches ouvertes |
| `task_complete` | L2 | oui | TASK | — | Marquer une tâche terminée |
| `task_cancel` | L2 | oui | TASK | relecture | Annuler une tâche — la ligne est conservée |
| `reminder_create` | L2 | oui | TASK | relecture | Créer un rappel **daté**, restitué dans le briefing |
| `reminder_cancel` | L2 | oui | TASK | relecture | Annuler un rappel |
| `entity_create` | L2 | oui | CONTACT | relecture | Enregistrer une personne, un lieu, un projet |
| `entity_delete` | **L4** | non | CONTACT | relecture | Supprimer une entité **et ses relations** |
| `calendar_read` | L1 | — | CALENDAR | — | Lire l'agenda sur une fenêtre |
| `calendar_create` | **L3** | oui | CALENDAR | relecture | Créer un événement |
| `calendar_update` | **L3** | oui | CALENDAR | relecture | Modifier un événement |
| `file_search` | L1 | — | DOCUMENT | — | Chercher un fichier par nom, **sous une racine autorisée** |
| `web_search` | L1 | — | OTHER | — | ⚠ **seul outil qui sort de la machine** |
| `briefing_generate` | L1 | — | CALENDAR | — | Agenda, tâches urgentes, points en attente |
| `audit_query` | L1 | — | OTHER | — | « Qu'as-tu fait ? », **depuis le journal** |
| `egress_review` | L1 | — | OTHER | — | Ce qui est parti : où, quelle classe, pourquoi |
| `system_status` | L1 | — | OTHER | — | Intégrité du journal, opérations sans issue, modèle local |

### ⚠ Le chiffre qui compte vraiment : **21 sur 22**

**Un outil écrit n'est pas un outil que tu peux déclencher.** C'est la distinction
qu'aucun tableau d'avancement ne fait, et elle est mesurée par
`tests/intent/surface-parlee.test.ts` :

| | Nombre | Lesquels |
|---|---|---|
| **Atteignables en parlant** | **21** | les 11 d'origine, plus `task_complete` `task_cancel` `reminder_cancel` `note_delete` `memory_forget` `entity_delete` `audit_query` `egress_review` `calendar_read` `calendar_create` |
| **Hors d'atteinte** | **1** | `calendar_update` |

**Il n'en reste qu'un**, et sa raison n'est pas un manque de code : modifier un
événement exige un identifiant qui vit **chez Google**. Le désigner demande de
lire l'agenda d'abord — donc un compte connecté. Écrire une règle qui échoue
serait pire que son absence.

> **Ce chiffre était de 11 sur 22.** Dix outils sont sortis de l'ombre sans
> qu'aucun ne soit écrit :
>
> - **six** exigeaient un identifiant qu'une phrase ne porte pas (ADR-096) ;
> - **deux** n'avaient simplement aucune règle ;
> - **deux** — l'agenda — étaient bloqués par une phrase **périmée** qui disait
>   « je ne sais pas encore résoudre une date en français », faux depuis
>   ADR-077 (ADR-097).
>
> Ce qui a changé n'est pas la capacité. C'est **qui résout la désignation**,
> et le fait qu'une limite périmée avait fini par empêcher le travail suivant.

> ⚠ **`calendar_read` et `calendar_create` attendent tes identifiants Google.**
> Sans eux, Jarvis répond « aucun agenda connecté » — ce qui n'est pas une
> erreur mais un **prérequis** que tu peux fournir. Trois variables dans
> `.env`, et l'agenda s'active au démarrage suivant. §6.2.

### Les phrases qui marchent, mot pour mot

```text
retiens que …                      mémoriser un fait
que sais-tu sur …                  chercher en mémoire
enregistre <nom> comme personne    créer une entité
ajoute … à ma liste                créer une tâche
rappelle-moi jeudi de …            créer un rappel DATÉ
mes tâches                         lister les tâches ouvertes
note …                             prendre une note
cherche sur le web …               rechercher en ligne
cherche dans mes documents …       rechercher dans les fichiers
fais-moi un point                  briefing du jour
comment vas-tu                     état du système

termine la tâche …                 marquer une tâche terminée
annule la tâche …                  annuler une tâche
annule le rappel …                 annuler un rappel
supprime la note …                 ⚠ L4, définitif
oublie que …                       ⚠ L4, définitif
supprime la fiche de …             ⚠ L4, définitif
qu’as-tu fait …                    le journal d'exécution
qu’est-ce qui est sorti …          ce qui a quitté la machine
qu’ai-je de prévu demain           lire l'agenda      ⚠ compte Google
crée un rendez-vous jeudi à 14h …  créer un événement ⚠ compte Google
```

Commandes : `/audit` · `/annule` · `/inbox` · `/diagnostic` · `/aide` · `/quitter`

> **« cherche … » tout court est refusé exprès.** Il y a trois portées —
> mémoire, web, documents. Deviner laquelle reviendrait à chercher ailleurs que
> là où tu croyais, puis à annoncer un succès. Il demande.

---

### Depuis l'iPhone — les 21, dont 3 en deux temps

`pnpm jarvis:web` affiche un lien à ouvrir sur le téléphone, connecté au même
Wi-Fi. **Partager → Sur l'écran d'accueil** en fait une icône plein écran.

**Dix-huit capacités répondent directement.** Les trois suppressions
définitives passent par une file d'attente, et la raison est structurelle :

> Une confirmation renvoyée par le même canal que la demande ne prouve rien.
> Qui détient le jeton pourrait se confirmer à lui-même.

```text
téléphone  « supprime la note du carreleur »
           → « Rien n'a été fait — préparé : … »
           → 30 minutes pour décider

Mac        « /confirmer »
           → « Demandé depuis le téléphone · expire dans 29 min »
           → oui  →  ✓ Effacement vérifié : note … absente
           → non  →  « Abandonnée. Rien n'a été fait. »
```

```text
jeton détenu           → droit de METTRE EN FILE
présence à la machine  → droit d'EXÉCUTER
```

⚠ **Une ligne de cette file n'autorise rien.** La confirmation rejoue la chaîne
complète — Policy Gate compris. Une action qu'une politique interdit sera
refusée de nouveau, file ou pas. Et seuls les refus de *surface* peuvent y
entrer : un interdit reste un interdit.

Le téléphone peut **voir** ce qui attend (bouton « À confirmer sur le Mac »),
et rien de plus : aucun identifiant ne lui est transmis, donc il ne peut pas
confirmer même si une route apparaissait par accident. **Voir n'est pas
pouvoir.**

---

### Ce que tu vois d'un résultat

Chacun des 21 outils affiche ce qu'il a trouvé — et il le dit **de la même
façon sur le Mac et sur le téléphone**, parce que les lignes sont calculées une
seule fois, côté serveur. Le navigateur ne décide rien.

```text
> fais-moi un point
  ✓ Voici ce que j'ai trouvé.
  Agenda : indisponible — aucun fournisseur d'agenda n'est configuré
  Tâches :
    • appeler le plombier
  Rappels : rien.
  ⚠ Briefing incomplet — une source n'a pas répondu.
```

Quatre choses que ce rendu dit et qu'il aurait pu taire :

| | |
|---|---|
| Un **rappel** | *« rien ne sonne encore »* — un rappel apparaît dans le briefing, il ne déclenche aucune notification |
| Un **oubli** | nomme les copies qui survivent ailleurs — « oublié » sans ça serait une fausse promesse |
| Le **web** et les **fichiers** | marquent le contenu de tiers : Jarvis ne le reprend pas à son compte |
| Le **briefing** | dit l'état de chaque section — une section indisponible affichée vide ferait croire à une journée libre |

> **Jusqu'à ADR-100, sept outils sur vingt-et-un affichaient « ✓ C'est fait »
> et jetaient leur résultat.** Ce n'était pas un mensonge — l'action avait eu
> lieu. Mais tu ne pouvais pas distinguer « le briefing est vide » de « le
> briefing ne s'affiche pas ».

---

## 4. Ce qui se passe entre ta phrase et la réponse

Huit étapes. Aucune n'est sautable.

```text
1. COMPRENDRE       Tier 0 : règles déterministes. 0,0046 ms, mesuré sur
                    10 000 énoncés. Aucun modèle requis.
                    Si aucune règle ne matche → Tier 1 (modèle local), s'il
                    est configuré. Sinon : « je n'ai pas compris ».

2. RÉSOUDRE         « ajoute ÇA à ma liste » → le référent vient du tour
                    précédent. Deux homonymes → il DEMANDE lequel.
                    Rien à quoi se rattacher → il refuse.

3. CLASSER          la catégorie de la donnée impose son niveau. Le modèle ne
                    choisit JAMAIS son propre niveau de confidentialité.

4. DÉCIDER          Policy Gate. Il ne sait que durcir.
                    L0 → refus immédiat · provenance non fiable → L4
                    proactif → au moins L3 · surface distante + L3/L4 → REFUS
                    puis Cedar, interrogé sur le niveau DURCI.

5. CONFIRMER        si L3/L4 : préparation autorisée, exécution suspendue.
                    La confirmation porte sur la VALEUR concrète.

6. EXÉCUTER         outil typé, paramètres validés par Zod à la frontière.
                    Clé d'opération : un rejeu ne duplique rien.

7. VÉRIFIER         relecture de l'état réel. C'est ici, et seulement ici,
                    qu'un CONFIRMED peut naître.

8. JOURNALISER      chaîne d'événements chaînée par hash. Vérifiée à chaque
                    consultation. Une ligne modifiée casse la chaîne.
```

### Le tour de parole, pour l'oral

Mesure faite : la chaîne de Jarvis coûte quelques millisecondes. L'intuition
« vérifié, donc lent » est **fausse** — le budget de latence part dans la
transcription et la synthèse, pas dans la vérification.

D'où deux temps, comme un humain :

```text
« ajoute du café à ma liste »
  ↓ immédiat
« je m'en occupe »        ← ne prétend RIEN sur l'action
  ↓ quelques millisecondes
« c'est dans ta liste »   ← le VERDICT, quand il est connu
```

L'accusé de réception porte sur **la réception**, jamais sur l'effet.

---

## 5. Ce qui l'empêche d'être détourné

### Le contenu externe est de la donnée, jamais une instruction

Six provenances, dont deux ne peuvent jamais alimenter un paramètre sensible
sans confirmation sur la valeur :

| Provenance | Statut |
|---|---|
| `USER` `SYSTEM` `MEMORY` | fiables |
| `TOOL_OUTPUT` | semi-fiable — résultat de **nos** outils typés |
| `MODEL_OUTPUT` | ⚠ jamais une autorité — personne n'est hostile, mais rien ne garantit l'exactitude |
| `EXTERNAL_UNTRUSTED` | ⚠ jamais une instruction — un tiers l'a écrit, il peut être hostile |

Le contenu web passe par un processeur de quarantaine avant d'entrer où que ce
soit.

### Une surface distante ne confirme pas

Si tu utilises la passerelle web depuis ton téléphone, **les actions L3/L4 sont
refusées**, même avec `confirm: true`.

La raison : qui détient le jeton peut se confirmer à lui-même. La confirmation
cesserait d'être un second facteur pour devenir un second appel HTTP. Le
refus dit quoi faire : *« à faire depuis la machine »*.

### Un secret n'entre nulle part

`Secret` est une classe qui ne sait pas s'imprimer : `toString`, `toJSON` et
l'inspecteur Node rendent tous `Secret(nom)[REDACTED]`. Le seul moyen d'obtenir
la valeur est d'appeler `expose()` explicitement. Un log accidentel est
impossible, pas seulement découragé.

Et `pnpm secrets:scan` balaye **l'arbre de travail et l'historique git**.

---

## 6. Les limites — la partie que tu dois lire

### 6.0 Les lunettes — ce qui est prêt, et le trou qui reste

Des lunettes sont, au sens de la sécurité, **une surface distante avec de la
voix**. Les deux moitiés sont déjà tranchées : le canal (file d'attente,
confirmation devant la machine) et le micro (rien avant le mot d'activation,
témoin qui ne peut pas mentir, plafond vocal selon qui a choisi le moment).

Et la règle de surface est écrite en **défaut fermé** : une troisième valeur
ajoutée hérite du régime *distant*, jamais du régime local. Ajouter les
lunettes restreindra par défaut.

> ⚠ **Mais le refus de parler suppose un écran.**
>
> ```text
> terminal / téléphone   « je ne le dis pas à voix haute »  → c'est à l'écran
> lunettes               « je ne le dis pas à voix haute »  → tu ne l'auras pas
> ```
>
> Le plafond vocal a été conçu en supposant qu'un refus de *dire* n'était pas
> un refus de *donner*. Sur un visage, les deux se confondent. Trois issues,
> aucune évidente — et c'est un arbitrage qui ne se prend pas avant d'avoir
> porté l'appareil. `docs/26 §4.19`.

**Et il n'y a aucune ligne de code audio.** Tout ceci décrit une architecture
prête à recevoir une capacité qui n'existe pas.

### 6.1 Ce qui n'existe pas du tout

| | État |
|---|---|
| **La voix** | aucune ligne de code audio. Les trois briques sont choisies et documentées, les deux arbitrages de confidentialité sont tranchés et en code — le son, non. |
| **Envoyer un email / un message** | aucun outil d'envoi. C'est la capacité qui manque le plus. |
| **Contrôler la maison** | aucun outil. |
| **La météo** | aucun outil. |
| **L'application iOS native** | aucun répertoire. La passerelle web en tient lieu, et les 21 capacités y répondent — trois en deux temps (§3). |
| **Le Model Router** | aucun fichier ne contient « router ». |
| **Installer une mise à jour** | la couche qui **décide** existe ; celle qui **exécute** non. Conséquence saine : **toute mise à jour est refusée aujourd'hui**. |

### 6.2 Ce qui existe mais que tu ne peux pas atteindre

**L'agenda — il ne manque que tes identifiants.**

`calendar_read` et `calendar_create` ont leurs règles depuis ADR-097. Dis
« qu'ai-je de prévu demain » : Jarvis comprend, résout la journée par la base,
appelle l'outil — et répond **« aucun agenda connecté »**. Ce n'est pas une
erreur, c'est un **prérequis nommé**.

> ⚠ **Ces règles ont été bloquées par une phrase périmée.** Le moteur affirmait
> *« je ne sais pas encore résoudre une date dite en français »* — faux depuis
> ADR-077, qui fait marcher « rappelle-moi jeudi ». La phrase est restée écrite
> plusieurs ADR durant et a servi de raison de ne pas écrire les règles.
>
> C'est le motif d'ADR-094 dans sa forme la plus coûteuse : **une limite
> périmée n'est pas seulement fausse, elle empêche le travail suivant.**

Le connecteur Google **est écrit et se branche tout seul** : dès que les trois
secrets sont au coffre, le fournisseur est construit au démarrage.

```bash
# dans .env — sur ta machine, jamais dans le dépôt
GOOGLE_OAUTH_CLIENT_ID=…
GOOGLE_OAUTH_CLIENT_SECRET=…
GOOGLE_OAUTH_REFRESH_TOKEN=…
```

⚠ **Ce code n'a jamais parlé à l'API réelle.** Aucun compte n'était connecté là
où il a été écrit. Il est éprouvé contre un transport simulé — ce qui prouve la
logique, pas le dialogue avec Google.

**Modifier un événement** (`calendar_update`) reste le seul outil hors
d'atteinte, et pas par manque de règle : il exige un identifiant qui vit **chez
Google**. Le désigner demande de lire l'agenda d'abord.

**Supprimer un élément que tu désignes.** `memory_forget`, `note_delete`,
`task_cancel`, `reminder_cancel`, `entity_delete` existent. Ils exigent un
identifiant qu'une phrase ne porte pas. Désigner « cette note » demande une
résolution qui n'existe aujourd'hui que pour la **dernière** opération, via
`/annule`.

**`task_complete` et `egress_review`** : écrits, testés, et aucun chemin ne les
atteint depuis le CLI.

### 6.3 Ce qui marche à moitié

**La recherche sémantique.** Trois voies existent — structurée, lexicale,
sémantique. La troisième exige `pgvector` **et** un modèle d'embeddings. Sans
eux, Jarvis cherche quand même et **dit qu'il a cherché sans cette voie**. Il ne
rend pas une liste plus courte en silence.

**La fluidité conversationnelle : 13 sur 30.** Mesuré sur un banc de scénarios
réels. La cause est en amont : sur 8 tours de référence, aucun référent n'est
produit parce qu'aucune règle `Tier 0` ne matche l'énoncé. Le nombre décrit le
produit, pas le banc — il a été re-mesuré après correction du banc pour s'en
assurer.

**Le modèle local.** Sur ton MacBook Pro 13" 2019 (i5 1,4 GHz, 8 Go, Iris Plus
645), Ollama tourne **sur CPU seul** — aucune accélération. Plafond réaliste :
un modèle de ~3 Go. Mesure à faire avant de brancher :
`time ollama run qwen2.5:3b "Réponds uniquement par OK"`. Si c'est dix
secondes, le local ne tiendra pas une conversation — **et c'est une information,
pas un échec** : 43 % des tours aboutissent sans aucun modèle.

**Neuf modules sont hors circuit.** Écrits, testés, jamais atteints par le
produit : `context/packet.ts`, `observability/logger.ts`, `cost/gate.ts`, les
quatre de l'Update Engine, et les deux de la voix. Ce n'est pas une note à
minimiser — c'est un compteur qui mesure l'écart entre ce qui est écrit et ce
qui sert, et il **monte** quand une enveloppe de sûreté est écrite à froid.

### 6.4 Ce qui attend une décision de toi

**La migration `data_level`** (`docs/29`). Elle est écrite, corrigée, éprouvée,
et **hors du chemin du lanceur** — le placement est la garantie, pas une note
qu'on pourrait oublier de lire.

C'est **la seule migration du dépôt dont l'erreur expose une donnée**. Toutes
les autres rétrécissent ; celle-ci élargit. Elle exige une vérification ligne
par ligne de **tes** données, et ce n'est pas une décision d'agent.

Elle n'ajoute aucune protection. Tout ce qui protège est déjà là. **Rien ne
presse, et c'est exactement pour ça qu'elle attend.**

### 6.5 Les limites irréductibles — aucun code ne les lèvera

| | Pourquoi c'est impossible |
|---|---|
| Savoir si un processus est **vivant** | « gelé » et « mort » sont indiscernables de l'extérieur |
| Savoir si un exécutant périmé a produit un **effet** | le cloisonnement protège l'état interne, jamais le monde |
| **Annuler** une requête déjà partie | rien dans la pile ne l'offre |
| Déduire l'absence d'effet d'une **absence d'observation** | au moment où on regarde, il n'y a rien à voir |
| Vérifier qu'un **fournisseur dit vrai** | une réponse est une observation, jamais une preuve |

D'où la règle : **une fonctionnalité ne peut jamais être plus autonome que la
qualité de la preuve disponible sur son effet.**

### 6.6 La limite que ce document ne peut pas lever

> **Ce registre est exhaustif sur ce que je sais chercher.**

Les défauts majeurs de ce dépôt ont tous été trouvés par la **mesure**, jamais
par la relecture. Un défaut de plus existe probablement, et il ne ressemblera à
aucun des précédents.

Le motif qui revient — **quinze fois maintenant** — a toujours la même forme :

> *une affirmation que le mécanisme censé l'établir n'établit pas.*

Cette page a elle-même failli en être un exemple : `QUICKSTART.md` a affirmé
pendant trois ADR que des capacités livrées n'existaient pas encore.

---

## 7. Où en est le projet, en chiffres mesurés

```text
étendue fonctionnelle     ≈ 65 %      ce que Jarvis sait faire
profondeur de preuve      ≈ 83 %      ce qu'on peut en démontrer
```

Les afficher ensemble est la seule façon honnête de répondre : le projet a
délibérément privilégié le second.

| | Mesure |
|---|---|
| Outils écrits | **22** |
| Outils atteignables en parlant | **21** |
| Tests | le compte vit dans `docs/28` et se vérifie en lançant `pnpm test` — le figer ici garantirait qu'il se périme |
| Décisions d'architecture | **104**, chacune avec sa condition de révision |
| Documents de spécification | **30** |
| Zones d'ombre recensées | **45**, chacune avec son état |
| Modules hors circuit | **12**, chacun avec sa condition de levée |
| Coût récurrent | **0 €** — et c'est un invariant, pas une observation |

Phases : 0, 1, 2, 3 franchies avec leur porte automatisée. Phase 4 à 85 %.
Phase 5 (voix) à 15 % — la passerelle est substituable, aucun moteur n'existe. Phase 6 (interfaces) à 20 % — passerelle web oui, iOS non.
Phase 7 : la couche de décision seulement.

---

## 8. Comment vérifier tout ça sans me croire

**C'est la section la plus importante.** Un document qui se certifie lui-même ne
vaut rien.

```bash
pnpm test              # la suite entière
pnpm gate:phase0       # journal inaltérable, isolation, secrets
pnpm gate:phase1       # mémoire, contexte, ambiguïté, hors ligne
pnpm gate:phase2       # outils, idempotence, vérification, injection
pnpm gate:phase3       # enchaîne les trois et clôt la Phase 3
pnpm gate:phase7       # imprime aussi ce qui MANQUE
pnpm secrets:scan      # arbre de travail ET historique git
```

### Les épreuves qui valent mieux qu'un test vert

**Coupe PostgreSQL en pleine session**, puis demande une tâche.

```bash
brew services stop postgresql
```

Trois choses doivent se produire — et elles ont été vérifiées en exécution :
Jarvis ne meurt pas ; il **refuse d'agir** au lieu de tenter à l'aveugle
(*« La base de données est injoignable. Rien n'a été tenté. »*) ; ce qui ne
demande pas la base continue. Redémarre : il repart **sans relance**, et écrit
`DATABASE_RECOVERED` au journal. Un incident ne laisse pas de trou inexpliqué.

**Essaie de le faire mentir.** Demande « Retrouve le devis du carreleur » : il
demande **où** chercher au lieu de deviner. Demande « envoie un mail à Paul » :
il distingue « j'ai compris, la capacité n'existe pas » de « je n'ai pas
compris ». Dis « zzz flurb » : deuxième réponse, pas la première.

**Casse la passerelle web exprès.** Vide `JARVIS_WEB_TOKEN` : refus de démarrer,
avec la marche à suivre. Mets `JARVIS_WEB_HOST=0.0.0.0` : refus aussi — le joker
servirait toute interface apparaissant plus tard.

**Vérifie que le journal fait foi.** `/audit` répond depuis la chaîne
d'événements, hachée et vérifiée à chaque consultation.

### Et si quelque chose te paraît faux dans cette page

Dis-le-moi avec la phrase exacte. Chaque fois que Jarvis répond mal, **la phrase
exacte fait un bon scénario de non-régression** — c'est ainsi que le banc se
remplira de vécu plutôt que d'imaginé.

---

## 9. Le résumé honnête, en trois lignes

**Ce que tu as :** un noyau qui ne ment pas, 22 outils dont 11 utilisables en
parlant, zéro donnée qui sort, tout réversible ou refusé, et une suite de tests
qui éprouve des propriétés plutôt que des fonctionnalités.

**Ce que tu n'as pas :** la voix, l'envoi de messages, l'agenda branché, iOS, et
une fluidité de conversation qui reste à 13/30.

**Ce que ça vaut :** pas un ChatGPT vocal. Un système qui fait *moins*, et qui
peut *prouver* ce qu'il fait. Le pari du projet est que la seconde propriété
vaut plus que la première — et c'est un pari, pas un théorème.
