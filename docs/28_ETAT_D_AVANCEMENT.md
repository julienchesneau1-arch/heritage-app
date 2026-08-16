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

## 1. Étendue fonctionnelle — **≈ 51 %**

Pondération par phase de `docs/02`. Les poids reflètent l'effort estimé, pas le
nombre de cases à cocher.

| Phase | Poids | Fait | Contribution | Constat |
|---|---|---|---|---|
| −1 Audit du terrain | 3 % | **100 %** | 3,0 | `docs/08`, `docs/10` |
| 0 Fondations | 12 % | **100 %** | 12,0 | `gate:phase0` ✅ |
| 1 Mémoire et Contexte | 12 % | **100 %** | 12,0 | `gate:phase1` ✅ |
| 2 Outils et vérification | 15 % | **100 %** | 15,0 | `gate:phase2` ✅ |
| 3 Les 10 outils restants | 12 % | **10 %** | 1,2 | **6 outils sur 15** ; `audit_query` ✅ (ADR-041) — 9 restants |
| 4 Confidentialité, coût, indépendance | 13 % | **45 %** | 5,9 | égression ✅ · redaction ✅ · **Cost Engine ✅** (ADR-040) · **Model Router ✗** |
| 5 Voix | 10 % | **0 %** | 0,0 | rien |
| 6 Interfaces | 13 % | **20 %** | 2,6 | passerelle web ✅ · **iOS ✗** |
| 7 Update Engine et LAB/Twin | 10 % | **0 %** | 0,0 | rien (`docs/07` entier) |
| **TOTAL** | 100 % | | **≈ 52 %** | |

Phase 8 est exclue du calcul : `docs/02` la conditionne à une preuve d'usage,
elle n'est donc pas un dû.

### Vérifications, pas déclarations

| Affirmation | Mesure |
|---|---|
| 6 outils sur 15 | `grep "id:" src/tools/*.ts` → `memory_add`, `memory_search`, `note_create`, `task_create`, `task_list`, `audit_query` |
| Model Router absent | aucun fichier de `src/` ne contient « router » |
| Voix absente | aucun module STT/TTS/VAD |
| Update Engine absent | aucun module canary/rollback/twin |
| iOS absent | aucun répertoire |

---

## 2. Profondeur de preuve — **≈ 76 %**

C'est l'axe où l'effort est allé, et il se mesure autrement.

| Source | Mesure | Taux |
|---|---|---|
| **Invariants de sécurité S1–S15** (`docs/03`) | 9 des 15 nommément référencés dans les tests | **60 %** |
| **Tests dorés A·B·C** (`docs/05`) | **24 des 30** référencés, 6 déclarés bloqués | **80 %** |
| **Couches du banc** (`docs/22 §6`) | 5 faites, 2 partielles, 1 couverte sur 8 | **≈ 72 %** |
| **Invariants Foundation I1–I19** | 18 pleinement, I13 partiel | **≈ 95 %** |
| **Moyenne** | | **≈ 77 %** |

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
| **déclarés bloqués** | A2 · A7 · A8 · ~~A9~~ · B4 · C3 · C4 | la capacité n'existe pas — les simuler ne prouverait que la simulation |

**A9 a quitté cette liste**, et c'est le mouvement qu'on attendait : `audit_query`
existe (ADR-041), donc le blocage n'a plus de motif, donc le test l'exige. Une
dette datée qui ne peut pas être oubliée quand elle est payée — le compteur
`couverts/bloqués` du test est passé de 23/7 à **24/6**, et il aurait échoué si
on avait livré l'outil sans retirer l'entrée.

**Et surtout, le lien est désormais MÉCANIQUE.**
`tests/golden/contract.test.ts` lit `docs/05`, en extrait les identifiants, et
échoue si l'un n'est ni référencé ni déclaré bloqué avec un motif. Écrire les
tests manquants n'aurait pas suffi : la dérive aurait recommencé au prochain
scénario ajouté.

Deux contrôles négatifs protègent l'extracteur — dont celui du mode de panne le
plus dangereux : **rendre zéro identifiant et déclarer la couverture
parfaite.**

---

## 3. Ce que le chiffre ne mesure pas

| | |
|---|---|
| **La qualité de ce qui est fait** | 52 % ne dit pas si le noyau est solide. Neuf défauts majeurs ont été trouvés et corrigés par la mesure ; le dixième existe. |
| **La difficulté restante** | la Phase 5 (voix) est plus longue que la Phase 3, à poids presque égal. |
| **Le travail hors plan** | `docs/17` à `docs/27` — banc de défaillance, chaos, deux mondes — ne figurent dans aucune phase de `docs/02`. Onze documents et 149 tests de banc n'entrent pas dans les 48 %. |
| **Ce qui est irréductible** | `docs/26 §5` — six limites qu'aucun pourcentage ne fera bouger. |

Le troisième point mérite d'être lu deux fois : **le plan d'exécution n'a jamais
prévu le travail de preuve qui a occupé l'essentiel des derniers sprints.** Le
mesurer contre `docs/02` le fait donc disparaître.

---

## 4. État par document

| # | Document | État |
|---|---|---|
| 00 | Master vision | **ratifiée**, non contredite |
| 01 | ADR | **41 ADR**, chacune avec sa condition de révision |
| 02 | Plan d'exécution | phases −1→2 franchies ; **Phase 3 ouverte** (1 outil sur 10) ; 4→7 ouvertes |
| 03 | Sécurité et confidentialité | invariants posés ; **9/15 nommés en test** |
| 04 | Dépendances et coût | **CostGate écrit** (ADR-040) ; 0 € tenu par MÉCANISME, plus par absence ; Model Router absent |
| 05 | Tests dorés | **24/30 référencés**, 6 bloqués déclarés — lien mécanique |
| 06 | Prompt maître | appliqué à chaque session |
| 07 | Update Engine | **spécifié, rien d'implémenté** |
| 08·09·10·11 | Audits | faits, conclusions intégrées |
| 12 | Vérité et traçabilité | **le journal est interrogeable** (`audit_query`, ADR-041) — la promesse est tenue, pas seulement écrite |
| 13·14·15·16 | Menace, données, fournisseurs, vérification | posés et appliqués |
| 17·18 | Défaillances réelles | **banc complet**, mesures publiées |
| 19 | `PARTIAL` et routage | **spécifié, non branché** |
| 20·21 | Chaos, bail adversarial | faits |
| 22 | Conception du banc | **5 couches sur 8** |
| 23·24·25 | Horloge, cloisonnement, bail | faits, avec sabotage |
| 26 | Registre des zones d'ombre | tenu à jour |
| 27 | Deux mondes | fait |

---

## 5. Les trois prochains pas, par valeur décroissante

| | Pourquoi celui-là |
|---|---|
| ~~1. Nommer les scénarios dorés manquants~~ | **FAIT** — 24/30 référencés, 6 bloqués déclarés, lien mécanique |
| ~~1. Cost Engine + budget~~ | **FAIT** — ADR-040. Le 0 € est désormais tenu par mécanisme. Le **Model Router** reste à écrire. |
| ~~1. `audit_query`~~ | **FAIT** — ADR-041. Le journal est interrogeable ; **A9** est sorti de la liste des bloqués. |
| **1. Les 9 outils restants** (Phase 3) | `briefing_generate` débloque **A7**, un outil d'email débloque **A8**, `web_search` débloque **B4**, `memory_forget` débloque **C3**. Quatre des six blocages restants sont dans cette phase. |
| **2. Câbler le Context Engine** | débloque **A2**, et tient la promesse de levée d'ambiguïté du `QUICKSTART`. |
| **3. Model Router** (Phase 4) | choisir le moins cher **parmi les éligibles** — l'ordre de `docs/14 §4` devra y être respecté, et c'est le point à ne pas manquer. |

La voix, l'iOS et l'Update Engine viennent après : chacun est un chantier
entier, et aucun ne renforce ce qui existe.

---

## 6. Le chiffre, en une ligne

```text
ÉTENDUE FONCTIONNELLE   ≈ 52 %     ce que Jarvis sait faire
PROFONDEUR DE PREUVE    ≈ 77 %     ce qu'on peut en démontrer
```

Et la phrase qui les relie, qui n'a pas changé depuis le début :

> Une fonctionnalité ne peut jamais être plus autonome que la qualité de la
> preuve disponible sur son effet.

Un projet à 52 % d'étendue et 77 % de preuve est exactement dans le bon ordre.
L'inverse aurait été inquiétant.
