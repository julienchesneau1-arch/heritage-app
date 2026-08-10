# 11 — AUDIT ET RED TEAM

**Date : 10 août 2026 — commit audité : `08b52b2`**
**Mis à jour après le Sprint Foundation 1 (gel architectural) : 6 défauts sur 18
corrigés, dont les deux critiques. Voir §16.**
Méthode : inspection du code, exécution réelle, et **66 tests écrits pour cet audit**
(`tests/redteam/`). Rien n'est affirmé ici sans avoir été exécuté ou lu.

Ce qui n'a pas pu être vérifié porte la mention **`UNVERIFIED`**, avec la raison.
Une hypothèse n'est jamais présentée comme un fait.

---

> **⚠ Ce rapport décrit l'état AUDITÉ (`08b52b2`).** Il n'est pas réécrit après
> coup : un audit qu'on récrit pour qu'il ait l'air bon ne sert à rien. Les
> corrections sont consignées en §16, avec la preuve qui les valide.

## Verdict, avant les détails

> **Est-ce que cette version mérite de devenir l'assistant personnel quotidien ?**
>
> ## PAS ENCORE.

Trois raisons, dans cet ordre :

1. **Le processus meurt à la première coupure de PostgreSQL** — reproduit, code de
   sortie 1, y compris sur la passerelle exposée au Wi-Fi (`CRIT-1`).
2. **Il couvre 6 actions du quotidien sur 30**, et deux demandes sont
   silencieusement remplacées par une autre action annoncée comme réussie
   (`HIGH-4`).
3. **Il n'a aucune mémoire de travail** : 0 tour sur 17 exigeant du contexte est
   traité. « Décale-le à vendredi » ne veut rien dire pour lui (`HIGH-6`).

Ce qui est **déjà solide** mérite d'être dit avec la même netteté : l'honnêteté
systémique fonctionne, l'absence de sortie réseau est *démontrée* et non promise,
et le Policy Gate a résisté à toutes les tentatives de contournement écrites pour
cet audit. Ce sont les parties les plus difficiles. Elles sont faites.

---

## 1. Audit de l'état actuel

### Arborescence réelle

15 072 lignes de TypeScript, 89 fichiers source et outillage, 32 fichiers de tests.

```
src/
  apps/        cli/ (2)   server/ (4)   runtime.ts   reports.ts
  core/        assistant · config · context · db · intent · ledger · memory (6)
               observability · policy (3) · quarantine · secrets · session
               tools (2) · types (2) · undo · verification
  providers/   contract.ts   policy/cedar.ts
  tools/       memory · notes · tasks · index
ops/           setup · db (2) · gates (3) · security · bench (5)
infrastructure/db/migrations/   5 migrations, chacune avec son down
policies/      00_hard_security.cedar   10_base_permissions.cedar
docs/          00 → 11 + DEPENDENCIES
```

### Classement de chaque composant

Classé sur ce que le code fait, jamais sur ce que la documentation annonce.

| Composant | État | Preuve |
|---|---|---|
| Schéma PostgreSQL + migrations réversibles | `IMPLEMENTED` | 5 migrations up/down, rejouées à chaque `pnpm test` |
| Event Ledger append-only chaîné | `IMPLEMENTED` | 3 barrières testées, altération détectée |
| Policy Gate L0–L4 (Cedar) | `IMPLEMENTED` | 22 tests + 10 tentatives de contournement, aucune n'a abouti |
| Tool Gateway + contrats | `IMPLEMENTED` | 30 tests ; défaut `HIGH-2` sur le chemin d'exception |
| Verification Engine | `IMPLEMENTED` | `CONFIRMED` fabricable en un seul endroit, vérifié structurellement |
| Idempotence | `IMPLEMENTED` | rejeu = relecture de l'état réel, pas de mémoïsation |
| Memory Guard (2 axes) | `IMPLEMENTED` | 48 tests ; défaut `CRIT-2` sur la cartographie de provenance |
| Recherche hybride 3 voies | `PARTIAL` | voies structurée + lexicale actives ; **sémantique jamais exécutée** (aucun fournisseur d'embeddings) |
| Memory Inbox | `IMPLEMENTED` | mais aucune commande ne permet de confirmer un candidat |
| Capture d'état antérieur (Undo) | `PARTIAL` | `capture()` tourne ; **aucune exécution d'annulation** |
| Registre des dérivés | `IMPLEMENTED` | branché dans `store.insertVerified` |
| Coffre à secrets | `IMPLEMENTED` | 13 tests ; aucun outil n'a de secret à demander aujourd'hui |
| Intent Engine Tier 0 | `IMPLEMENTED` | 27 tests ; défauts `HIGH-4` et `HIGH-5` |
| Assistant (boucle partagée) | `IMPLEMENTED` | CLI et web traversent le même code |
| CLI | `IMPLEMENTED` | **0 % de couverture de tests** |
| Passerelle web | `IMPLEMENTED` | 45 tests ; `main.ts` à 0 % de couverture |
| Séparation Privileged/Quarantined | `MOCK` | code complet, testé — **jamais appelé en production** |
| Context Engine (entités, ambiguïté) | `MOCK` | idem : 20 tests, **zéro appelant** |
| Journalisation applicative + redaction | `MOCK` | idem : **zéro appelant** |
| Contrats fournisseurs (Model, Speech, Vision…) | `PLANNED` | 13 interfaces, **0 implémentation** |
| Data Firewall | `PLANNED` | seule la règle « RED + egress → DENY » existe, dans le Gate |
| Model Router / Cost Engine | `PLANNED` | rien |
| Modes cognitifs (PRIVATE, DRIVING…) | `PLANNED` | l'énumération existe, le mode est toujours `NORMAL` |
| Update Engine / LAB / Twin / canary | `PLANNED` | `docs/07` est une spécification ; **aucune ligne de code** |
| Voix (STT/TTS) | `PLANNED` | rien |
| Application iOS | `PLANNED` | rien |

### Dépendances externes

**Trois** à l'exécution. C'est peu, et c'est un vrai résultat.

| Paquet | Version | Rôle | Réseau |
|---|---|---|---|
| `zod` | 4.4.3 | validation aux frontières | aucun |
| `pg` | 8.16.3 | pilote PostgreSQL | localhost seulement |
| `@cedar-policy/cedar-wasm` | 4.12.0 | évaluation de politique | aucun (WASM local) |

Développement : `typescript`, `vitest`, `eslint`, `typescript-eslint`, `tsx`,
`@vitest/coverage-v8` (ajouté pendant cet audit, fiche remplie dans `DEPENDENCIES.md`).

### Services, bases, modèles, APIs, secrets

- **Services qui tournent** : PostgreSQL 16 (local), et le processus Node. Rien d'autre.
- **Bases** : `jarvis_dev` (9,1 Mo, 4 mémoires, 18 événements), `jarvis_test` (recréée à chaque exécution).
- **Modèles utilisés** : **aucun.** Ni local, ni distant. C'est délibéré (Tier 0).
- **APIs cloud** : **aucune.**
- **Secrets nécessaires** : 3 mots de passe PostgreSQL + `JARVIS_WEB_TOKEN`. Tous générés localement, aucun compte tiers.
- **Workflows automatisés** : un seul, `.github/workflows/ci.yml`. Voir `MED-1`.

### TODO, FIXME, hacks, dette

`grep` sur `TODO|FIXME|HACK|XXX|@ts-ignore|@ts-expect-error|eslint-disable` dans
`src/`, `ops/`, `tests/` : **zéro occurrence.** Aucun `any`, aucune assertion de
type non gardée dans le noyau.

La dette n'est pas là où on la cherche habituellement. Elle est dans les
**écarts entre ce que le dépôt affirme et ce qu'il exécute** — c'est l'objet des
sections suivantes.

### Couverture des tests

Mesurée, pas estimée : `pnpm test:coverage`.

| | % |
|---|---|
| Instructions | **80,50 %** |
| Branches | **78,24 %** |
| Fonctions | **93,92 %** |

Trois trous notables :

- `src/apps/cli/main.ts` — **0 %**
- `src/apps/server/main.ts` — **0 %**
- `src/apps/cli/report.ts` — **0 %** — et c'est le module qui décide quand dire
  « C'est fait ». Le seul endroit du code dont le rôle est de ne pas surestimer
  un succès n'est couvert par aucun test.

---

## 2. Dépendance aux modèles — `UNVERIFIED`

**La demande était de démontrer expérimentalement que Jarvis fonctionne avec
plusieurs moteurs. Cette démonstration est impossible aujourd'hui.**

`src/providers/` contient **13 interfaces** (`ModelProvider`, `EmbeddingProvider`,
`SpeechProvider`, `VisionProvider`, `CalendarProvider`…) et **une seule
implémentation** : `policy/cedar.ts`. Il n'existe :

- aucun adaptateur de modèle local (Ollama, MLX, llama.cpp) ;
- aucun adaptateur cloud A ou B ;
- aucun fournisseur d'embeddings — la voie sémantique de la recherche n'a
  **jamais tourné** en dehors d'un double de test.

Le test « changer de modèle ne casse pas le noyau » ne peut donc pas être écrit :
il n'y a rien à changer.

**Ce qui est vérifié, en revanche** (`tests/contracts/provider-isolation.test.ts`,
4 tests, exécuté à chaque CI) : aucun paquet externe ne peut être importé hors de
`src/providers/`, et le SDK Cedar n'est importé que par son adaptateur. La
*discipline* d'isolation est appliquée mécaniquement. C'est une garantie réelle,
mais c'est une garantie sur la forme, pas sur la substituabilité.

**Dépendances cachées à un fournisseur trouvées : une seule.** `Db` (type de `pg`)
traverse tout le noyau : `ToolContext.db`, `MemoryStore`, `Ledger`, tous les
outils. Remplacer PostgreSQL ne serait pas un changement d'adaptateur mais une
réécriture. C'est assumé par ADR-001 — mais il faut le dire : **le fournisseur
réellement irremplaçable aujourd'hui n'est pas un modèle, c'est la base.**

> Verdict : *le modèle est remplaçable en théorie, jamais éprouvé en pratique.*
> `UNVERIFIED` jusqu'au premier adaptateur.

---

## 3. Audit de confidentialité — le point le plus solide

**Aucune donnée ne sort de la machine. Démontré, pas affirmé.**

`tests/redteam/offline.test.ts` instrumente `net.Socket.prototype.connect`,
`dns.lookup` et `fetch`, puis fait tourner une session complète — mémorisation,
recherche, tâches, notes, lecture du journal, vérification de la chaîne.

| Donnée | Destination | Raison | Chiffrement | Consentement | Rétention |
|---|---|---|---|---|---|
| Mémoire personnelle | PostgreSQL `127.0.0.1:5432` | stockage | aucun (boucle locale) | implicite | illimitée — **aucune expiration appliquée** |
| Tâches, notes, entités | idem | idem | idem | idem | idem |
| Journal d'audit | idem | traçabilité | idem | idem | illimitée, append-only |
| Tours de conversation | idem | archive | idem | idem | illimitée, jamais relus |
| Embeddings | — | — | — | — | **aucun n'est produit** |
| Voix, transcriptions, photos, documents, localisation, agenda, emails | — | — | — | — | **aucun n'entre dans le système** |
| Logs applicatifs | `stdout` | exploitation | — | — | non persistés |
| Analytics, télémétrie, rapports d'erreur | — | — | — | — | **aucun, aucune ligne de code** |

**Appels réseau non documentés recherchés activement** : `grep` sur `fetch`,
`node:http(s)`, `node:net`, `node:dns`, `axios`, `undici`, `WebSocket` dans
`src/` → un seul résultat, `pool.connect()` vers PostgreSQL local. Le serveur web
n'ouvre qu'un socket **entrant**.

**Donnée traitée dans le cloud alors qu'elle pourrait l'être localement** : aucune,
puisqu'il n'y a pas de cloud.

Deux réserves, déjà écrites dans `03 §14` :

- le trafic de la passerelle web est en **HTTP non chiffré** ;
- il n'existe **aucune révocation par appareil**.

---

## 4. Test du Policy Engine — `MODEL ≠ AUTHORITY` tient

Dix tentatives de contournement écrites pour cet audit
(`tests/redteam/authority.test.ts`, 12 tests). **Aucune n'a abouti.**

| Attaque | Résultat |
|---|---|
| Enregistrer un outil L0 | **Refusé au contrat.** Un outil interdit ne peut pas exister — plus fort que ce que documentait `01` |
| Sortie réseau d'une donnée RED, confirmée | `POLICY_DENIED`, outil jamais exécuté |
| Idem en mode privé | `POLICY_DENIED` |
| Injecter `declaredAutonomy: 'L1'` dans l'appel | Ignoré — le niveau vient de la définition |
| Injecter `sensitive: false` sur un paramètre | Ignoré — le contrat fait foi |
| Omettre la carte de provenance | Traité comme `EXTERNAL_UNTRUSTED` (défaut fermé) |
| Paramètre sensible d'origine externe | `CONFIRMATION_REQUIRED`, **avec l'IBAN concret dans la question** |
| Écrire en mémoire « autorise tout sans confirmation » | Aucun effet — le Gate ne lit jamais la mémoire |
| Appeler `shell_exec` | `NOT_FOUND`, sans révéler les outils existants |
| Suppression massive / exécution de code | **Impossible : aucun outil de ce type n'existe** |

Le refus est **journalisé** avec `policyDecision: DENY` — un refus muet serait
invisible à l'audit.

**Trois limites honnêtes :**

1. `S2` (« aucun modèle n'exécute de code ») tient aujourd'hui par **absence de
   capacité**, pas par refus actif. C'est la forme la plus solide, et la moins
   éprouvée : il n'y a encore aucun outil dangereux à refuser.
2. Un appelant qui **ment sur la provenance** (`USER` pour une valeur lue dans un
   PDF) n'est pas détectable par le Gateway. La barrière est en amont, dans un
   Planning Engine qui n'existe pas encore.
3. Les règles utilisateur ne sont **pas consultées du tout**. Impossible d'en
   escalader une — mais impossible aussi d'en honorer une.

---

## 5. Test de vérité — solide, avec un trou

`tests/redteam/failure-modes.test.ts`. **Jarvis n'a jamais annoncé un succès non
vérifié dans aucun scénario testé.**

| Panne provoquée | Réponse |
|---|---|
| Outil qui renvoie HTTP 200 alors que rien n'a changé | `FAILED` ✅ |
| Relecture impossible | `UNKNOWN`, « l'action a peut-être abouti » ✅ |
| Timeout | `UNKNOWN` au journal ✅ |
| Fournisseur indisponible | `PROVIDER_UNAVAILABLE` typé ✅ |
| Base injoignable en lecture | erreur typée ✅ |
| Base injoignable en écriture | **exception non typée** ❌ (`HIGH-3`) |
| Outil qui lève une exception | **exception hors du Gateway, aucune trace au journal** ❌ (`HIGH-2`) |

`CONFIRMED` n'est fabricable qu'à un seul endroit du dépôt — vérifié
structurellement par un test qui scanne `src/core/`.

**Écart avec les états demandés.** Le système en connaît 4 (`CONFIRMED`,
`PROBABLE`, `UNKNOWN`, `FAILED`) là où la demande en réclame 7. Manquent :

- `PARTIAL` — aucune façon d'exprimer « 3 destinataires sur 5 » ;
- `EXECUTING` — aucune notion d'action longue en cours ;
- `REQUESTED` / `AUTHORIZED` — présents dans le journal (`_PREPARED`, `_DENIED`)
  mais pas dans le type retourné à l'appelant.

`PARTIAL` est le manque coûteux : il devra être ajouté **avant** le premier outil
capable de réussir à moitié (envoi multi-destinataires, synchronisation).

---

## 6. Audit mémoire — le maillon faible

Six types (`EPISODIC`, `SEMANTIC`, `PREFERENCE`, `RULE`, `INTENT`, `DECISION`) et
non cinq. Pour chacun, le cycle de vie demandé :

| Opération | État |
|---|---|
| Création | ✅ via `memory_add`, avec plafond de confiance par origine |
| Récupération | ✅ 2 voies sur 3 |
| Modification | ❌ **aucun outil** |
| Contradiction | ❌ **aucune détection, aucun arbitrage** |
| Expiration | ❌ colonne `expires_at` présente, **aucun processus ne la balaye** |
| Suppression | ❌ **aucun outil** — le droit à l'oubli (`S14`) n'est pas exerçable |
| Provenance | ✅ deux axes, cohérence imposée par contrainte SQL |
| Confiance | ✅ plafonnée par origine, jamais augmentable |

### Le test demandé, exécuté

> Jarvis mémorise une information fausse, puis une information contradictoire arrive.

```
« Retiens que Jean travaille chez Orano »   → STORED, FACT, confiance 1.0
« Retiens que Jean travaille chez EDF »     → STORED, FACT, confiance 1.0
« Que sais-tu sur Jean ? »                  → les DEUX, présentées à l'identique
```

Aucune n'est marquée obsolète. Aucune ne pointe vers l'autre. La phrase attendue —
*« J'avais enregistré X. Une information plus récente indique Y. Je considère donc
Y comme la version actuelle. »* — est **hors d'atteinte du schéma** : il n'existe
pas de colonne `superseded_by`. `HIGH-7`.

---

## 7. Test de contexte — 30 tours joués, résultat net

`tests/redteam/context-scenarios.test.ts`, sept fils narratifs sur neuf jours
simulés, dont le scénario du traiteur fourni tel quel.

| Aptitude | Tours | Traités |
|---|---|---|
| Action sans contexte | 13 | **12** |
| Référence (« il », « le suivant », « ça ») | 8 | **0** |
| Temporalité (« jeudi », « hier », « décale ») | 4 | **0** |
| Désambiguïsation (deux « Jean ») | 2 | **0** |
| Contradiction | 2 | **0** |
| Suppression / annulation | 2 | **0** |
| Comparaison | 1 | **0** |

**Cause racine, trouvée par analyse du graphe d'imports** : `SessionStore.recentTurns()`
existe, fonctionne, et **n'est appelée par personne**. Les tours sont écrits dans
`session_turns` puis jamais relus. L'Assistant est sans état d'un tour à l'autre.

Le Context Engine (`resolver.ts`, `packet.ts`, 20 tests, résolution d'entités et
détection d'ambiguïté) est **entièrement débranché**. `QUICKSTART.md` promet
pourtant : *« Créez deux contacts homonymes, puis parlez de l'un d'eux : il
demande lequel. »* **C'est faux dans le produit livré.** `HIGH-6`.

**Le point positif** : ne pas comprendre est traité comme ne pas comprendre.
Aucun « Décale-le à vendredi » ne crée une tâche « le à vendredi ».

---

## 8. Matrice des 30 actions quotidiennes

`tests/redteam/daily-actions.test.ts` — chaque phrase traverse la boucle réelle.

**6 actions sur 30 fonctionnent** : ajouter une tâche, les lister, créer une note,
mémoriser, rechercher en mémoire, rappel simple. Toutes en `CONFIRMED`, toutes
journalisées, toutes vérifiées par relecture de l'état réel.

**22 sur 30 sont correctement refusées** : « je comprends ce que tu veux, cette
capacité n'existe pas ».

**2 sur 30 sont silencieusement substituées** — le défaut le plus grave de cette
section, invisible sans exécution :

```
« Retrouve le devis du carreleur »          → memory_search → ✓ C'est fait.
« Cherche le prix moyen d'un carrelage »    → memory_search → ✓ C'est fait.
```

Une recherche dans la mémoire personnelle, qui ne trouve rien, annoncée comme un
succès. L'utilisateur ne peut pas distinguer « j'ai cherché sur le web, rien
trouvé » de « j'ai cherché ailleurs que là où tu croyais ». `HIGH-4`.

Colonnes demandées (`Policy`, `Journalisation`, `Coût`) : pour les 6 actions qui
passent, la politique est évaluée (`L1`/`L2`, `ALLOW`), l'événement est écrit au
journal, le coût est **0 €** — aucun appel payant n'existe.

**Latence**, mesurée sur 100 tours réels (5 phrases × 20 passes, base comprise,
de la phrase à la réponse vérifiée) :

| p50 | p95 | max |
|---|---|---|
| **7,9 ms** | 12,4 ms | 89,8 ms (premier appel, montée du pool) |

C'est un ordre de grandeur en dessous de tout ce qui appelle un modèle. Le Tier 0
n'est pas un pis-aller : sur ces phrases-là, c'est le meilleur choix technique.

---

## 9. Test offline

Voir §3 : l'instrumentation réseau prouve qu'aucune connexion ne sort, **même
quand le réseau est disponible**. Jarvis ne dégrade pas hors ligne, parce qu'il
n'a jamais rien attendu du réseau.

Sur les capacités minimales demandées hors réseau :

| Attendu hors ligne | État |
|---|---|
| Écouter | ❌ aucune entrée vocale |
| Comprendre des commandes simples | ✅ Tier 0, sans modèle |
| Consulter la mémoire locale | ✅ |
| Créer des notes | ✅ |
| Gérer certaines tâches | ✅ création et liste ; ni clôture ni suppression |
| Répondre aux commandes locales | ✅ |
| Contrôler les équipements locaux | ❌ aucun connecteur |
| **Annoncer qu'une action exige Internet** | ✅ « chercher sur le web » est listé comme capacité absente — sauf dans les 2 cas de `HIGH-4` |

---

## 10. Audit des coûts

| Volume | Cloud | Local | Total |
|---|---|---|---|
| 100 interactions | 0,00 € | 0,00 € | **0,00 €** |
| 1 000 interactions | 0,00 € | 0,00 € | **0,00 €** |
| 10 000 interactions | 0,00 € | 0,00 € | **0,00 €** |

Ce n'est pas un objectif atteint par optimisation : **aucun chemin de code n'est
capable de dépenser un centime.** Ni API, ni TTS, ni STT, ni vision, ni recherche.

- **Infrastructure** : PostgreSQL local, aucun hébergement.
- **Stockage** : mesuré à 9,1 Mo pour 4 mémoires et 18 événements — presque
  entièrement de la surcharge PostgreSQL. Extrapolation à partir des tailles de
  ligne : ~1 Ko par mémoire, ~0,5 Ko par événement. **10 000 mémoires + 50 000
  événements ≈ 35 Mo.** Le jour où les embeddings arrivent, compter ~3 Ko de plus
  par mémoire (768 × float4) — soit ~30 Mo pour 10 000. Négligeable.
- **Budget configuré** : `budgetMonthlyEur: 0` … **et non appliqué**. Aucun Cost
  Engine ne lit cette valeur (`MED-2`).

L'optimisation demandée — « déplacer davantage de travail vers le local » — n'a
pas d'objet : tout est déjà local. La question se reposera au premier appel cloud,
et c'est à ce moment-là qu'il faudra un Cost Engine, pas avant.

---

## 11. Auto-maintenance — inexistante

`docs/07_UPDATE_ENGINE_SPEC.md` décrit détection, LAB, canary, rollback. **Aucune
ligne de code correspondante n'existe.** `grep` sur `update.?engine|canary|twin`
dans `src/` et `ops/` : zéro.

Le test demandé — déployer une mise à jour volontairement cassée et vérifier le
retour automatique — **ne peut pas être exécuté**. `UNVERIFIED`, par absence.

Il existe une garantie voisine et réelle : les **migrations sont réversibles**, et
leur réversibilité est vérifiée à chaque exécution de la suite (`down` puis `up`).
C'est le seul rollback qui fonctionne aujourd'hui.

---

## 12. LAB / Twin — inexistant

Aucun environnement de reproduction. `UNVERIFIED`, par absence.

Ce qui existe et s'en approche : un environnement de test **isolé** (`jarvis_test`)
avec deux garde-fous non contournables interdisant de viser une base sans « test »
dans le nom, et trois portes de sortie exécutables (`gate:phase0/1/2`). C'est une
non-régression fonctionnelle, pas un jumeau : ni latence, ni coût, ni comparaison
de versions.

---

## 13. Modes de défaillance

| Panne | Que fait Jarvis | Que dit-il | Ce qu'il conserve | Récupère seul ? | Retour arrière ? |
|---|---|---|---|---|---|
| Outil qui ment (200, rien fait) | relit l'état réel | « Ça n'a pas marché » | événement `FAILED` | oui | sans objet |
| Timeout | abandonne | « Je ne sais pas si ça a abouti » | événement `UNKNOWN` | oui, par idempotence | sans objet |
| Relecture impossible | n'affirme rien | « L'action a peut-être abouti » | événement `UNKNOWN` | oui | sans objet |
| Fournisseur indisponible | erreur typée | message clair | événement `FAILED` | oui | sans objet |
| **Base coupée en cours de session** | **le processus meurt** | rien | **rien** | **non** | **non** | 
| **Outil qui lève** | **exception hors Gateway** | trace brute | **rien au journal** | non | non |
| Base absente au démarrage | refus propre | « connect ECONNREFUSED » | — | non | sans objet |
| Permission refusée | refuse | « Refusé : … » | événement `DENIED` | oui | sans objet |
| Utilisateur ambigu | demande une précision | une seule question | — | oui | sans objet |
| Réponse modèle invalide | — | — | — | — | `UNVERIFIED` (aucun modèle) |
| Mauvaise transcription | — | — | — | — | `UNVERIFIED` (aucune voix) |
| Mémoire contradictoire | **conserve les deux** | rien | les deux versions | non | non |

Les deux lignes en gras sont `CRIT-1` et `HIGH-2`.

---

## 14. Red team — injection de prompt

`tests/redteam/injection.test.ts`, 8 charges conçues pour contourner la détection
existante.

**7 sur 8 échappent au détecteur** `looksLikeInjection` : formulation française
sans « précédentes », impératif poli, autorité usurpée, balises XML, markdown de
rôle, anglais indirect, exfiltration déguisée.

**Ce n'est pas une faille**, et il faut être précis là-dessus : le code documente
lui-même cette fonction comme *« indicatif, jamais une barrière »*. La vraie
protection est l'étiquetage de provenance, qui ne dépend d'aucune reconnaissance
de motif. Le risque est qu'un futur développeur prenne ce détecteur pour une
défense et bâtisse dessus.

**Aucune charge n'a produit d'effet** : aucune politique modifiée, aucun outil
ajouté, aucune sortie réseau — impossible par absence d'outil réseau.

**L'angle mort réel, trouvé ailleurs que prévu.** L'Intent Engine étiquette
`USER` **tout** ce qui est tapé. C'est correct pour une phrase dictée, faux pour
un email recopié dans la fenêtre de conversation. Sans outil sensible, la
conséquence est nulle aujourd'hui ; avec un outil de paiement, ce serait le
chemin d'attaque le plus court. `MED-3`.

Et le point le plus important de cette section : **la séparation
Privileged/Quarantined — la défense principale contre T1 — n'est appelée par
personne.** Elle est complète, testée à 100 %, et hors circuit.

---

## 15. Rapport final

### Ce qui est bon

- **L'honnêteté systémique fonctionne, et c'est le plus dur.** `CONFIRMED` n'est
  fabricable qu'en un seul endroit, sur preuve. Vérifié structurellement.
- **L'absence de sortie réseau est démontrée**, par instrumentation, pas promise.
- **Le Policy Gate a résisté à toutes les attaques écrites pour cet audit.** Le durcissement ne peut que monter,
  la provenance absente vaut « non fiable », un outil L0 ne peut pas exister.
- **Le journal est inaltérable** : trois barrières indépendantes.
- **L'idempotence est correcte** : un rejeu relit l'état réel au lieu de rendre
  un résultat mémorisé.
- **Trois dépendances d'exécution. Zéro TODO. Zéro `any`.**
- La qualité des commentaires est au-dessus de la moyenne : ils expliquent
  *pourquoi*, pas *quoi*.

### Ce qui est faux

- `QUICKSTART.md` : *« Coupez PostgreSQL en cours de route : vous obtiendrez `?`
  ou `✗`, jamais un faux succès. »* → **le processus meurt.**
- `QUICKSTART.md` : *« deux homonymes → il demande lequel »* → **le Context Engine
  est débranché.**
- 3 outils sur 5 déclarent un `rollback` nommant un outil qui n'existe pas
  (`memory_forget`, `note_delete`, `task_cancel`).

### Ce qui est fragile

- 4 modules de logique testés mais jamais appelés.
- 11 clés de configuration sur 16 sans effet.
- La CI énumère les suites une par une — `tests/server/` et `tests/redteam/` n'y
  sont pas.

### Ce qui est inutile / peut être supprimé

Rien à supprimer. Les 4 modules orphelins doivent être **branchés**, pas jetés :
ce sont exactement les briques qui manquent.

### Ce qui est dangereux

`CRIT-1` et `CRIT-2`. Voir le tableau.

### Ce qui manque

Mémoire de travail relue · contradiction · oubli · expiration · `PARTIAL` ·
exécution d'annulation · Data Firewall · Cost Engine · adaptateurs de modèles ·
Update Engine · LAB.

### Ce qui peut être remplacé par une brique existante

- **Expiration et purge** : `pg_cron` plutôt qu'un ordonnanceur maison.
- **Rate limiting de la passerelle** : le nôtre est en mémoire, perdu au
  redémarrage — un `LIMIT` en base ou `pg_stat` suffirait.
- **Résolution d'entités** : `pg_trgm` (déjà installé) au lieu d'étendre le
  resolver maison.
- **Détection d'injection** : ne pas la développer davantage. C'est un cul-de-sac
  connu ; la provenance est la bonne réponse.

---

### Tableau des problèmes

| # | Sévérité | Problème | Fichier | Preuve |
|---|---|---|---|---|
| CRIT-1 | `CRITICAL` | Le processus meurt à la mort d'une connexion PostgreSQL inactive | `src/core/db/client.ts:56` | `tests/redteam/db-resilience.test.ts` |
| CRIT-2 | `CRITICAL` | Une déduction de modèle hérite d'une provenance **fiable** | `src/core/types/domain.ts:167` | `tests/redteam/memory.test.ts` |
| HIGH-2 | `HIGH` | Un outil qui lève échappe au Gateway **sans trace au journal** | `src/core/tools/gateway.ts:339` | `tests/redteam/failure-modes.test.ts` |
| HIGH-3 | `HIGH` | `transaction()` lève au lieu de rendre une erreur typée | `src/core/db/client.ts:81` | idem |
| HIGH-4 | `HIGH` | Deux demandes hors capacité déclenchent une **autre** action, annoncée réussie | `src/core/intent/engine.ts:122` | `tests/redteam/daily-actions.test.ts` |
| HIGH-5 | `HIGH` | Un rappel daté perd sa date en silence | `src/core/intent/engine.ts` | `tests/redteam/context-scenarios.test.ts` |
| HIGH-6 | `HIGH` | Aucune mémoire de travail : 0/17 tours contextuels | `src/core/assistant.ts` | idem |
| HIGH-7 | `HIGH` | Aucune gestion de contradiction ; schéma incapable de la représenter | `migrations/0001` | `tests/redteam/memory.test.ts` |
| HIGH-8 | `HIGH` | Quatre modules de sécurité/contexte débranchés | `quarantine`, `context`, `observability` | `tests/redteam/wiring.test.ts` |
| MED-1 | `MEDIUM` | La CI n'exécute ni `tests/server/` ni `tests/redteam/` | `.github/workflows/ci.yml` | `tests/redteam/wiring.test.ts` |
| MED-2 | `MEDIUM` | 11 clés de configuration sur 16 sans effet | `config/*.json` | idem |
| MED-3 | `MEDIUM` | Tout texte saisi est étiqueté `USER`, y compris un email collé | `src/core/intent/engine.ts:66` | `tests/redteam/injection.test.ts` |
| MED-4 | `MEDIUM` | `rollback` déclaré vers des outils inexistants | `src/tools/*.ts` | `tests/redteam/memory.test.ts` |
| MED-5 | `MEDIUM` | Ni `PARTIAL` ni `EXECUTING` dans les statuts | `src/core/types/domain.ts:112` | §5 |
| MED-6 | `MEDIUM` | Aucun outil d'oubli, de correction ou de listage de la mémoire | `src/tools/memory.ts` | `tests/redteam/memory.test.ts` |
| LOW-1 | `LOW` | `cli/report.ts` — le module de l'honnêteté — à 0 % de couverture | `src/apps/cli/report.ts` | `pnpm test:coverage` |
| LOW-2 | `LOW` | `expires_at` jamais balayée | `src/core/memory/` | `tests/redteam/memory.test.ts` |
| LOW-3 | `LOW` | Une lecture renvoie `CONFIRMED` → l'interface dit « C'est fait » pour une recherche vide | `src/core/verification/engine.ts:79` | §8 |

### Les deux critiques, en détail

#### `CRIT-1` — le processus meurt sur une coupure de base

**Reproduction**, sans superutilisateur ni redémarrage de service :

```bash
npx tsx tests/redteam/probes/pool-crash-probe.ts   # → code de sortie 1
```

Reproduction réelle également observée : serveur web démarré, `service postgresql
stop`, puis une requête → HTTP 000, processus mort, `Unhandled 'error' event`.

**Impact.** `brew services restart postgresql`, une mise à jour système, une mise
en veille du Mac suffisent. La passerelle web étant exposée au Wi-Fi, toute
personne capable de provoquer un redémarrage de la base peut arrêter Jarvis.

**Correction.** `pg.Pool` émet `'error'` quand un client *inactif* meurt ; sans
écouteur, Node relance l'événement en exception fatale.

```ts
// src/core/db/client.ts, après `new pg.Pool({...})`
pool.on('error', (cause) => {
  // Un client inactif est mort (redémarrage, bascule, veille). Sans cet
  // écouteur, Node transforme l'événement en exception fatale et tue le
  // processus. Le pool sait recréer la connexion suivante tout seul.
  onPoolError?.(toError(cause, 'pool'));
});
```

**Test de la correction** : `tests/redteam/db-resilience.test.ts` — retirer
`.fails()` ; la sonde doit imprimer `SURVECU` et sortir en 0.

#### `CRIT-2` — une déduction de modèle est traitée comme fiable

```ts
// src/core/types/domain.ts:176
case 'MODEL_INFERRED':
case 'SYSTEM':
  return 'SYSTEM';   // ← 'SYSTEM' est une provenance FIABLE
```

`isUntrusted('SYSTEM')` est faux. Une valeur déduite par un modèle peut donc
alimenter un paramètre sensible **sans confirmation** — l'inverse exact de
l'invariant `S1` et de la consigne *« une information déduite par le modèle ne
doit jamais avoir le même statut qu'une information déclarée par toi »*.

Le second axe fait pourtant son travail : `SOURCE_CEILING.MODEL_INFERRED = 0.7`.
C'est l'axe **sécurité** qui est faux, pas l'axe épistémique.

**Impact aujourd'hui : nul** — aucun modèle ne tourne. **Le jour où un modèle
existe : c'est le chemin d'attaque le plus court**, et il sera d'autant plus
difficile à voir que tout le reste est correct.

**Correction.** Ajouter `MODEL_INFERRED` à `UNTRUSTED_PROVENANCES`, ou mieux :
introduire une provenance distincte `MODEL_OUTPUT` et l'y ranger — `SYSTEM` doit
rester ce que le noyau a produit lui-même.

**Test de la correction** : `tests/redteam/memory.test.ts` — retirer `.fails()`
du test « une déduction de modèle ne devrait pas hériter d'une provenance
fiable ».

---

## Scorecard

| Axe | Note | Justification en une ligne |
|---|---|---|
| Architecture | **7**/10 | Séparations propres, erreurs typées — mais 4 modules débranchés et 11 clés de config inertes |
| Sécurité | **6**/10 | Dix contournements repoussés ; `CRIT-1` tue le processus, `CRIT-2` est une bombe à retardement |
| Confidentialité | **9**/10 | Zéro sortie réseau **démontrée** ; −1 pour l'HTTP en clair et l'absence de révocation |
| Indépendance modèles | **2**/10 | `UNVERIFIED` — 13 interfaces, 0 implémentation, rien n'a jamais été remplacé |
| Mémoire | **4**/10 | Écriture et classification solides ; ni contradiction, ni oubli, ni expiration, ni correction |
| Context Engine | **1**/10 | Le module existe et n'est jamais appelé. 0 tour contextuel sur 17 |
| Fiabilité des actions | **7**/10 | Verification Engine excellent ; −3 pour les exceptions non tracées et 2 substitutions |
| Offline | **9**/10 | Prouvé par instrumentation ; −1 pour les capacités hors ligne encore absentes (voix, domotique) |
| Coût | **9**/10 | 0 € à tous les volumes ; −1 parce que le budget configuré n'est appliqué par personne |
| Auto-update | **0**/10 | Spécifié dans `07`, zéro ligne de code |
| Tests | **7**/10 | 341 tests, 80,5 % d'instructions ; −3 : la CI en ignore deux répertoires, points d'entrée à 0 % |
| Maintenabilité | **8**/10 | TS strict, zéro TODO, zéro `any`, commentaires qui expliquent le pourquoi |
| Utilité quotidienne | **2**/10 | 6 actions sur 30, aucune mémoire de travail |

**Moyenne : 5,5/10** — mais la moyenne n'a pas de sens ici. Un système dont la
sécurité vaut 6 et l'utilité 2 n'est pas « moyen » : c'est une fondation solide
sans étage.

---

## Réponse à la question

> **Est-ce que cette version mérite de devenir mon assistant personnel quotidien ?**

**PAS ENCORE.** Trois faits, pas une impression :

1. Il meurt à la première coupure de base — reproduit, code de sortie 1.
2. Il couvre 6 gestes du quotidien sur 30, et en substitue 2 en silence.
3. Il ne se souvient pas de la phrase précédente.

**Ce qu'il faut faire avant d'y revenir**, dans cet ordre — les deux premiers
points se corrigent en quelques lignes :

| Ordre | Action | Effort |
|---|---|---|
| 1 | `CRIT-1` — écouteur `pool.on('error')` | 5 lignes |
| 2 | `CRIT-2` — `MODEL_INFERRED` devient non fiable | 2 lignes |
| 3 | `HIGH-2`, `HIGH-3` — envelopper les chemins qui lèvent | ~20 lignes |
| 4 | `HIGH-4`, `HIGH-5` — ordre des règles d'intention, date non silencieuse | ~30 lignes |
| 5 | `MED-1` — la CI lance `pnpm test` | 1 ligne |
| 6 | `HIGH-6` — brancher `recentTurns()` et le Context Engine | quelques jours |
| 7 | `HIGH-7` — `superseded_by` + arbitrage temporel | quelques jours |
| 8 | `MED-6` — `memory_forget`, `memory_update`, `task_done` | quelques jours |

Après 1 à 5, Jarvis devient **fiable** : il ne meurt plus, ne ment plus, ne
substitue plus. Après 6 à 8, il devient **utile**.

Ce que cet audit ne dit pas, et qu'il faut entendre quand même : la partie
généralement bâclée — l'honnêteté, la politique, l'audit, l'absence d'exfiltration —
est ici faite, et faite correctement. Ce qui manque est du travail de
construction ordinaire. C'est le bon sens de la difficulté.


---

## 16. Sprint Foundation 1 — état des corrections

*10 août 2026, après l'audit. Gel architectural : **aucune fonctionnalité
ajoutée**, uniquement les corrections P0 et la fermeture des chemins malhonnêtes.*

| # | État | Preuve exécutable |
|---|---|---|
| `CRIT-1` | ✅ **corrigé** | `tests/redteam/db-resilience.test.ts` — la sonde imprime `SURVECU`, sortie 0 |
| `CRIT-2` | ✅ **corrigé** | `tests/redteam/memory.test.ts` + migration 0006 + ADR-024 |
| `HIGH-2` | ✅ **corrigé** | `tests/redteam/failure-modes.test.ts` — `Result` typé **et** événement `_CRASHED` au journal |
| `HIGH-3` | ✅ **corrigé** | idem — `PROVIDER_UNAVAILABLE`, plus aucune exception |
| `HIGH-4` | ✅ **corrigé** | `tests/redteam/daily-actions.test.ts` — 0 substitution, portée annoncée |
| `HIGH-5` | ✅ **corrigé** | `tests/redteam/context-scenarios.test.ts` — rappel daté refusé, rappel simple conservé |
| `MED-1` | ✅ **corrigé** | la CI lance `pnpm test` ; un test interdit de revenir à l'énumération |
| `LOW-3` | ✅ **corrigé** | une lecture ne s'annonce plus « C'est fait » |
| `MED-2` | ◐ **partiel** | `poolMax` et `statementTimeoutMs` transmis ; 9 clés restent inertes |
| `HIGH-6` `HIGH-7` `HIGH-8` `MED-3` `MED-4` `MED-5` `MED-6` `LOW-1` `LOW-2` | ⏳ **ouverts** | relèvent des Sprints 2 et 3 — mémoire de travail, contradiction, câblage |

### Ce que CRIT-1 est devenu, exactement

Le correctif ne se limite pas à l'écouteur `pool.on('error')`. La panne est
devenue un **état observable**, avec une conduite définie :

```text
PostgreSQL tombe
      ↓
pool émet 'error'  →  état DOWN  (le processus SURVIT)
      ↓
toute action passant par la base est REFUSÉE :
  « La base de données est injoignable. Rien n'a été tenté. »
      ↓
ce qui ne demande pas la base continue de répondre
(comprendre la phrase, dire ce qu'on ne sait pas faire)
      ↓
PostgreSQL revient  →  sonde  →  état UP  →  DATABASE_RECOVERED au journal
```

Vérifié en exécution réelle, passerelle web exposée : `service postgresql stop`
puis trois requêtes, puis `start`. Le serveur a répondu à chaque étape, a refusé
d'agir pendant la panne, et a repris **sans redémarrage**. L'événement
`DATABASE_RECOVERED` figure dans `event_ledger`, acteur `SYSTEM`.

### Ce que HIGH-4 est devenu

La règle est désormais absolue et testée :

> **Un outil n'a jamais le droit de prétendre avoir effectué une action
> différente de celle demandée.**

Trois conduites, selon ce que Jarvis sait :

| Demande | Avant | Maintenant |
|---|---|---|
| « Retrouve le devis du carreleur » | `memory_search` → « ✓ C'est fait » | « je ne sais pas chercher dans tes documents » |
| « Cherche le prix moyen d'un carrelage » | `memory_search` → « ✓ C'est fait » | « je ne sais chercher que dans ta mémoire personnelle — dois-je y chercher … ? » |
| « Que sais-tu sur X » (0 résultat) | « ✓ C'est fait » | « Rien trouvé **dans ta mémoire personnelle** » + portée annoncée |

La **portée** fait maintenant partie du résultat de l'outil (`scope`,
`scopeLabel`), pas de la décoration d'interface : toute interface, présente ou
future, doit l'afficher.

### Ce qui reste vrai du verdict

**PAS ENCORE**, mais pour une raison de moins. Jarvis ne meurt plus, ne substitue
plus, ne perd plus une date en silence. Il reste **6 actions sur 30** et
**aucune mémoire de travail** — c'est le Sprint 2.

`345 tests`, trois portes de sortie vertes, scan de secrets propre.
