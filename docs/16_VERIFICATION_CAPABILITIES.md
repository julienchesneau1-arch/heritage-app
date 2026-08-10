# 16 — CAPACITÉS DE VÉRIFICATION DES OUTILS

**Foundation 2.2.** Le modèle est spécifié ; une partie est **déjà en vigueur**
(ADR-027). Ce document dit précisément laquelle.

---

## 1. Ce que chaque outil doit déclarer

Cinq propriétés, et la règle qui les gouverne toutes :

> **Un outil ne peut jamais déclarer une capacité de vérification qu'il ne
> possède pas réellement.**

C'est la même discipline que `CONFIRMED` : déclarer, puis **vérifier
structurellement**, jamais faire confiance.

| Propriété | Répond à | En vigueur ? |
|---|---|---|
| `effect` | l'effet est-il **local** ou **externe** ? | ❌ spécifié, §5 |
| `verification` | comment relire l'état réel après coup ? | ✅ `NONE` · `READ_BACK` · `PROVIDER_PROOF` |
| `attemptVerification` | sait-il dire si une TENTATIVE a eu un effet ? | ✅ ADR-027 |
| `idempotency` | rejouer produit-il un doublon ? | ✅ `OPERATION_KEY` · `NATURALLY_IDEMPOTENT` |
| `recoveryPolicy` | que faire d'une opération restée en suspens ? | ◐ implicite, §4 |
| `unknownPolicy` | que dire, et que refuser, en cas d'ignorance ? | ✅ `FAIL CLOSED`, uniforme |

---

## 2. La différence qui compte : `verification` vs `attemptVerification`

Elle est subtile et coûteuse à confondre.

```text
verification         « L'action a eu lieu. Le monde est-il conforme ? »
                     → suppose qu'on connaît la RESSOURCE produite

attemptVerification  « Ai-je seulement lancé cette action ? »
                     → ne dispose que de la CLÉ D'OPÉRATION
```

Après un crash pendant l'appel, on n'a **pas** l'identifiant de la ressource :
on ne l'a jamais reçu. `verification` est donc inutilisable, et seul
`attemptVerification` peut trancher. C'est exactement pourquoi les deux sont
séparés — et pourquoi un outil peut être excellent sur l'un et nul sur l'autre.

---

## 3. La grille cible

| Outil | `effect` | `verification` | `attemptVerification` | Idempotence |
|---|---|---|---|---|
| `memory_add` | LOCAL | `READ_BACK` | `NONE` ⚠ | clé d'opération |
| `memory_search` | LOCAL | `NONE` (lecture) | sans objet | naturelle |
| `task_create` | LOCAL | `READ_BACK` | `NONE` ⚠ | clé d'opération |
| `task_list` | LOCAL | `NONE` (lecture) | sans objet | naturelle |
| `note_create` | LOCAL | `READ_BACK` | `NONE` ⚠ | clé d'opération |
| *futur* `email.send` | **EXTERNE** | `PROVIDER_PROOF` | **`BY_OPERATION_KEY` exigé** | clé d'opération |
| *futur* `calendar.create` | **EXTERNE** | `READ_BACK` | `BY_RESOURCE` | clé d'opération |
| *futur* `payment.create` | **EXTERNE** | `PROVIDER_PROOF` | **`BY_PROVIDER_REFERENCE` exigé** | clé d'opération |
| *futur* `file.write` | LOCAL | `READ_BACK` | `BY_HASH` | clé d'opération |

### La règle que cette grille impose

> **Aucun outil `effect: EXTERNAL` ne peut être enregistré avec
> `attemptVerification: NONE`.**

Un effet externe non vérifiable après coup est exactement le double virement
qu'ADR-027 cherche à empêcher. Pour un effet **local**, `NONE` reste
acceptable : la base est transactionnelle, et une reprise peut relire.

C'est la garde structurelle à ajouter en même temps que `effect` — pas avant,
pas après.

---

## 4. Politique de reprise, par état

Déjà en vigueur (ADR-027). Rappelée ici parce que c'est là qu'on la cherchera.

| État retrouvé | Conclusion | Conduite |
|---|---|---|
| aucune ligne | aucun appel n'a été lancé — garanti par l'écriture préalable | exécuter |
| `PLANNED` | idem | exécuter |
| `COMMITTED_TO_EXECUTION` | l'appel n'était pas parti | exécuter |
| `EXECUTING` | **un effet est possible** | vérifier la tentative ; jamais rejouer |
| `SUCCEEDED` | terminée | relire l'état réel |
| `FAILED` | terminée | relire l'état réel |
| `UNKNOWN` | **un effet est possible** | vérifier la tentative ; jamais rejouer |

Et depuis `EXECUTING` ou `UNKNOWN` :

| Verdict du fournisseur | Conduite |
|---|---|
| `EFFECT_CONFIRMED` | `CONFIRMED`, **sans réexécution** |
| `NO_EFFECT` | seul chemin qui rouvre l'exécution — exige une affirmation **positive** |
| `INCONCLUSIVE` ou aucune vérification | `UNKNOWN`, et Jarvis le dit |

---

## 5. Politique d'ignorance — `unknownPolicy`

Uniforme, et volontairement non configurable par outil :

```text
UNKNOWN → STOP
```

Aucun outil ne peut déclarer une politique plus permissive. Un outil qui
souhaiterait « réessayer automatiquement en cas d'ignorance » demanderait
exactement ce que `docs/13 §6` interdit.

Ce que l'outil peut faire, c'est **fournir de quoi lever l'ignorance** — via
`verifyAttempt`. C'est la seule voie ouverte, et elle va dans le bon sens :
elle transforme un doute en information au lieu de l'écraser.

Les six raisons d'ignorance (`UnknownReason`) servent à **choisir la phrase et
la question**, jamais à contourner le refus :

| Raison | Ce que Jarvis dit | Atteignable ? |
|---|---|---|
| `NO_OBSERVATION` | « l'action est partie, je n'ai rien pu constater » | ✅ |
| `PROVIDER_TIMEOUT` | « le fournisseur n'a pas répondu ; il a pu traiter » | ✅ |
| `PROCESS_CRASH` | « je me suis arrêté pendant l'appel » | ✅ |
| `EXTERNAL_STATE` | « le fournisseur répond, mais ne tranche pas » | ✅ |
| `VERIFICATION_UNAVAILABLE` | « cet outil ne sait pas vérifier après coup » | ✅ |
| `CONFLICTING_EVIDENCE` | « deux observations se contredisent » | ❌ **non atteignable** — une seule source d'observation par outil aujourd'hui |

---

## 6. Deux dettes nommées

### `attemptVerification: NONE` sur les cinq outils

Honnête et temporaire. Un crash en cours d'appel les laisse en `UNKNOWN` :
jamais de doublon, mais jamais de verdict non plus.

**Ce qu'il faudrait :** que chaque outil écrive la clé d'opération dans la
ressource qu'il crée (`tasks.operation_id`, `notes.operation_id`,
`memories.operation_id`). `verifyAttempt` deviendrait alors un simple
`SELECT ... WHERE operation_id = $1`, et les trois outils mutants passeraient à
`BY_OPERATION_KEY`.

Coût estimé : une migration, trois `INSERT` modifiés, trois `verifyAttempt` de
cinq lignes. **Non fait** : hors du mandat Foundation 2.2, qui exclut les
fonctionnalités.

### `maxRetries` déclaré et lu par personne

Un champ obligatoire du contrat que **rien ne consomme**. C'est un piège : un
développeur finira par l'honorer en croyant réparer un oubli, et introduira le
rejeu automatique que tout le reste interdit.

**Recommandation : le RETIRER du contrat.** Le jour où une politique de
tentatives sera définie, elle s'écrira avec sa sémantique d'`UNKNOWN`, et pas
en réveillant un champ dormant.

En attendant, `tests/redteam/fail-closed.test.ts` vérifie qu'il est déclaré et
jamais lu.

---

## 7. Tests — état réel

| Propriété | État | Preuve |
|---|---|---|
| Un outil ne peut pas déclarer `BY_OPERATION_KEY` sans `verifyAttempt` | ✅ | refusé à l'**enregistrement** — `redteam/fail-closed`, `intent-journal` |
| Un outil L0 ne peut pas exister | ✅ | `redteam/authority` |
| Une mutation ne peut pas déclarer `verification: NONE` | ✅ | `validateDefinition` |
| Une mutation ne peut pas se dire naturellement idempotente | ✅ | `validateDefinition` |
| Un outil réversible doit décrire son rollback | ✅ | `validateDefinition` |
| Le rollback déclaré nomme un outil qui existe | ❌ | **`MED-4`** — trois outils sur cinq nomment un outil inexistant |
| Un outil `effect: EXTERNAL` ne peut pas déclarer `attemptVerification: NONE` | ❌ | `effect` n'existe pas encore |

La sixième ligne est une dette de `docs/11` toujours ouverte. Elle est
inoffensive tant qu'aucune annulation n'est exécutable — et cessera de l'être
au premier Undo Engine.
