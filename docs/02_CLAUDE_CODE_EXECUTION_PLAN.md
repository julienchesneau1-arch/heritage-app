# 02 — PLAN D'EXÉCUTION

Le plan est organisé en phases avec des **portes de sortie**. Une porte n'est pas une
revue de bonne volonté : c'est une liste de conditions vérifiables. Tant qu'une porte
n'est pas franchie, la phase suivante ne commence pas — même si elle est plus
intéressante.

---

## Règle de séquencement

> Une phase se termine quand ses tests passent, pas quand son code est écrit.

Et, avant chaque implémentation :

> Si une brique open source mature couvre le besoin sans perte fonctionnelle ni perte
> de sécurité, la proposer **avant** d'implémenter. Voir `08_LANDSCAPE_AUDIT.md`.

---

## Phase −1 — Audit du terrain ✅ **TERMINÉE**

**Objectif.** Déterminer ce qu'on assemble et ce qu'on développe, avant d'écrire du code.

**Livrable.** `08_LANDSCAPE_AUDIT.md`.

**Porte de sortie.**
- [x] Chaque brique candidate est évaluée : maturité, licence, données vues, stratégie
      de remplacement.
- [x] La frontière assembler/développer est explicite et justifiée.
- [x] ADR-005 (moteur de politique → **Cedar**) et ADR-016 (stack → **TypeScript +
      Swift**) sont tranchés — 9 août 2026.
- [ ] **Julien valide la frontière assembler / développer.** ← *en attente*
- [ ] Banc de mesure exécuté (`08 §7`) — 7 questions ouvertes, dont le WER français et
      la latence de bout en bout.

---

## Phase 0 — Fondations

**Objectif.** Une architecture locale sûre. Aucune intelligence, aucun outil externe.

**Livrables.**
- Dépôt, séparation des environnements (`dev` / `test` / `lab` / `production`).
- Configuration hors code (`config/`, `policies/`, `models/`, `tools/`).
- PostgreSQL + migrations + schéma mémoire initial.
- Event Ledger append-only chaîné (ADR-012).
- Policy Engine : échelle d'autonomie L0–L4 + hiérarchie de règles.
- Interfaces fournisseurs vides + **test de contrat qui échoue le build** si un SDK
  fournisseur est importé hors `/providers/`.
- Coffre à secrets (keychain OS), jamais dans le dépôt.
- Harnais de test + CI (lint, unit, contrats, sécurité, politiques).

**Porte de sortie — franchie le 9 août 2026, vérifiable par `pnpm gate:phase0`.**
- [x] Migration et rollback testés dans les deux sens.
- [x] Le journal est inaltérable : un `UPDATE` ou `DELETE` échoue au niveau des
      permissions PostgreSQL, pas de l'application. Vérifié sur **trois**
      barrières — permissions, trigger (y compris pour le propriétaire), et
      détection d'altération par chaînage de hash lorsque les deux premières
      sont désactivées.
- [x] Le test de contrat fournisseur échoue bien quand on l'enfreint volontairement
      (test négatif sur `tests/fixtures/violating-core-file.ts.fixture`).
- [x] Aucun secret dans l'historique git (scan automatisé, motifs testés).
- [x] La CI tourne sur chaque commit.

> **Note de mise en œuvre.** L'immuabilité du journal rend les tests
> non idempotents : les scénarios de détection d'altération laissent
> délibérément une chaîne rompue, qu'un journal append-only ne permet pas de
> réparer. La suite repart donc d'un schéma recréé à chaque exécution
> (`tests/global-setup.ts`), ce qui vérifie au passage les migrations dans les
> deux sens.

---

## Phase 1 — Mémoire et Contexte

**Objectif.** Le cœur du produit. C'est ici que Jarvis devient utile ou reste un jouet.

**Livrables.**
- Memory Engine : M1 travail, M2 épisodique, M3 sémantique, M4 préférences,
  M5 règles, M6 intentions, M7 décisions, M8 journal d'activité.
- Chaque mémoire porte : `confidence`, `source`, `privacy_class`, `created_at`,
  `last_verified_at`, `expiration`.
- Distinction stricte `FACT` / `INFERENCE` / `HYPOTHESIS` / `EXTERNAL_CLAIM`.
- Memory Guard : le modèle **propose** une mémoire, il ne l'écrit jamais directement
  (validation → classification → confiance → déduplication → stockage).
- Recherche hybride structuré → lexical → sémantique + RRF (ADR-002).
- Context Engine : résolution de « celui-ci », « le projet », « Paul », « comme la
  dernière fois » ; détection d'ambiguïté ; **paquet de contexte minimal**.

**Porte de sortie — franchie le 9 août 2026, vérifiable par `pnpm gate:phase1`.**
- [x] Un email affirmant « Julien aime X » devient `EXTERNAL_CLAIM`, jamais une
      préférence. Le type est *coercé* de `PREFERENCE` vers `SEMANTIC` et la
      confiance plafonnée à 0,4 — une préférence dicte le comportement futur,
      elle ne peut pas naître d'une lecture.
- [x] Face à trois « Pierre » connus, Jarvis demande — il ne choisit pas. Il ne
      tranche que sur **preuve contextuelle** (une seule des homonymes évoquée
      dans la session), jamais sur une heuristique de popularité.
- [x] Le contexte envoyé au modèle est borné et mesuré ; jamais un vidage de
      base. Ce qui est écarté est **déclaré**, pas tronqué en silence.
- [x] Recherche mémoire fonctionnelle **réseau coupé** — testée sur les deux
      chemins : fournisseur absent et fournisseur en panne.
- [x] Les trois voies de récupération sont rapportées séparément, avec leur
      temps d'exécution.

> **Notes de mise en œuvre.**
> — L'extension `pgvector` est créée au *bootstrap*, pas en migration : elle
> exige un privilège que le rôle de migration ne doit pas posséder. La migration
> vérifie sa présence et échoue avec un message clair si elle manque.
> — La dimension du vecteur est figée à 768 (EmbeddingGemma). Descendre est
> possible par troncature Matryoshka ; monter (BGE-M3 = 1024) exigera une
> migration et un réencodage. Le coût est documenté dans la migration plutôt que
> découvert plus tard.
> — Chaque vecteur porte le modèle qui l'a produit, et la recherche filtre
> dessus : un changement de modèle ne peut pas comparer silencieusement des
> vecteurs de familles différentes.

---

## Phase 2 — Outils et vérification

**Objectif.** Agir sur le monde, et savoir si l'on y est parvenu.

**Livrables.**
- Tool Gateway + contrats stricts (voir `03 §Contrat d'outil`).
- Séparation Privileged / Quarantined (ADR-004) et étiquetage de provenance.
- Idempotence : clé d'idempotence sur toute mutation.
- Verification Engine : après chaque mutation externe, relire l'état réel et comparer
  l'attendu à l'obtenu → `CONFIRMED` / `PROBABLE` / `UNKNOWN` / `FAILED`.
- Les 5 premiers outils : `memory_add`, `memory_search`, `task_create`, `task_list`,
  `note_create`.

**Porte de sortie — franchie le 9 août 2026, vérifiable par `pnpm gate:phase2`.**
- [x] Une commande répétée pour cause d'erreur réseau ne crée pas de doublon. Le
      rejeu **relit l'état réel** au lieu de rejouer un résultat mémorisé : un
      rejeu ne peut donc pas affirmer un succès que le monde ne confirme plus.
- [x] Une mutation dont la vérification échoue est rapportée comme `FAILED`,
      jamais comme un succès. `CONFIRMED` n'est produit qu'à un seul endroit du
      code, et cette fonction exige une preuve en argument.
- [x] Aucun outil ne reçoit un secret via le modèle. Un outil qui ne déclare
      aucun secret reçoit une carte vide, pas le coffre.
- [x] Un paramètre sensible provenant d'une source non fiable déclenche une
      confirmation **portant sur la valeur concrète**. Un paramètre dont la
      provenance n'est pas déclarée est traité comme non fiable.

> **Notes de mise en œuvre.**
> — `egress` est **dérivé du contrat d'outil**, jamais fourni par l'appelant :
> sinon il suffirait de mentir sur ce champ pour contourner le mode privé.
> — L'ordre des étapes du Gateway est la sécurité elle-même. Deux inversions
> seraient fatales : injecter les secrets avant la politique donnerait une clé à
> une action qui va être refusée ; journaliser avant la vérification écrirait un
> succès que rien ne prouve.
> — La capture d'annulation (ADR-019) est câblée, mais **son exécution ne l'est
> pas** : les `inverseToolId` désignent des outils qui arriveront avec l'Undo
> Engine. La capture est un enregistrement, pas une exécution — et c'est elle
> qui ne se rattrape pas.
> — Un timeout produit `UNKNOWN`, jamais `FAILED` : l'action a peut-être abouti
> côté fournisseur.

---

## Phase 3 — Les 10 outils restants

**Livrables.** `task_complete`, `calendar_read`, `calendar_create`, `calendar_update`,
`file_search`, `web_search`, `briefing_generate`, `reminder_create`, `system_status`,
`audit_query`.

**Porte de sortie.**
- [ ] Les 15 outils passent leurs tests de contrat.
- [ ] `audit_query` répond correctement à « Qu'as-tu fait aujourd'hui ? » **depuis le
      journal**, pas depuis le modèle.
- [ ] Chaque outil déclare sa réversibilité, son niveau de risque et sa méthode de
      vérification.

---

## Phase 4 — Confidentialité, coût, indépendance

**Livrables.**
- Data Firewall : classification, redaction, décision d'égression, journal consultable.
- Mode privé (cloud OFF, réseau externe OFF, indicateur visible).
- Cost Engine + budget mensuel (défaut **0 €**), alerte 50 %, blocage dur 100 %.
- Model Router (capacité, pas fournisseur) + fallback.
- Benchmark Jarvis local.

**Porte de sortie.**
- [ ] Audit réseau en mode privé : **0 requête sortante inattendue**.
- [ ] Tests d'indépendance A–E (voir `05`) passent tous.
- [ ] L'utilisateur peut voir ce qui est parti sur Internet, sans lire un log.
- [ ] Un mois simulé à **0 €**.

---

## Phase 5 — Voix

**Livrables.** VAD, activation, STT local (ADR-008), TTS local (ADR-009), barge-in,
Audio Gateway abstrait.

**Porte de sortie.**
- [ ] Interruption perçue **< 300 ms**.
- [ ] STT fonctionnel réseau coupé.
- [ ] Le pipeline audio est substituable (test : changer de moteur STT par
      configuration seule).

---

## Phase 6 — Interfaces

**Livrables.** Application iOS (4 écrans : principal, mémoire, contrôle, audit),
App Intents (ADR-013).

**Porte de sortie.**
- [ ] Les contraintes d'App Intents sont respectées, pas contournées.
- [ ] Le tableau de bord confidentialité et le journal d'audit sont lisibles par un
      humain.

---

## Phase 7 — Update Engine et LAB/Twin

**Livrables.** Voir `07_UPDATE_ENGINE_SPEC.md`.

**Porte de sortie.**
- [ ] Une mise à jour volontairement défectueuse est **bloquée avant la production**.
- [ ] Le rollback automatique se déclenche sur régression d'une métrique critique.
- [ ] Le LAB n'a **aucun** accès aux secrets de production.

---

## Phase 8 et au-delà — sur preuve seulement

Vision, domotique, lunettes, proactivité. Chacune exige un cas d'usage mesuré, une
fréquence estimée, un impact confidentialité et un impact en cas de panne (`04`).

**La proactivité est désactivée par défaut** et reste le dernier sujet abordé.

---

## Ce qui arrête une phase immédiatement

- Un invariant de sécurité (`00 §2`) est violé.
- Un test de politique échoue.
- Une dépendance est ajoutée sans sa fiche (`04`).
- Un secret apparaît dans un prompt, un log ou le dépôt.
- Une réponse de modèle est traitée comme une preuve d'action.

Dans tous ces cas : **s'arrêter, expliquer, corriger.** Ne pas contourner pour faire
passer le test.
