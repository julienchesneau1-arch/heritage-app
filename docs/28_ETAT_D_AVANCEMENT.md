# 28 — ÉTAT D'AVANCEMENT MESURÉ

**Question posée :** où en est-on par rapport à l'ensemble du pack ?

Avant le chiffre, ce qu'il vaut. Un pourcentage unique agrège des choses qui ne
s'additionnent pas — écrire dix outils et prouver qu'un bail ne ment pas ne se
mesurent pas dans la même unité. Le nombre ci-dessous est **une construction**,
pas une mesure. Ce qui est mesuré, ce sont les lignes du tableau ; la pondération
est un jugement, et il est écrit pour pouvoir être contesté.

Deux axes, parce qu'un seul mentirait :

```text
ÉTENDUE FONCTIONNELLE   ce que Jarvis sait faire        docs/02
PROFONDEUR DE PREUVE    ce qu'on peut en démontrer      docs/03·05·17·22
```

Le projet a délibérément privilégié le second. Les afficher ensemble est la
seule façon honnête de répondre.

---

## 1. Étendue fonctionnelle — **≈ 69 %**

Pondération par phase de `docs/02`. Les poids reflètent l'effort estimé, pas le
nombre de cases à cocher.

| Phase | Poids | Fait | Contribution | Constat |
|---|---|---|---|---|
| −1 Audit du terrain | 3 % | **100 %** | 3,0 | `docs/08`, `docs/10` |
| 0 Fondations | 12 % | **100 %** | 12,0 | `gate:phase0` ✅ |
| 1 Mémoire et Contexte | 12 % | **100 %** | 12,0 | `gate:phase1` ✅ — et **A2 est levé** (ADR-071/072/073) : Jarvis résout « ça » depuis le contexte récent, et **demande** dès que la lecture est ambiguë. La case de `docs/02` — « Jarvis demande » — est tenue par le produit, plus seulement par le module |
| 2 Outils et vérification | 15 % | **100 %** | 15,0 | `gate:phase2` ✅ |
| 3 Les 10 outils restants | 12 % | **100 %** | 12,0 | **15 outils sur 15** (+`egress_review`, hors liste, en Phase 4). `web_search` livré (ADR-055) — et il met en circuit la séparation Privileged/Quarantined, hors circuit depuis ADR-004 |
| 4 Confidentialité, coût, indépendance | 13 % | **85 %** | 11,1 | redaction ✅ · **Cost Engine ✅** (ADR-040) · **Data Firewall F1-F3 ✅** (ADR-050/051/052 — classification branchée, `docs/14 §6.4` passe, **console d'égression C4 ✅**) · **F4 écrite et NON appliquée** (ADR-053, `docs/29`) · **Model Router écrit, NON branché** (ADR-102) · ⚠ **« Benchmark Jarvis local » est un livrable de `docs/02` qu'aucune ligne de ce tableau n'avait jamais compté** — il est absent |
| 5 Voix | 10 % | **15 %** | 1,5 | **Passerelle audio abstraite ✅** (ADR-103) — 1 livrable sur 6, et **la porte « pipeline substituable » de `docs/02` est franchie**. Les cinq autres livrables demandent du son : VAD, activation, STT, TTS, barge-in. ⚠ **Aucun moteur audio n'existe** — les deux registres sont vides, et un test l'exige |
| 6 Interfaces | 13 % | **20 %** | 2,6 | passerelle web ✅ · **iOS ✗** |
| 7 Update Engine et LAB/Twin | 10 % | **0 %** | 0,0 | rien (`docs/07` entier) |
| **TOTAL** | 100 % | | **≈ 69 %** | |

Phase 8 est exclue du calcul : `docs/02` la conditionne à une preuve d'usage,
elle n'est donc pas un dû.

> ⚠ **CE TOTAL EST PASSÉ DE 65 À 69, ET DEUX POINTS SEULEMENT VIENNENT DU
> TRAVAIL FAIT.** Les deux autres corrigent une addition qui n'additionnait pas.
>
> ```text
> +2   correction de la somme (ci-dessous)
> +0,7 Phase 4 : le Model Router (ADR-102), moins le benchmark jamais compté
> +1,5 Phase 5 : la passerelle audio substituable (ADR-103)
> ```
>
> ```text
> colonne Contribution, telle qu'elle était publiée
>   3,0 + 12,0 + 12,0 + 15,0 + 12,0 + 10,4 + 0,0 + 2,6 + 0,0 = 67,0
> total publié en titre et en résumé                          ≈ 65 %
> ```
>
> Chaque contribution de ligne était juste — poids × fait, au dixième près.
> **C'est la somme qui était fausse**, et elle l'était depuis assez longtemps
> pour que personne ne sache quand.
>
> `coherence-des-chiffres.test.ts` existait pourtant, écrit exprès contre ce
> défaut. Il vérifiait que le total du tableau et le titre disent la **même
> chose** — et ils la disaient : tous les deux 65. Il ne vérifiait pas que cette
> chose soit **l'addition des lignes**.
>
> **Cinquième occurrence de la même forme** (ADR-054, ADR-055, ADR-057,
> ADR-058) : une affirmation que le mécanisme censé l'établir n'établit pas.
> Ici la garde tenait la cohérence entre deux copies d'un nombre faux. Le test
> qui manquait a été écrit en même temps que cette note, avec son contrôle
> négatif.

### Vérifications, pas déclarations

| Affirmation | Mesure |
|---|---|
| 15 outils sur 15 | `grep "id:" src/tools/*.ts` → `memory_add`, `memory_search`, `note_create`, `task_create`, `task_list`, `audit_query`, `task_complete`, `calendar_read`, `calendar_create`, `calendar_update`, `file_search`, `briefing_generate`, `reminder_create`, `system_status`, **`web_search`** (+ 7 hors liste : `egress_review` en Phase 4, **`memory_forget`, `note_delete`, `task_cancel`, `reminder_cancel`** avec l'Undo Engine, et **`entity_create`, `entity_delete`** avec le Context Engine sans modèle — ADR-071/072) |
| Model Router écrit, non branché | `src/core/routing/router.ts` existe ; `wiring.test.ts` le compte parmi les **douze** modules qu'aucun point d'entrée n'atteint (ADR-102) |
| Benchmark local absent | aucun fichier de `ops/` ne mesure un modèle local |
| Aucun moteur audio | `REGISTRE_STT` et `REGISTRE_TTS` sont vides, et `passerelle.test.ts` l'asserte — un moteur ajouté fera rougir ce test (ADR-103). Ni VAD, ni activation, ni barge-in |
| Update Engine absent | aucun module canary/rollback/twin |
| iOS absent | aucun répertoire |

---

## 2. Profondeur de preuve — **≈ 83 %**

C'est l'axe où l'effort est allé, et il se mesure autrement.

| Source | Mesure | Taux |
|---|---|---|
| **Invariants de sécurité S1–S15** (`docs/03`) | **10 des 15** nommément référencés dans les tests | **67 %** |
| **Tests dorés A·B·C** (`docs/05`) | **29 des 30** référencés, 1 déclaré bloqué | **97 %** |
| **Couches du banc** (`docs/22 §6`) | 5 faites, 2 partielles, 1 couverte sur 8 | **≈ 72 %** |
| **Invariants Foundation I1–I19** | 18 pleinement, I13 partiel | **≈ 95 %** |
| **Moyenne** | | **≈ 83 %** |

### Le chiffre des invariants a été faux, puis vrai, puis PÉRIMÉ — trois fois

L'histoire vaut mieux que le chiffre, parce qu'elle montre ce qui garde un
document honnête et ce qui ne le garde pas.

```text
« 9 des 15 »   hérité d'un rapport, jamais mesuré        → faux
« 7 des 15 »   MESURÉ, et vrai à cet instant             → juste
  9            le travail a nommé deux invariants de plus → la ligne 260 a
                                                            dérivé sans bruit
 10            S11 entre en Phase 7 (ADR-088)
```

**Ce qui a fait la différence n'est pas la rigueur, c'est la couverture par un
test.** Le taux du tableau ci-dessus est vérifié par
`coherence-des-chiffres.test.ts` : il n'a jamais pu dériver. La ligne du §4,
elle, n'était gardée par rien — et elle affichait « 7/15 » face à un tableau
qui disait 9, dans le même document.

> Un chiffre mesuré une fois n'est pas un chiffre juste : c'est un chiffre
> juste **à la date de la mesure**. Seul un test le maintient.

> ⚠ **ET CE PARAGRAPHE A LUI-MÊME DÉRIVÉ.** Il a continué d'annoncer « sept »
> au-dessus d'un bloc qui en listait neuf, parce que j'ai mis à jour le chiffre
> sans relire la phrase qui l'explique. Même famille, dans le document qui la
> recense.

État MESURÉ aujourd'hui — **neuf**, et le chemin y est écrit : S12 avec l'Undo
Engine (ADR-066), S13 avec l'interrupteur cloud (ADR-069).

```text
référencés   S1 · S2 · S3 · S6 · S7 · S12 · S13 · S14 · S15
absents      S4 · S5 · S8 · S9 · S10 · S11
```

**S12 a rejoint les nommés avec l'Undo Engine** (ADR-066) — sans perdre sa
réserve pour autant : `calendar_delete` reste non écrit et aucun mécanisme ne
rejoue un `STATE_RESTORE`. Gagner une capacité ne doit pas faire cesser de
surveiller ce qui manque encore, et c'est pourquoi `RESERVES` a été sorti de
`TRACES` : une réserve appartient à l'invariant, pas au tiroir où il est rangé.

Le neuf initial avait été recopié sans être revérifié — exactement la dérive que
`tests/golden/contract.test.ts` a été écrit pour rendre impossible sur
`docs/05`. **Aucun mécanisme équivalent ne protégeait `docs/03`.**

Et il faut le dire dans les deux sens : « non nommé » n'est pas « non prouvé ».
S8 (*toute sortie réseau est contrôlée par la politique*) est aujourd'hui tenu
par le Data Firewall F2 — la propriété est éprouvée, le nom manque. Un chiffre
qui compte les noms mesure la **traçabilité** de la preuve, pas son existence.
C'est précisément pour ça qu'il doit être mécanique : sinon, on ne sait plus
lequel des deux on lit.

**Le lien est désormais mécanique là aussi** (ADR-054).
`tests/security/invariants-contract.test.ts` lit `docs/03 §2`, en extrait les
quinze identifiants, et échoue si l'un n'est ni nommé, ni rattaché à une preuve
désignée, ni exempté par une absence **vérifiée**. Le taux de 67 % y est écrit
en dur : il ne peut plus dériver sans passer par ce fichier.

Une réserve y est chiffrée plutôt que fondue dans « tracé » :

| | Ce que la preuve ne couvre pas |
|---|---|
| **S12** | capture et exécution prouvées pour **quatre outils inverses sur cinq** (ADR-066/067). `calendar_delete` reste non écrit, et **ADR-070 a établi pourquoi** : la capacité manque à la frontière fournisseur, et un effacement chez autrui ne peut jamais dépasser `UNKNOWN`. Aucun mécanisme ne rejoue par ailleurs un `STATE_RESTORE` |

**S13 A QUITTÉ CE TABLEAU — ADR-069.** Il y disait : *« le cloud est éteint en
dur ; `cloud.enabled` n'a aucun effet »*. C'était le motif « CostGate » une
deuxième fois — tenu par absence, pas par mécanisme. La clé est désormais lue,
et le défaut de `config/default.json` reste `false` : ce qui change n'est pas le
comportement, c'est que le choix de l'utilisateur soit honoré.

> Un interrupteur qui n'interrompt pas est pire que pas d'interrupteur.

### Ce que la mesure a révélé sur `docs/05` — et qui est CORRIGÉ

La mesure initiale : **quatorze scénarios sur trente sans aucun test**.

```text
A2 A4 A5 A7 A8 A9 · B4 B11 B13 B14 · C3 C4 C5 C6
```

Traités en trois catégories, parce que les confondre aurait produit des tests
creux :

| | Scénarios | Ce qui a été fait |
|---|---|---|
| **écrits** | A4 · B11 · B14 | la capacité existait, le test manquait |
| **rattachés** | A5 · B13 · C5 · C6 | la propriété était déjà éprouvée ailleurs sans porter le nom |
| **déclarés bloqués** | A2 · ~~A7~~ · A8 · ~~A9~~ · B4 · C3 · ~~C4~~ | la capacité n'existe pas — les simuler ne prouverait que la simulation |

**A9 a quitté cette liste**, et c'est le mouvement qu'on attendait : `audit_query`
existe (ADR-041), donc le blocage n'a plus de motif, donc le test l'exige. Le
compteur `couverts/bloqués` est passé de 23/7 à **24/6**, puis **25/5** avec
`briefing_generate`, **26/4** avec `egress_review`, et **27/3** avec
`web_search` (ADR-055), et **28/2** avec `memory_forget` — le droit à l'oubli,
premier des cinq outils inverses écrit (ADR-065) ; trois autres ont suivi
(ADR-067). Enfin **29/1 avec A2** (ADR-073) — la résolution de référents, après
trois motifs successifs tous tombés.

**Et surtout, le lien est désormais MÉCANIQUE.**
`tests/golden/contract.test.ts` lit `docs/05`, en extrait les identifiants, et
échoue si l'un n'est ni référencé ni déclaré bloqué avec un motif. Écrire les
tests manquants n'aurait pas suffi : la dérive aurait recommencé au prochain
scénario ajouté.

Deux contrôles négatifs protègent l'extracteur — dont celui du mode de panne le
plus dangereux : **rendre zéro identifiant et déclarer la couverture
parfaite.**

### La Phase 1 n'était pas à 100 %, et la porte ne le disait pas

**CINQUIÈME occurrence de la même famille**, trouvée en cherchant s'il restait
une zone d'ombre avant de continuer.

`docs/02` liste parmi les livrables de la Phase 1 : « Context Engine :
résolution … **détection d'ambiguïté** ». Sa porte de sortie coche « Face à
trois « Pierre » connus, **Jarvis** demande — il ne choisit pas. »

Or `ops/gates/phase1.ts` appelle `createEntityResolver` **directement**. Son
propre libellé est honnête — « **le résolveur** demande » — mais la case du
document dit **Jarvis**. La porte éprouve un module ; la case promet un
comportement produit.

Et le module n'a rien à résoudre : `entities` n'est alimentée par **aucun**
`INSERT` de `src/`, et les deux appelants de `appendTurn` omettent
`mentionedEntityIds`. Détail en `docs/26 §4.12`.

**L'étendue fonctionnelle mesure ce que Jarvis SAIT FAIRE.** La phase passe donc
à 90 %, et le total de 65 % à 64 %.

> Une porte qui éprouve un module ne franchit pas une phase dont le livrable est
> un comportement. Les deux ne se confondent que si on lit vite.

### TROISIÈME dérive de la même famille : un CRITIQUE compté par collision

`docs/05 §C2` — **Arrêt d'urgence**, `CRITIQUE` — figurait dans les 27/30.
Aucune capacité de ce genre n'existait.

Le compteur cherchait `\bC2\b`. Le seul « C2 » du dépôt vivait dans
`intent-journal.test.ts` : « matrice adversariale **ligne C2** », la ligne d'un
tout autre tableau. **Un identifiant de deux caractères est trop court pour
valoir preuve.**

La reconnaissance exige désormais un rattachement (`05/C2`, `**C2**`, titre de
test). Et la première version de la règle était **trop stricte** — elle perdait
`B3`, cité dans « scénarios 05/B1, B2, B3, B10 » : un filtre qui resserre trop
invente des trous et fait perdre confiance dans les vrais.

**C2 est désormais ÉCRIT**, pas déclaré bloqué (ADR-057) : l'arrêt d'urgence ne
dépend d'aucun fournisseur, donc rien ne justifiait de le différer.

> ⚠ **Le chiffre n'a pas bougé — sa VÉRITÉ, si.** Avant comme après, ce
> document affiche 27/30. Avant, C2 y entrait par une collision de chaîne ;
> après, par un fichier de seize tests. Un compteur peut rester identique
> pendant qu'on répare ce qu'il compte, et c'est précisément pour ça qu'un
> chiffre seul ne dit rien — il faut savoir ce qu'il mesure.

### Ce document a affirmé une garantie que le test ne donnait PAS

Il écrivait, à propos de ce compteur : « il aurait échoué si on avait livré
l'outil sans retirer l'entrée ». **C'était faux, et mesuré comme tel** en
livrant `web_search` :

```text
couverts = ids.length - bloques          ← ne lit pas le code
bloques  = Object.keys(BLOQUES).length   ← ne lit pas le code
```

Les deux assertions se calculent uniquement à partir de la table des blocages.
Laisser `B4` déclaré bloqué après avoir écrit l'outil laissait le test **vert**.

C'est la **même classe de défaut que le « 9 des 15 »** — une affirmation sur un
mécanisme que le mécanisme ne fournit pas — et la deuxième occurrence en deux
sprints, sur deux documents différents. Le motif mérite d'être nommé :

> Quand on écrit qu'un test garantit quelque chose, il faut **saboter le code**
> pour le vérifier. Lire le test ne suffit pas : on y lit ce qu'on croit y avoir
> mis.

**Corrigé** (ADR-055) : chaque entrée bloquée déclare ce qui doit rester
**absent** — la capacité n'est pas dans le registre des outils, ou le module
figure encore parmi les orphelins de `wiring.test.ts` — et le test le vérifie.
Un sabotage le confirme : réintroduire `B4` alors que `webSearchTool` est
enregistré fait rougir le test **en le nommant**.

---

## 3. Ce que le chiffre ne mesure pas

| | |
|---|---|
| **La qualité de ce qui est fait** | aucun pourcentage d'étendue ne dit si le noyau est solide. Neuf défauts majeurs ont été trouvés et corrigés par la mesure ; le dixième existe. |
| **La difficulté restante** | la Phase 5 (voix) est plus longue que la Phase 3, à poids presque égal. |
| **Le travail hors plan** | `docs/17` à `docs/27` — banc de défaillance, chaos, deux mondes — ne figurent dans aucune phase de `docs/02`. Onze documents et 149 tests de banc n'entrent dans aucune part du total. |
| **Ce qui est irréductible** | `docs/26 §5` — six limites qu'aucun pourcentage ne fera bouger. |

Le troisième point mérite d'être lu deux fois : **le plan d'exécution n'a jamais
prévu le travail de preuve qui a occupé l'essentiel des derniers sprints.** Le
mesurer contre `docs/02` le fait donc disparaître.

---

## 4. État par document

| # | Document | État |
|---|---|---|
| 00 | Master vision | **ratifiée**, non contredite |
| 01 | ADR | **104 ADR**, chacune avec sa condition de révision |
| 02 | Plan d'exécution | phases −1→2 franchies ; **Phase 3 FRANCHIE — et désormais VÉRIFIABLE** par `pnpm gate:phase3` (ADR-087). Elle était déclarée « COMPLÈTE (10/10) » **sans porte de sortie** : le chiffre comptait des outils écrits, pas les trois conditions de `docs/02`. La porte existe, elle passe — l'affirmation était juste, mais sans preuve ; 4→7 ouvertes |
| 03 | Sécurité et confidentialité | invariants posés ; **10/15 nommés en test** (67 %) — S11 y entre en Phase 7, et par le bon chemin : son exemption portait sa condition de fin (`absent: 'src/core/update'`), qui a rougi le jour où ce répertoire a existé. **Zéro exemption restante.** ⚠ Cette ligne a affiché « 7/15 » face à un tableau qui disait 9, dans le même document. Elle n'avait pas menti : elle était vraie à la date de sa mesure, et le travail a nommé deux invariants de plus sans qu'elle bouge. La ligne 62 est gardée par `coherence-des-chiffres.test.ts` ; celle-ci ne l'était par rien — c'est toute la différence (§2) |
| 04 | Dépendances et coût | **CostGate écrit et testé** (ADR-040) mais **sans appelant** — aucun fournisseur cloud ne l'appelle encore ; le 0 € reste donc tenu par absence de dépense, avec le mécanisme prêt AVANT le premier appel payant. `wiring.test.ts` signalera l'oubli de branchement. **Model Router écrit** (ADR-102), non branché pour un motif distinct : arbitrer entre un seul candidat n'est pas arbitrer. Le §11 — l'indépendance — est tenu par le type : le noyau ne nomme aucun modèle |
| 05 | Tests dorés | **29/30 référencés**, 1 bloqué déclaré — lien mécanique, et chaque blocage prouve désormais que ce qui manque manque ENCORE (ADR-055) |
| 06 | Prompt maître | appliqué à chaque session |
| 07 | Update Engine | **spécifié, rien d'implémenté** |
| 08·09·10·11 | Audits | faits, conclusions intégrées |
| 12 | Vérité et traçabilité | **le journal est interrogeable** (`audit_query`, ADR-041) — la promesse est tenue, pas seulement écrite |
| 13·15 | Menace, fournisseurs | posés et appliqués |
| 14 | Classification des données | **F1 à F3 livrées** : classification branchée, **§6.4 passe**, console d'égression écrite. **F4 — la migration des colonnes — est écrite, testée, et NON appliquée** : c'est la seule du dépôt dont l'erreur expose une donnée, et `§5` exige une relecture humaine ligne par ligne (ADR-053, marche à suivre en `docs/29`) |
| 16 | Capacités de vérification | appliqué, **sauf §3 périmé** : sa règle « aucun EXTERNAL avec `attemptVerification: NONE` » a été remplacée par ADR-030 (`docs/26 §4.6`) |
| 17·18 | Défaillances réelles | **banc complet**, mesures publiées |
| 19 | `PARTIAL` et routage | **spécifié, non branché** |
| 20·21 | Chaos, bail adversarial | faits |
| 22 | Conception du banc | **5 couches sur 8** |
| 23·24·25 | Horloge, cloisonnement, bail | faits, avec sabotage |
| 26 | Registre des zones d'ombre | tenu à jour ; **§4.5 LEVÉE** (ADR-051), **§4.9 créée** par cette levée — `capabilities.local` est cru, pas vérifié ; §4.6 à §4.8 ouvertes — `egress` est un booléen là où il y a deux questions ; `CalendarProvider` ne peut pas vérifier une tentative ; la fenêtre lecture↔écriture chez un fournisseur ne se ferme pas ; la composition d'outils n'est pas éprouvée |
| 27 | Deux mondes | fait |
| 29 | Migration `DataLevel` | **marche à suivre écrite** — une décision humaine attendue, et une seule |

---

## 5. Les trois prochains pas, par valeur décroissante

| | Pourquoi celui-là |
|---|---|
| ~~1. Nommer les scénarios dorés manquants~~ | **FAIT** — 24/30 référencés, 6 bloqués déclarés, lien mécanique |
| ~~1. Cost Engine + budget~~ | **FAIT** — ADR-040. Le mécanisme existe AVANT le premier appel payant ; il n'a encore aucun appelant, donc le 0 € reste tenu par absence de dépense (cf. ligne 04 ci-dessus). Le **Model Router** reste à écrire. |
| ~~1. `audit_query`~~ | **FAIT** — ADR-041. Le journal est interrogeable ; **A9** est sorti de la liste des bloqués. |
| ~~1. `task_complete`~~ | **FAIT** — ADR-042. Premier outil qui MODIFIE : la capture d'annulation y devient une restauration de l'état OBSERVÉ, et le validateur de contrat a corrigé au passage un `NATURALLY_IDEMPOTENT` de trop (S6). |
| ~~1. `calendar_read`~~ | **FAIT** — ADR-043, sans adaptateur. A surtout fait CHANGER DE FONDATION l'invariant S2 : deux tests de red team tenaient par absence d'outil réseau, ils tiennent désormais par le refus. |
| ~~1. `calendar_create`~~ | **FAIT** — ADR-044. **Premier effet EXTERNE du dépôt** : la machinerie de contrats d'effet, jusque-là exercée par le seul banc, porte enfin du code de production. |
| ~~1. `calendar_update`~~ | **FAIT** — ADR-045. ADR-042 transposé hors de PostgreSQL : le fournisseur déclare ce qu'il a remplacé, et le sabotage a trouvé un **test manquant chez moi** — une barrière peut pourrir sans bruit derrière une autre. |
| ~~1. `file_search`~~ | **FAIT** — ADR-046. Premier accès disque, sous racine autorisée. Le sabotage a aussi trouvé un test **muet sous root** — une assertion vraie seulement sur certaines machines n'est pas une preuve. |
| ~~1. `briefing_generate`~~ | **FAIT** — ADR-047. **A7 débloqué** (25/5). Un briefing partiel se déclare partiel ; et la suite complète a trouvé un tri **non déterministe** que le test isolé ne voyait pas. |
| ~~1. `reminder_create` + `system_status`~~ | **FAIT** — ADR-048, ADR-049. Rien ne sonne dans ce dépôt : le rappel le DIT et se présente dans le briefing. Et `system_status` se comptait lui-même comme opération en suspens — l'observateur dans ce qu'il observe, trouvé par son premier test. |
| ~~1. Data Firewall F2~~ | **FAIT** — ADR-051. `docs/14 §6.4` passe. A levé `docs/26 §4.5` et créé `§4.9` : le solde est positif, pas nul. |
| ~~2. Data Firewall F3~~ | **FAIT** — ADR-052. **C4 débloqué** (26/4). Un sabotage y a révélé que la couverture de l'égression par le hachage n'était testée par rien. |
| **1. `web_search`** (Phase 3, dernier outil) | Le Data Firewall existe désormais : le seul outil restant de Phase 3 n'est plus bloqué. |
| ~~2. Model Router~~ (Phase 4) | **FAIT** — ADR-102, et il ne choisit PAS « le moins cher ». Il trie local d'abord, puis latence : le coût donnerait le même résultat aujourd'hui et le mauvais le jour où un cloud gratuit apparaîtrait. Le budget reste au CostGate, qui reçoit une `allowance` déjà tranchée. ⚠ **Non branché** — dixième module hors circuit, délibérément. |
| **3. Câbler le Context Engine** | débloque **A2**, dernier blocage qui ne dépende d'aucun outil manquant. |
| **2. Câbler le Context Engine** | débloque **A2**, et tient la promesse de levée d'ambiguïté du `QUICKSTART`. |
| ~~3. Model Router~~ (Phase 4) | **FAIT** — ADR-102. L'ordre de `docs/14 §4` est respecté, et il est la propriété : capacité → confidentialité → politique → disponibilité, sans rattrapage possible. `docs/15 §R4` tenu — un modèle non autorisé n'existe pas comme repli. |
| ~~2. Câbler le Context Engine~~ | **FAIT** — ADR-071 à ADR-073. **A2 débloqué** (29/30), et **sans modèle** : trois causes sont tombées l'une après l'autre. |
| ~~1. Résolution de dates~~ | **FAIT** — ADR-077. Le verrou réel du cas d'usage de Julien : il bloquait `reminder_create` ET les trois outils d'agenda. Levé **sans modèle** — le `Tier 0` reconnaît, PostgreSQL calcule. Surface parlée : **11 outils sur 22**. |
| ~~2. Adaptateur Google Agenda~~ | **ÉCRIT** — ADR-078, **zéro dépendance npm**. Premier fournisseur réseau du dépôt : idempotence par identifiant dérivé, fenêtre lecture/écriture fermée par etag, secrets au coffre. ⚠ **Jamais exécuté contre l'API réelle** — aucun compte connecté. |
| **2. Connecter un compte Google** | trois secrets au coffre, puis DEUX appels réels à provoquer : un etag sur `events.get`, un `412` sur `If-Match` périmé. C'est ce qui lèvera la moitié restante de `docs/26 §4.7`. |
| **3. Câbler l'agenda à la parole** | les outils d'agenda existent et la résolution de dates aussi (ADR-077), mais aucune règle `Tier 0` ne les atteint. « qu'ai-je demain ? » reste hors surface parlée. |
| ~~4. `Tier 1` — l'enveloppe de sûreté~~ | **ÉCRITE** — ADR-081. Chaque paramètre `MODEL_OUTPUT` → le Policy Gate force `L4` → confirmation sur la VALEUR. Schéma de frontière pauvre, `userConfirms` cloué à `false`, outil vérifié contre le catalogue réel. ⚠ **Aucun modèle branché** : `tier1: null`, quatrième module hors circuit, délibérément. |
| **4. Un `ModelProvider` LOCAL** | le dernier verrou de la fluidité. L'enveloppe l'attend ; il n'y a plus qu'à écrire l'adaptateur (Ollama en référence, ADR-007) et à choisir un modèle. C'est ce qui fera passer les 43 % d'ADR-080. |
| ~~3. Contrat du tour de parole~~ | **FAIT** — ADR-074. `ecouter()` est branché ; `accuseReception` est écrit et **déclaré sans appelant**, en attente d'une surface où l'attente existe. Le pipeline audio, lui, reste entier. |
| ~~1. Audio Gateway abstrait~~ (Phase 5) | **FAIT** — ADR-103. La porte « pipeline substituable » de `docs/02` est franchie, et R1 d'ADR-093 est devenue du code : `transcrire` refuse tout état de micro autre que `TRANSCRIT`. ⚠ **Non branché**, et aucun moteur n'existe. |
| ~~1. Câbler l'arrêt d'urgence~~ | **FAIT** — ADR-104. `docs/05 §C2` est le seul scénario doré `CRITIQUE` dont l'entrée est une phrase, et cette phrase n'atteignait **rien** : `halt.ts` existait depuis ADR-057, le Tool Gateway l'honorait, et `engage()` n'avait aucun appelant. ⚠ L'usage a aussi trouvé une phrase de MOI qui promettait plus que le mécanisme ne tient. |
| **1. « Annule » depuis le téléphone** | même forme que le défaut ci-dessus, sur l'Undo Engine : le CLI reconnaît « annule la dernière action » (ADR-066), `assistant.say()` non — donc la passerelle web non plus. La capacité existe et le téléphone ne l'atteint pas. |
| **2. Un moteur STT local** (Phase 5) | le verrou réel de la voix. `docs/02` veut « STT fonctionnel réseau coupé » ; la passerelle le refuse déjà s'il n'est pas local. Fiche `docs/04` obligatoire — un moteur audio est une dépendance, même livré en binaire. |
| **2. Connecter un compte Google** | inchangé depuis ADR-078 : trois secrets au coffre, et deux appels réels à provoquer. C'est le seul verrou restant de `calendar_update`, dernier outil hors surface parlée. |
| **3. Relire la migration `data_level`** | `docs/29`, ligne par ligne. C'est la seule migration du dépôt dont une erreur EXPOSE une donnée, et `docs/14 §5` exige une relecture humaine. Elle ferme les 15 % restants de la Phase 4 avec le benchmark local. |

La voix, l'iOS et l'Update Engine viennent après : chacun est un chantier
entier.

> ⚠ **CETTE PHRASE DISAIT « et aucun ne renforce ce qui existe ». ADR-074 l'a
> démentie**, et c'est mon propre commit qui l'a fait — raison de plus pour la
> corriger plutôt que de la laisser.
>
> Le **contrat du tour de parole** a renforcé la boucle texte avant tout audio :
> `ecouter()` est désormais la porte unique par laquelle un énoncé devient une
> action, à la place d'un `trim()` suivi d'un test de vide. Et la mesure du
> chantier voix a falsifié l'intuition qui le rendait effrayant — « vérifié,
> donc lent » : la chaîne de Jarvis coûte **0,0046 ms** au Tier 0, contre des
> centaines de millisecondes pour la transcription et la synthèse.
>
> Ce qui restait vrai jusqu'à ADR-103 : le **pipeline audio** (VAD, activation,
> STT, TTS, barge-in, Audio Gateway) était un chantier entier et n'existait pas.
>
> **Une sixième part existe désormais** — la passerelle abstraite, et avec elle
> la porte de sortie « substituable ». Les cinq autres demandent du son, et
> aucun moteur n'est installé : `REGISTRE_STT` et `REGISTRE_TTS` sont vides, et
> un test l'exige plutôt que de l'espérer.

---

## 6. Le chiffre, en une ligne

```text
ÉTENDUE FONCTIONNELLE   ≈ 69 %     ce que Jarvis sait faire
PROFONDEUR DE PREUVE    ≈ 83 %     ce qu'on peut en démontrer
```

> ⚠ **CETTE SECTION A CONTREDIT LE RESTE DU DOCUMENT.** Elle affichait encore
> 64 % / 80 % quand les §1 et §2 disaient 65 % et 76 % : les corrections
> d'ADR-054 et ADR-055 avaient touché les sections, pas le résumé.
>
> Quatrième occurrence du même motif — **un chiffre en prose que rien ne relie
> au reste**. `tests/architecture/coherence-des-chiffres.test.ts` lie désormais
> ce bloc aux deux en-têtes : ils ne peuvent plus diverger sans faire rougir la
> CI (ADR-058).

Et la phrase qui les relie, qui n'a pas changé depuis le début :

> Une fonctionnalité ne peut jamais être plus autonome que la qualité de la
> preuve disponible sur son effet.

Les deux chiffres ci-dessus sont dans cet ordre — la preuve devant l'étendue —
et c'est l'ordre qu'on veut. L'inverse aurait été inquiétant.

> ⚠ **CETTE PHRASE RÉPUBLIAIT « 64 % et 80 % »**, une troisième copie périmée
> de deux révisions, à huit lignes du bloc qui dit les vrais chiffres. Elle
> échappait à la garde d'ADR-058 parce que celle-ci lit un format précis, pas
> de la prose. Un chiffre qu'on peut lire ailleurs n'a pas à être recopié : la
> phrase dit désormais la RELATION, qui, elle, ne se périme pas.
