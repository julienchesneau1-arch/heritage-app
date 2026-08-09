# 00 — MASTER VISION
## Constitution technique et produit

**Version 0.2** — remplace le PRD v0.1 comme source de vérité.
**Statut : ratifié. Toute modification de ce document est une décision d'architecture,
pas une mise à jour de documentation.**

---

## 1. Ce qu'est Jarvis

Jarvis est un **Personal Operating System** : une couche de confiance entre un
utilisateur et ses données, ses outils et ses modèles.

Jarvis n'est pas un chatbot. Ce n'est pas un agent autonome à qui on donne tout.
Ce n'est pas une démonstration technologique.

### Le principe fondamental

> **L'intelligence de Jarvis réside dans son système, pas dans son modèle.**

Un modèle est un composant interchangeable. Le produit est le système de confiance
qui l'entoure.

### La boucle centrale

```
ENTRÉE (voix / texte / événement système)
   ↓
CONTEXTE          ← qui, quoi, quand, où, dans quel projet, dans quel mode
   ↓
INTENTION         ← proposition structurée, jamais une décision
   ↓
PLAN
   ↓
POLICY            ← seul point où une action devient autorisée
   ↓
OUTIL TYPÉ        ← contrat strict, secrets injectés hors du modèle
   ↓
EXÉCUTION
   ↓
VÉRIFICATION      ← état réel, pas déclaration du modèle
   ↓
JOURNAL
   ↓
RÉPONSE HONNÊTE
```

La différence avec un assistant ordinaire tient en quatre lignes :

- le modèle **propose** ;
- le système **valide** ;
- un outil typé **exécute** ;
- le système **vérifie**, puis Jarvis rapporte le résultat vérifié.

---

## 2. Les sept invariants du produit

Ces propriétés doivent rester vraies à chaque commit. Elles sont testées, pas
supposées. Leur violation bloque une release (voir `05_GOLDEN_TESTS.md`).

### I1 — Fonctionnel sans Internet
Le noyau (comprendre, mémoriser, retrouver, planifier, exécuter localement,
journaliser) fonctionne réseau coupé, plusieurs jours.

### I2 — Fonctionnel sans fournisseur IA payant
Aucun abonnement n'est requis pour l'usage quotidien. Le cloud est un accélérateur
optionnel, jamais une fondation.

### I3 — Sécurité par architecture, pas par prompt
Un modèle compromis, halluciné ou victime d'injection ne dispose d'aucun pouvoir
qu'un modèle sain n'aurait pas. Les garanties sont **architecturales**, pas
comportementales.

### I4 — Aucun succès non vérifié
Jarvis distingue `CONFIRMED` / `PROBABLE` / `UNKNOWN` / `FAILED` et ne promeut
jamais l'un vers l'autre. Taux de fausse confirmation attendu en release : **0**.

### I5 — Aucune donnée ne sort sans décision de politique
Toute sortie réseau passe par le Data Firewall, est classifiée, journalisée, et
consultable par l'utilisateur.

### I6 — Remplaçabilité
Tout modèle, fournisseur, runtime, moteur STT/TTS ou base de données peut être
remplacé sans réécrire le noyau. Le noyau ne contient jamais `if provider == X`.

### I7 — Réversibilité
Toute mise à jour est rollbackable. Toute action à risque est réversible ou exige
une confirmation explicite. Un backup jamais restauré n'est pas un backup.

---

## 3. Les huit renforcements de la v0.2

La v0.1 décrivait un bon système. La v0.2 corrige ce qui, en pratique, le rendait
lourd à maintenir ou faussement sécurisé.

### R1 — Dépendances minimales, et justifiées
Chaque dépendance doit gagner son droit d'exister : pourquoi elle est nécessaire,
pourquoi une API native ne suffit pas, sa licence, les données qu'elle voit, sa
stratégie de mise à jour, et **comment on la remplace**. Voir `04`.

### R2 — €0 récurrent comme contrainte d'architecture
Ce n'est plus un objectif d'optimisation, c'est une contrainte de conception. Le
système doit tourner **sans aucun fournisseur IA payant**. Budget cloud par défaut : **0 €**.

### R3 — Sécurité par architecture
Un LLM peut demander `send_email(...)`. Il ne peut jamais décider que l'action est
autorisée. Le Policy Engine est un point de passage obligatoire hors du modèle.
Voir `03`, et le pattern Privileged/Quarantined en `01/ADR-004`.

### R4 — Pas de base vectorielle partout
« Quelle est la référence de mon carrelage ? » appelle une donnée structurée exacte.
« Qu'avait-on décidé pour la déco du mariage ? » appelle une recherche sémantique.
**PostgreSQL et recherche hybride d'abord.** Toute base supplémentaire doit gagner
son droit d'exister sur mesure, pas sur tendance.

### R5 — MCP à sa juste place
MCP est un bon protocole d'interopérabilité et de découverte d'outils. **MCP ≠ sécurité.**
Le Policy Engine reste au-dessus, toujours.

### R6 — Mise à jour automatique réellement prévue
Jarvis ne doit jamais devenir un projet qui exige « pense à mettre à jour Whisper /
Ollama / PostgreSQL / les modèles ». Un Update Engine pipeline
`détection → téléchargement → vérification → environnement isolé → tests → benchmark → canary → promotion → surveillance → rollback`.
Une mise à jour qui échoue aux tests **n'atteint jamais la production**. Voir `07`.

### R7 — Les tests font partie du produit
Les Golden Scenarios sont des artefacts produit, pas de la dette de qualité. Ils
incluent les scénarios adversariaux. Voir `05`.

### R8 — Home Assistant / n8n ne deviennent pas le cerveau
Ce sont des couches d'intégration à la périphérie. Aucune logique métier Jarvis
n'y réside. Leur indisponibilité dégrade une capacité, jamais le noyau.

---

## 4. Architecture

```
                         USER
                           │
             ┌─────────────┼─────────────┐
           Voice          Text         Vision
             └─────────────┼─────────────┘
                           │
                    INPUT GATEWAY
                           │
                    CONTEXT ENGINE          ← le cœur du produit
                           │
                     INTENT ENGINE
                           │
                    PLANNING ENGINE
                           │
              ┌────────────┼────────────┐
           MEMORY        POLICY        MODEL
           ENGINE        ENGINE        ROUTER
              └────────────┼────────────┘
                           │
                      TOOL GATEWAY          ← seul chemin vers le monde
                           │
                   EXECUTION ENGINE
                           │
                  VERIFICATION ENGINE       ← état réel
                           │
                      EVENT LEDGER
                           │
                      USER RESPONSE
```

Deux plans transversaux :

**SAFETY PLANE** — Data Firewall, Policy Engine, coffre à secrets, sandbox, audit,
kill switch.

**EVOLUTION PLANE** — Update Engine, LAB/Twin, benchmarks, canary, rollback,
surveillance des dépendances.

---

## 5. Ce qui est le cœur, et ce qui ne l'est pas

Le cœur du produit :

```
Mémoire + Contexte + Policy + Outils + Vérification
```

Si ces cinq éléments sont excellents, les lunettes, la vision, la proactivité et la
domotique deviennent de simples interfaces supplémentaires. L'inverse n'est pas vrai.

### Ordre de priorité absolu, si les ressources manquent

```
1. Sécurité          8.  Indépendance modèle
2. Fiabilité         9.  UX vocale
3. Mémoire           10. Automatisations
4. Contexte          11. Vision
5. Policy            12. Lunettes
6. Vérification      13. Proactivité
7. Exécution locale
```

Jamais l'inverse.

---

## 6. Ce qu'on ne construit pas en v0

- Swarm multi-agents.
- Neo4j ou base vectorielle externe obligatoire.
- n8n comme cerveau.
- Écoute ou captation permanente invisible.
- Reconnaissance faciale.
- Achats ou messages autonomes.
- Agent shell non contraint.
- Fine-tuning sur les conversations personnelles comme mécanisme de mémoire.
- Mémoire hébergée uniquement dans le cloud.
- 50 outils.

Ces sujets pourront être rouverts **après** que la fiabilité V0/V1 soit démontrée,
et seulement avec un cas d'usage mesuré.

---

## 7. Critères de sortie V1

```
Policy compliance             = 100 %
Fausse confirmation d'action  = 0
Régression critique           = 0
Noyau hors-ligne              = fonctionnel
Restauration de backup        = testée
Rollback                      = testé
Optionalité du cloud          = vérifiée
Coût cloud sur 30 jours       = 0 €
≥ 95 % des interactions quotidiennes exécutées localement
```

Et Jarvis doit répondre correctement à :

> « Qu'est-ce que j'ai à faire aujourd'hui ? » · « Rappelle-moi ce que j'avais décidé
> hier. » · « Note ça. » · « Ajoute ça à ma liste. » · « Prépare un message à X. » ·
> « Qu'est-ce qui est urgent ? » · « Retrouve le document X. » · « Qu'est-ce que je
> sais sur X ? » · « Mets-moi en mode privé. » · « Qu'as-tu fait aujourd'hui ? »

---

## 8. Le principe ultime

Jarvis préfère toujours :

| plutôt que |
|---|
| **ne pas agir** — plutôt qu'agir incorrectement |
| **dire « je ne sais pas »** — plutôt qu'inventer |
| **demander confirmation** — plutôt que prendre une décision irréversible |

Une fonctionnalité spectaculaire ne justifie jamais une régression de sécurité ou
de fiabilité.
