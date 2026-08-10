# 17 — MATRICE DES DÉFAILLANCES DU MONDE RÉEL

**Foundation 2.2.** État mesuré au commit courant. Ce document dit ce qui est
**prouvé**, ce qui est **partiel**, et ce qui est **intestable aujourd'hui** —
sans jamais confondre les trois.

---

## 1. La métrique fondamentale

Toutes les lignes de ce document se ramènent à une seule mesure :

```text
Pour toute opération déclarée AT_MOST_ONCE :

    operation_key = X   ⟹   external_effect_count ≤ 1
```

Ce n'est pas une métaphore. C'est ce que compte la sonde
`tests/redteam/probes/crash-probe.ts` : le nombre de lignes réellement créées
dans le monde, après un processus tué et redémarré.

Tout le reste — journal d'intention, `UNKNOWN` qualifié, refus de rejeu — n'est
que le moyen de tenir cette inégalité.

---

## 2. Pourquoi PostgreSQL local ne suffit pas

Le monde réel n'est pas une base à un millimètre du processus :

```text
Jarvis → Internet → API → répartiteur → service → base → worker
```

Et à **chaque flèche** :

timeout · rejeu automatique du client · réponse dupliquée · réponse retardée ·
connexion coupée · `500` · `429` · réponse produite mais perdue · fournisseur
qui traite sans répondre · fournisseur qui répond deux fois · fournisseur qui
change de comportement sans prévenir.

Les scénarios éprouvés aujourd'hui tournent contre PostgreSQL en local, où les
fenêtres se comptent en **millisecondes**. Un fournisseur à 800 ms de latence
ne change pas la logique — il rend les états transitoires **cent fois plus
fréquents**. Ce qui est rare devient courant, et ce qui est courant finit par
arriver.

---

## 3. La matrice

`✅` prouvé par un test nommé · `◐` partiel · `⏳` intestable aujourd'hui,
par absence du composant.

### Pannes de processus et de base

| Incident | Attendu | État | Preuve |
|---|---|---|---|
| Crash avant le journal | exécution unique à la reprise | ✅ | point A — 1 effet |
| Crash après `PLANNED` | exécution unique | ✅ | point B — 1 effet |
| Crash pendant l'appel | `UNKNOWN`, aucun rejeu | ✅ | point C — 0 effet |
| Crash après l'effet externe | `UNKNOWN`, **≤ 1 effet** | ✅ | point D — **1 effet, pas 2** |
| Crash avant persistance du résultat | `UNKNOWN`, ≤ 1 effet | ✅ | point E |
| Crash après persistance | relecture confirme | ✅ | point F |
| Redémarrage | état retrouvé, tentatives ≤ 1 | ✅ | chaque reprise est un processus neuf |
| Base coupée | refus d'agir, message explicite | ✅ | `redteam/failure-modes` |
| Base coupée puis revenue | reprise seule + `DATABASE_RECOVERED` | ✅ | exécution réelle |
| Connexion inactive tuée | le processus survit | ✅ | `redteam/db-resilience` |
| Migration interrompue | rollback | ◐ | descente vérifiée à chaque suite ; **interruption au milieu non testée** |

### Défaillances d'outil

| Incident | Attendu | État | Preuve |
|---|---|---|---|
| Outil indisponible | aucun succès déclaré | ✅ | `fault_error` |
| Outil qui lève | `Result` typé + trace au journal | ✅ | `redteam/failure-modes` |
| Retour mensonger (`200`, rien fait) | `FAILED` | ✅ | `fault_lies` |
| Timeout avant effet | `UNKNOWN` + `PROVIDER_TIMEOUT` | ✅ | `fault_timeout` |
| Timeout après effet | `UNKNOWN`, ≤ 1 effet | ✅ | `intent-journal` |
| Relecture impossible | `UNKNOWN` + `NO_OBSERVATION` | ✅ | `fail-closed` |
| Double commande, même clé | ≤ 1 effet | ✅ | `tools/idempotency` |
| Même clé, arguments différents | refus | ✅ | `tools/idempotency` |

### Défaillances de fournisseur — **aucune n'est testable aujourd'hui**

Il n'existe **aucun fournisseur distant** dans le dépôt (`docs/11 §2`).

| Incident | Attendu | État |
|---|---|---|
| Réponse perdue | `UNKNOWN`, aucun rejeu | ⏳ |
| Réponse dupliquée | ≤ 1 effet | ⏳ |
| Réponses réordonnées | ≤ 1 effet | ⏳ |
| `500` après l'effet | `UNKNOWN` | ⏳ |
| `429` | aucun effet supplémentaire, aucun rejeu | ⏳ |
| Succès partiel (3 destinataires sur 5) | **`PARTIAL`** | ⏳ — **le statut n'existe pas** |
| Fournisseur indisponible | dégradation propre, **aucun repli interdit** | ⏳ |
| Modèle indisponible | refus, jamais d'escalade vers un palier non autorisé | ⏳ |
| Partition réseau | sécurité conservée | ⏳ |

Trois de ces lignes sont **bloquantes pour Foundation 4** :

- **succès partiel** — `PARTIAL` doit exister avant le premier outil capable de
  réussir à moitié. Après, la migration coûtera cher ;
- **fournisseur indisponible** — c'est le test décisif de `docs/14 §4` : le
  système doit refuser plutôt qu'escalader ;
- **réponse dupliquée** — le seul cas où l'inégalité `≤ 1` peut être violée par
  le fournisseur lui-même, sans faute de Jarvis.

### Sécurité sous panne

| Incident | Attendu | État | Preuve |
|---|---|---|---|
| Permission absente | refus | ✅ | `policy/gate` |
| Donnée RED + sortie réseau | refus sec | ✅ | `fail-closed` |
| Mode privé | aucune sortie | ✅ | `policy/gate` |
| Modèle compromis | le Policy Engine gagne | ✅ | `redteam/authority` |
| Mémoire compromise | le Policy Engine gagne | ✅ | `redteam/authority` |
| Injection dans un document | traitée comme donnée | ◐ | `quarantine/injection` — **chemin non branché** |
| Sortie de modèle prise pour autorité | impossible | ✅ | ADR-024, `fail-closed` |
| Mise à jour défectueuse | rollback automatique | ⏳ | aucun Update Engine |

---

## 4. Décompte honnête

| | Nombre |
|---|---|
| ✅ prouvé par un test nommé | **26** |
| ◐ partiel | **3** |
| ⏳ intestable — composant absent | **10** |

**Les 10 `⏳` ne sont pas des lacunes de test. Ce sont des lacunes de produit.**
Aucun ne deviendra testable en écrivant un test : il faut d'abord qu'un
fournisseur distant existe.

---

## 5. Ce que Foundation 3 devrait construire

> **Un banc de défaillances, avant les fonctionnalités.**

Pas un ensemble de tests supplémentaires : un **fournisseur factice hostile**,
placé derrière le contrat de `docs/15`, capable de produire à la demande :

```text
latence variable · timeout · réponse dupliquée · réponse perdue ·
réponse réordonnée · connexion coupée · 500 · 429 · succès partiel ·
indisponibilité · changement de comportement en cours de session
```

Et une seule assertion, répétée sur chaque combinaison :

```text
external_effect_count ≤ 1
```

**Pourquoi avant les fonctionnalités**, et pas après : chaque outil ajouté sans
ce banc est un outil dont on ne saura pas s'il double sous panne. Le coût de
découvrir un doublon en production sur un virement est sans commune mesure avec
le coût de construire le banc.

C'est aussi le seul moyen de rendre testables les 10 `⏳` — un fournisseur
factice hostile est plus utile qu'un vrai fournisseur, parce qu'il produit à
volonté ce qu'un vrai ne produit qu'une fois par mois.

---

## 6. Ce que cette matrice ne dira jamais

Trois choses, qu'aucun banc ne peut établir :

**La fenêtre irréductible.** Entre l'écriture `EXECUTING` et le retour de
l'appel, il existe un instant où le processus peut mourir sans que personne ne
sache. Le journal d'intention la réduit au minimum et la fait toujours pencher
vers `UNKNOWN` — il ne la supprime pas. La supprimer exigerait une transaction
distribuée avec le fournisseur, qu'aucune API réelle n'offre.

**Le comportement d'un fournisseur qui change.** Un service peut modifier sa
sémantique d'idempotence entre deux versions, sans préavis. Aucun test écrit
aujourd'hui ne le détectera — seule une surveillance continue le ferait.

**La charge.** Rien n'a été éprouvé au-delà de quelques opérations séquentielles.
Le comportement sous concurrence — deux appels sur la même clé d'opération en
parallèle — n'est **pas testé**. C'est un manque nommé, et le plus probable
prochain endroit où une faille se cache.
