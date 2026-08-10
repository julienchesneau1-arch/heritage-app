# 17 — MATRICE DES DÉFAILLANCES DU MONDE RÉEL

**Foundation 2.2.** État mesuré au commit courant. Ce document dit ce qui est
**prouvé**, ce qui est **partiel**, et ce qui est **intestable aujourd'hui** —
sans jamais confondre les trois.

---

## 1. La métrique fondamentale

> ⚠ **Corrigée par Foundation 3.** L'énoncé initial de cette section était faux
> dès qu'un outil aurait plusieurs cibles. Voir `docs/18 §2`.

Toutes les lignes de ce document se ramènent à une seule mesure :

```text
Pour toute opération déclarée AT_MOST_ONCE :

    (operation_key = X, cible = C)   ⟹   external_effect_count ≤ 1
```

La mention de la **cible** n'est pas un raffinement. Un envoi à cinq
destinataires produit légitimement cinq effets : sans elle, l'inégalité est
violée par une opération parfaitement correcte. Elle est restée invisible tant
qu'aucun outil n'avait plusieurs cibles — elle était fausse quand même.

Ce n'est pas une métaphore. C'est ce que comptent les sondes
`tests/redteam/probes/crash-probe.ts` et `tests/lab/world.ts` : le nombre
d'effets réellement produits dans le monde, après un processus tué, redémarré,
ou concurrencé par vingt autres.

Tout le reste — journal d'intention, `UNKNOWN` qualifié, refus de rejeu,
compare-and-swap — n'est que le moyen de tenir cette inégalité.

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

### Défaillances de fournisseur — **éprouvées depuis Foundation 3**

Le banc `tests/lab/` fournit désormais un fournisseur hostile capable de
produire ces pathologies à la demande, avec contrôle du moment de l'effet.

| Incident | Attendu | État | Preuve |
|---|---|---|---|
| Réponse perdue | `UNKNOWN`, aucun rejeu | ✅ | `lab/provider-lies` |
| `500` après l'effet | `UNKNOWN`, jamais `FAILED` | ✅ | `lab/provider-lies` — **défaut HIGH-8 corrigé** |
| `429` / `503` | aucun effet, aucun rejeu | ✅ | `lab/provider-lies` |
| Succès annoncé sans effet | jamais `CONFIRMED` | ✅ | `lab/provider-lies` |
| Fournisseur indisponible | `UNKNOWN`, aucun repli automatique | ✅ | `lab/provider-fallback` |
| Repli A → B, même clé | ≤ 1 effet | ✅ | `lab/provider-fallback` |
| Repli A → B, **nouvelle clé** | ≤ 1 effet | ❌ | **trou nommé** — `docs/19 §3`, INV-R1 |
| Succès partiel (3 sur 5) | **`PARTIAL`** | ❌ | `lab/partial` — **le statut n'existe pas** |
| Effet différé après la réponse | réconciliation | ❌ | `lab/provider-lies` — **dette nommée** |
| Réponses réordonnées | ≤ 1 effet | ⏳ | non simulé |
| Modèle indisponible | refus, jamais d'escalade | ⏳ | aucun routeur |
| Partition réseau | sécurité conservée | ⏳ | non simulé |

Trois lignes restent **bloquantes pour Foundation 4** :

- **succès partiel** — `PARTIAL` doit exister avant le premier outil capable de
  réussir à moitié. Spécifié en `docs/19 §2` ; après, la migration coûtera cher ;
- **repli à nouvelle clé** — le seul cas mesuré où l'inégalité est violée sans
  faute du Gateway. C'est un invariant de routeur, pas un défaut du noyau ;
- **effet différé** — un fournisseur asynchrone fait dire `FAILED` à Jarvis
  d'une action qui aboutira. Exige une réconciliation qui n'existe pas.

### Concurrence — **section ouverte par Foundation 3**

`docs/17 §6` annonçait ce manque comme « le plus probable prochain endroit où
une faille se cache ». Elle s'y cachait.

| Incident | Attendu | État | Preuve |
|---|---|---|---|
| 2 / 10 / 100 / 1 000 appels simultanés, même clé | ≤ 1 effet | ✅ | `lab/concurrency` — **défaut CRIT-3 corrigé** |
| 4 processus distincts, même clé | 1 seul engagement | ✅ | `lab/multiprocess` |
| Reprise concurrente depuis `PLANNED` | ≤ 1 effet | ✅ | `lab/concurrency` |
| Reprise concurrente après crash post-effet | ≤ 1 effet | ✅ | `lab/crash-concurrency` |
| Reprise concurrente `NO_EFFECT` | ≤ 1 effet | ✅ | `lab/crash-concurrency` — **défaut CRIT-4 corrigé** |
| Perdant d'une course | « rien tenté », jamais « échec » | ✅ | `lab/multiprocess` |
| Concurrence multi-**machines** | ≤ 1 effet | ⏳ | non architecturé |

### Exfiltration — **mesurée, plus seulement déclarée**

| Incident | Attendu | État | Preuve |
|---|---|---|---|
| Donnée sensible traitée localement | 0 sortie réseau | ✅ | `lab/exfiltration` |
| Cloud activé, traitement local | 0 sortie réseau | ✅ | `lab/exfiltration` |
| Résolution DNS pendant un traitement local | aucune | ✅ | `lab/exfiltration` |
| La sentinelle voit réellement une sortie | témoin négatif | ✅ | `lab/exfiltration` |

Mesuré en interceptant `net.Socket.prototype.connect` et `dns.lookup` — donc
**sous** le code applicatif, et non sur la foi du Policy Gate.

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

| | Foundation 2.2 | **Foundation 3** |
|---|---|---|
| ✅ prouvé par un test nommé | 26 | **45** |
| ◐ partiel | 3 | **3** |
| ❌ trou ou dette **nommés** | 1 | **4** |
| ⏳ intestable — composant absent | 10 | **4** |

Les six lignes passées de `⏳` à `✅` ne l'ont pas été en écrivant des tests
contre un vrai fournisseur : le banc en fournit un **hostile**, capable de
produire à volonté ce qu'un vrai ne produit qu'une fois par mois.

Les quatre `❌` sont des **lacunes de produit**, pas de test : `PARTIAL`
n'existe pas, le routeur n'existe pas, la réconciliation différée n'existe pas.
Elles sont désormais nommées et spécifiées (`docs/19`), ce qui est la seule
chose qui les distingue d'un oubli.

Les quatre `⏳` restants exigent une architecture absente : multi-machines,
réordonnancement, partition réseau, escalade de modèle.

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

**La charge.** ~~Rien n'a été éprouvé au-delà de quelques opérations
séquentielles.~~ **Résolu par Foundation 3** — et la faille annoncée y était
bien : 20 effets pour une clé unique à 100 appels simultanés (`docs/18 §1`).
Éprouvé désormais jusqu'à 1 000 appels intra-processus et 100 appels répartis
sur quatre processus.

Ce qui reste hors de portée : la concurrence **multi-machines**. Toutes les
garanties reposent sur PostgreSQL comme point de sérialisation unique. Une base
répliquée en écriture les invaliderait toutes, sans qu'aucun test actuel ne
s'en aperçoive.
