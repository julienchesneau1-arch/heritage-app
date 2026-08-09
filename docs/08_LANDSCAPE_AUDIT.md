# 08 — AUDIT DU TERRAIN
## Ce que nous pouvons assembler, ce que nous devons développer

**Date : 9 août 2026.** Audit réalisé avant toute écriture de code, conformément au
principe : *déterminer ce qui existe avant de décider ce qu'on construit.*

---

## 0. Méthode et limites

### Ce qui a été fait
Recherche documentaire sur seize domaines techniques, avec vérification sur source
primaire chaque fois que c'était possible.

### Ce qui n'a pas été fait, et qui compte
**Aucun benchmark exécuté.** Aucun modèle installé, aucune latence mesurée, aucun WER
français calculé. Cet audit établit *ce qui existe et à quelles conditions* — pas *ce
qui marche le mieux chez nous*. La section 7 liste ce qui reste à mesurer, et cette
mesure ne peut pas être remplacée par de la lecture.

### Limite d'environnement à connaître
La politique réseau de l'environnement d'audit bloquait l'accès direct à la plupart des
domaines (`ollama.com`, `developers.meta.com`, `modelcontextprotocol.io`…). Seuls
GitHub et le moteur de recherche étaient accessibles. Certaines affirmations reposent
donc sur des résumés de recherche citant des sources secondaires, dont plusieurs sont
des sites de comparaison à visée publicitaire. **Elles sont marquées comme telles.**

### Niveaux de confiance

| Marque | Signification |
|---|---|
| **●** | **Primaire** — vérifié sur la source officielle (dépôt, spec, licence) |
| **◐** | **Secondaire** — plusieurs sources tierces concordantes, non vérifié à la source |
| **○** | **À vérifier** — source unique, ou sources en désaccord |

Cette gradation n'est pas une coquetterie : c'est le même principe que le
`FACT / INFERENCE / HYPOTHESIS` que nous imposons à Jarvis. Un audit qui présente ses
inférences comme des faits ne vaut pas mieux qu'un modèle qui hallucine.

---

## 1. Le verdict

> **Environ 80 % de la machinerie de Jarvis existe déjà, sous licence permissive,
> mature, et remplaçable.**
>
> **Les 20 % restants — la couche de confiance — n'existent nulle part, et c'est
> exactement là que se trouve le produit.**

### La nuance qui change tout

Ce ratio porte sur le **volume de code**, pas sur l'effort. Assembler 80 % du code ne
retire pas 80 % du travail : l'intégration, les contrats, les tests adversariaux et la
vérification représentent l'essentiel de la charge réelle.

La bonne lecture n'est donc pas *« on va aller quatre fois plus vite »*. C'est :

> **On ne dépensera pas notre énergie à réécrire un moteur de transcription. On la
> dépensera à construire la seule chose que personne ne vend : un système qui ne ment
> pas sur ce qu'il a fait.**

---

## 2. Synthèse

| Domaine | Brique retenue | Licence | Verdict |
|---|---|---|---|
| Transcription (STT) | `whisper.cpp` + Core ML / WhisperKit | MIT ● | **ASSEMBLER** |
| Détection de voix / réveil | Silero VAD, openWakeWord | permissive ◐ | **ASSEMBLER** |
| Synthèse vocale (TTS) | Piper, Kokoro | MIT / Apache ◐ | **ASSEMBLER** |
| Runtime LLM local | Ollama / llama.cpp / MLX | MIT ◐ | **ASSEMBLER** (derrière adaptateur) |
| Modèles LLM | Qwen3, Mistral Small, Gemma 3 | Apache 2.0 ◐ | **ASSEMBLER** (choix par benchmark) |
| Embeddings | EmbeddingGemma-300M, BGE-M3 | permissive ◐ | **ASSEMBLER** |
| Stockage + recherche | PostgreSQL + pgvector + tsvector | PostgreSQL ● | **ASSEMBLER** |
| Évaluation de politique | Cedar (ou OPA) | Apache 2.0 ◐ | **ASSEMBLER** le moteur |
| Protocole d'outils | MCP `2026-07-28` | ouverte ● | **ASSEMBLER** |
| Intégrité des mises à jour | TUF + Sigstore | Apache 2.0 ◐ | **ASSEMBLER** |
| Documents / OCR | Docling (+ Tesseract, OcrMac) | MIT ◐ | **ASSEMBLER** |
| Domotique | Home Assistant | Apache 2.0 ◐ | **ASSEMBLER** (périphérie) |
| Sandbox | WASM / Deno / microVM | permissive ◐ | **REPORTÉ** (ADR-010) |
| Surface iOS | App Intents | Apple ◐ | **ASSEMBLER** (contraintes subies) |
| Lunettes | Meta Wearables DAT | Meta ● | **ADAPTATEUR** (preview) |
| Automatisation | n8n | Sustainable Use ● | **PÉRIPHÉRIE**, surveillée |
| — | — | — | — |
| **Context Engine** | — | — | **DÉVELOPPER** |
| **Memory Engine** | — | — | **DÉVELOPPER** |
| **Policy Gate (L0–L4)** | — | — | **DÉVELOPPER** |
| **Privileged / Quarantined** | inspiré de CaMeL | — | **DÉVELOPPER** |
| **Tool Gateway + contrats** | — | — | **DÉVELOPPER** |
| **Verification Engine** | — | — | **DÉVELOPPER** |
| **Data Firewall** | — | — | **DÉVELOPPER** |
| **Model Router + benchmark** | — | — | **DÉVELOPPER** |
| **Update Engine (orchestration)** | — | — | **DÉVELOPPER** |
| **Event Ledger** | — | — | **DÉVELOPPER** |
| **Golden Suite** | — | — | **DÉVELOPPER** |

---

## 3. Ce que nous assemblons

### 3.1 Transcription — `whisper.cpp` **●**

Vérifié sur le dépôt : licence **MIT** ; sur Apple Silicon, l'inférence de l'encodeur
peut s'exécuter sur le Neural Engine via Core ML, avec un gain annoncé **« plus de
×3 »** face au CPU seul. Quantification entière disponible. Plateformes : macOS, iOS,
Android, Linux, Windows, Raspberry Pi, WebAssembly.

**Le piège.** Parakeet domine les classements de vitesse sur Apple Silicon, et
plusieurs implémentations Swift le compilent vers le Neural Engine ◐. Mais ces gains
sont mesurés sur la **dictée anglaise**. Whisper couvre 99 langues.

**Verdict : Whisper, parce que l'utilisateur parle français.** Parakeet reste un
adaptateur optionnel, à activer si — et seulement si — un benchmark francophone interne
le justifie. C'est la règle « le meilleur modèle est celui qui marche pour Jarvis »
appliquée dès le premier choix.

### 3.2 Voix : VAD, réveil, synthèse **◐**

Silero VAD et openWakeWord sont les standards de fait, éprouvés notamment par
l'écosystème Home Assistant.

Côté TTS, deux candidats sous licence permissive : **Piper** (minuscule, CPU, latence
minimale, qualité audiblement synthétique) et **Kokoro** (82M paramètres, français
supporté, qualité nettement supérieure). L'écart entre TTS ouvert et commercial s'est
largement resserré en 2026 ◐.

**Le piège — licence.** **XTTS v2 est sous CPML, non commerciale.** Il apparaît en tête
de nombreux comparatifs, ce qui en fait exactement le genre de choix qu'on regrette
deux ans plus tard. **Exclu** (ADR-009).

### 3.3 Runtime local **◐**

Ollama 0.19 (fin mars 2026) a remplacé son backend llama.cpp/Metal par **MLX** sur
Apple Silicon, avec un quasi-doublement du débit de décodage. llama.cpp reste le backend
sur Linux et Windows.

**Le piège — un seuil matériel.** Le bénéfice MLX serait conditionné à **32 Go de
mémoire unifiée minimum** ; en dessous, la machine reste sur l'ancien chemin Metal ◐.
Cette affirmation provient de sources secondaires et **n'a pas pu être vérifiée sur le
blog officiel** (domaine bloqué). Si elle se confirme, elle doit figurer dans les
prérequis d'installation : « local-first » a un plancher matériel, et le découvrir
après coup serait une mauvaise surprise structurante.

**À vérifier en priorité.**

### 3.4 Modèles et embeddings **◐**

Pour un modèle local avec appel d'outils et sortie structurée en français : **Qwen3**
(Apache 2.0, multilingue large, mode JSON) et **Mistral Small** (appel de fonctions
natif, ancrage européen) sont les deux candidats sérieux ; Gemma 3 pour les très
petites tailles.

Pour les embeddings multilingues : **EmbeddingGemma-300M** (moins de 200 Mo quantifié,
troncature Matryoshka 768→512→256→128) ou **BGE-M3** (dense + sparse + multi-vecteurs).

**Aucun de ces choix ne doit être figé maintenant.** Ils sont tranchés par le benchmark
Jarvis, pas par un classement public. C'est précisément pour cela que le Model Router
et son benchmark font partie des 20 % que nous développons.

### 3.5 Stockage et recherche **●**

PostgreSQL + pgvector couvre les trois voies (structurée, lexicale, sémantique), et la
fusion RRF s'écrit en SQL standard.

**Le piège — le classement lexical.** `ts_rank` est faible comparé à BM25. Tant que RRF
ne s'appuie que sur le **rang** et non sur le score absolu, c'est tolérable. Si les
Golden Tests montrent une dégradation, `pg_textsearch` apporte un BM25 natif ◐ — **une
extension, pas une base de plus** (ADR-002).

Ce domaine est celui où la tendance du secteur pousse le plus fort vers une base
vectorielle dédiée. Elle n'est pas justifiée à notre échelle, et chaque base
supplémentaire coûte une migration, un backup, un mode de panne et une surface
d'attaque.

### 3.6 Politique, protocole, intégrité **◐ / ●**

- **Cedar** : déclaratif, formellement vérifié, nettement plus rapide que Rego ◐.
  OPA reste l'alternative si Cedar ne suffit pas à exprimer un besoin (ADR-005).
- **MCP `2026-07-28`** ● : sans état, autorisation durcie, extension Tasks, en-têtes
  `Mcp-Method`/`Mcp-Name` obligatoires. Vérifié sur le changelog officiel.
- **TUF + Sigstore** ◐ : signature M-parmi-N et rotation de clés prévues par le
  protocole. Ne rien inventer ici (ADR-011).

### 3.7 Documents, domotique **◐**

**Docling** convertit et analyse la mise en page, avec des moteurs OCR interchangeables
(Tesseract, RapidOCR, **OcrMac** — donc le moteur natif d'Apple sur macOS).

**Home Assistant** : son pipeline Assist tourne entièrement en local, relié par le
protocole **Wyoming** — une abstraction de transport audio déjà éprouvée dont nous
pouvons nous inspirer, voire que nous pouvons adopter, pour notre Audio Gateway.

---

## 4. Ce que nous développons — les 20 %

Ces onze composants n'existent pas sous forme de brique réutilisable. Ce n'est pas un
hasard : ils encodent des décisions produit, pas des capacités techniques génériques.

### 4.1 Context Engine — *le cœur*
Résoudre « celui-ci », « le projet », « Paul », « comme la dernière fois » contre un
graphe personnel d'entités et de relations, détecter l'ambiguïté, et produire un
**paquet de contexte minimal**. Aucun framework RAG ne fait cela : ils récupèrent des
documents, ils ne résolvent pas des référents.

### 4.2 Memory Engine typé
Huit types de mémoire, chacun avec provenance, confiance, classe de confidentialité et
expiration. Décroissance de confiance, réévaluation sur contradiction, déduplication,
et surtout la classe **`EXTERNAL_CLAIM`** : un email disant « Julien aime X » ne devient
jamais une préférence. Les bibliothèques de « mémoire agent » stockent des vecteurs ;
elles ne modélisent ni la provenance ni le doute.

### 4.3 Policy Gate (L0–L4)
Cedar évalue « as-tu le droit ». L'échelle d'autonomie, la hiérarchie où une règle
apprise ne peut jamais assouplir une règle dure, et le couplage à l'idempotence, à la
vérification et au journal : c'est de la logique produit.

### 4.4 Séparation Privileged / Quarantined
Inspirée de CaMeL et de la famille de travaux qui l'entoure ◐, mais l'implémentation —
étiquetage de provenance, refus d'un paramètre sensible issu d'une source non fiable —
est spécifique à nos outils et à nos données.

### 4.5 Tool Gateway et contrats
Quinze outils, chacun déclarant permissions, risque, réversibilité, idempotence,
timeout, méthode de vérification et rollback. Les secrets sont injectés ici, hors de
portée du modèle.

### 4.6 Verification Engine — *le différenciateur*
Après chaque mutation : relire l'état réel, comparer l'attendu à l'obtenu, produire
`CONFIRMED` / `PROBABLE` / `UNKNOWN` / `FAILED`.

**C'est le composant qui n'existe dans aucun produit du marché.** Tous les assistants
rapportent le succès de l'appel d'API ; aucun ne vérifie que le monde a changé. C'est
la raison pour laquelle ils affirment parfois avoir envoyé un email qui n'est jamais
parti.

### 4.7 Data Firewall
Classification RED/ORANGE/GREEN, redaction, décision d'égression journalisée et
consultable par l'utilisateur.

### 4.8 Model Router et benchmark Jarvis
Router sur la **capacité** (complexité, latence, confidentialité, coût, hors ligne,
langue) et non sur le fournisseur. Et le corpus de benchmark qui permet d'appliquer la
règle : *un modèle globalement meilleur peut être refusé s'il est moins fiable pour
Jarvis.*

### 4.9 Update Engine — orchestration
La cryptographie est assemblée (TUF/Sigstore). Le pipeline, les portes, le LAB/Twin,
le shadow testing, le canary et le rollback automatique sur régression sont à nous.

### 4.10 Event Ledger
Append-only chaîné par hash, avec interdiction d'`UPDATE`/`DELETE` au niveau des
permissions PostgreSQL. Simple à écrire, structurant à tenir.

### 4.11 Golden Suite
100+ scénarios dont 25+ adversariaux. C'est un artefact produit.

---

## 5. Les six corrections que cet audit impose à la v0.2

C'est la partie qui compte. Un audit qui confirme tout ce qu'on pensait déjà n'a servi
à rien.

### C1 — Le Policy Engine seul ne suffit pas contre l'injection **(majeur)**

La v0.2 décrit la chaîne :

```
LLM → proposition → Policy Engine → validation → outil → vérification → état réel
```

Elle est nécessaire, mais **insuffisante**. Le Policy Engine répond à « **as-tu le
droit ?** ». Il ne répond pas à « **est-ce bien ce qui t'a été demandé ?** ».

Un email piégé peut amener le modèle à formuler une action *parfaitement autorisée* —
envoyer un message à un contact connu — que l'utilisateur n'a jamais demandée. La
politique la validera consciencieusement.

**La correction :** ajouter la séparation flux de contrôle / flux de données. La
littérature 2024–2026 (CaMeL, FIDES, Progent, RTBAS, FORGE) a convergé exactement sur
ce point ◐ : la sécurité s'applique hors du modèle, par un moniteur déterministe qui
suit la **provenance** des données, avec un LLM privilégié qui planifie et un LLM en
quarantaine qui lit le contenu non fiable sans accès aux outils.

C'est la formalisation de votre intuition « sécurité par architecture et non par
prompt » — et elle porte un nom, ce qui nous évite de la réinventer. → **ADR-004**.

### C2 — « Local-first » a un plancher matériel

Si le seuil des 32 Go de mémoire unifiée se confirme ◐, une partie du bénéfice de
performance locale n'est pas disponible sur un Mac d'entrée de gamme. Ce n'est pas
rédhibitoire — le système fonctionne, plus lentement — mais cela doit être **écrit dans
les prérequis**, pas découvert à l'installation. → **ADR-007**, à revérifier.

### C3 — iOS interdit architecturalement le « Jarvis toujours à l'écoute »

Trois contraintes cumulées ◐ : SiriKit déprécié à la WWDC 2026 au profit d'App Intents ;
30 secondes d'exécution (extensibles via `LongRunningIntent` matérialisé en Live
Activity) ; et surtout **`AudioRecordingIntent` ne peut pas démarrer un enregistrement
depuis un arrière-plan froid** — la session doit avoir été initiée au premier plan.

Ce n'est pas un bug à contourner. C'est une contrainte à assumer, d'ailleurs cohérente
avec notre propre interdiction d'écoute invisible. → **ADR-013**.

### C4 — Les lunettes ne sont pas ce qu'on imagine

Vérifié sur le dépôt officiel ● : le toolkit expose le **streaming vidéo**, la
**capture photo** et les **fonctions d'affichage** (Ray-Ban Display), via une
**application mobile** — le code ne tourne pas sur les lunettes. Le SDK est en
**developer preview**.

Deux points appellent la prudence :
- Les sources secondaires mentionnent un accès **audio** ◐ ; le README du dépôt iOS ne
  le mentionne pas. **Divergence non résolue, à vérifier avant tout engagement.**
- L'accès aux invocations « Hey Meta » n'en fait pas partie ◐.

**L'expérience réelle sera donc : Jarvis tourne sur le téléphone et utilise les lunettes
comme micro, caméra et écran.** Ce n'est pas « Jarvis dans les lunettes ». Autant le
savoir avant d'acheter le matériel — d'autant qu'un **Mock Device Kit** permet d'écrire
et de tester l'adaptateur sans lunettes ◐. → **ADR-014**.

### C5 — Deux licences à trancher maintenant

- **XTTS v2** est sous **CPML, non commerciale**. Excellent en qualité, en tête de
  nombreux comparatifs, et **inutilisable** si le projet évolue. Exclu.
- **n8n** ● (licence lue à la source) : *« You may use or modify the software only for
  your own internal business purposes or for non-commercial or personal use »*, et la
  redistribution n'est permise que gratuitement et à but non commercial. Pour un usage
  personnel : parfaitement utilisable. Ce n'est pas une licence OSI, et certaines
  fonctionnalités « Enterprise » en sortent. → périphérie uniquement, surveillée.

### C6 — MCP sans état est un cadeau pour notre Tool Gateway

La suppression de la poignée de main et de `Mcp-Session-Id` ● élimine une classe
entière d'attaques par détournement de session. Et les en-têtes obligatoires
`Mcp-Method` / `Mcp-Name` permettent à notre passerelle d'**autoriser avant de
dispatcher**, sans désérialiser le corps de la requête.

Autrement dit : la spécification a évolué dans le sens de notre architecture. Il faut
en tirer parti explicitement, tout en maintenant la règle **MCP ≠ sécurité**. → **ADR-006**.

---

## 6. Décisions tranchées à l'issue de l'audit

Les deux décisions bloquantes identifiées par cet audit ont été arbitrées le
**9 août 2026** :

| # | Décision | Arbitrage |
|---|---|---|
| **ADR-016** | Stack d'implémentation du noyau | **TypeScript (noyau) + Swift (iOS)**, runtimes d'inférence hors processus. Facteur décisif : le coût de maintenance à long terme, objectif produit explicite |
| **ADR-005** | Moteur d'évaluation de politique | **Cedar** — déclaratif, formellement vérifié. L'échelle L0–L4 et la porte restent notre code |

Trois conséquences de l'ADR-016 sont à tenir dès la Phase 0 : validation runtime
systématique aux frontières (Zod, jamais de `as`), discipline opérationnelle sur la
tenue en service long, et calcul maintenu hors du noyau. Détail dans l'ADR.

**Reste ouvert :** la validation de la frontière assembler / développer, et le banc de
mesure (§7).

---

## 7. Ce qui reste à mesurer nous-mêmes

Aucune lecture ne remplace ces mesures. Elles doivent être faites tôt, parce qu'elles
peuvent invalider des choix.

1. **WER français** : Whisper (tailles et quantifications) vs Parakeet, sur du corpus
   réel — dictée, commandes courtes, bruit ambiant.
2. **Le seuil 32 Go d'Ollama/MLX** — vérification sur source primaire, puis mesure.
3. **Latence de bout en bout** sur le matériel réel : VAD → STT → intention → outil →
   TTS. L'objectif de 500 ms perçu est-il atteignable ?
4. **Qualité de récupération** des trois voies (structurée, lexicale, sémantique) sur
   corpus personnel réel — c'est ce qui décide de `pg_textsearch`.
5. **Appel d'outils en français** : Qwen3 vs Mistral Small vs Gemma 3, taux de
   paramètres corrects.
6. **Barge-in < 300 ms** : atteignable avec Piper ? avec Kokoro ?
7. **Empreinte mémoire cumulée** de la pile locale complète en fonctionnement simultané.

---

## 8. Recommandation

**Ne pas commencer à coder Jarvis.** Commencer par :

1. **Trancher ADR-016 et ADR-005** (décisions bloquantes) ;
2. **Monter un banc de mesure** — pas le produit : juste de quoi répondre aux sept
   questions de la section 7 ;
3. **Puis Phase 0**, avec des choix appuyés sur des mesures et non sur des comparatifs
   en ligne.

Le banc de mesure est un investissement d'une à deux semaines qui évite de découvrir au
sprint 8 que la latence cible est inatteignable ou que le modèle choisi se trompe une
fois sur cinq en français.

---

## Sources

**Primaires (vérifiées) :**
- [whisper.cpp — dépôt officiel](https://github.com/ggml-org/whisper.cpp)
- [MCP — changelog spécification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Meta Wearables Device Access Toolkit — dépôt iOS](https://github.com/facebook/meta-wearables-dat-ios)
- [n8n — Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md)

**Secondaires (à confirmer) :**
- [Ollama — MLX sur Apple Silicon](https://ollama.com/blog/mlx)
- [Home Assistant — protocole Wyoming](https://www.home-assistant.io/integrations/wyoming/)
- [Home Assistant — assistant vocal entièrement local](https://www.home-assistant.io/voice_control/voice_remote_local_assistant)
- [MCP — annonce de la spécification 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [CaMeL — *Defeating Prompt Injections by Design*](https://css.csail.mit.edu/6.5660/2026/readings/camel.pdf)
- [Injection indirecte — état de l'art 2026](https://zylos.ai/research/2026-04-12-indirect-prompt-injection-defenses-agents-untrusted-content/)
- [Évaluation adaptative des défenses hors-bande](https://arxiv.org/html/2606.26479v1)
- [ParadeDB — recherche hybride dans PostgreSQL](https://www.paradedb.com/blog/hybrid-search-in-postgresql-the-missing-manual)
- [Tiger Data — pg_textsearch, BM25 natif](https://www.tigerdata.com/blog/introducing-pg_textsearch-true-bm25-ranking-hybrid-retrieval-postgres)
- [Docling — documentation](https://docling.org/doc/)
- [Comparatif moteurs de politique — OPA / Cedar / Zanzibar](https://www.osohq.com/learn/opa-vs-cedar-vs-zanzibar)
- [Chainguard — vérification avec TUF et Sigstore](https://www.chainguard.dev/unchained/not-all-thats-signed-is-secure-verify-the-right-way-with-tuf-and-sigstore)
- [App Intents — limite des 30 secondes et LongRunningIntent](https://matthewcassinelli.com/app-intents-thirty-second-limit-extend-execution-live-activity-longrunningintent/)
- [Apple Developer Forums — AudioRecordingIntent en arrière-plan](https://developer.apple.com/forums/thread/815725)
- [Sandbox pour agents — microVM, gVisor, WASM](https://northflank.com/blog/how-to-sandbox-ai-agents)
