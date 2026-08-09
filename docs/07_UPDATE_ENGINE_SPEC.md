# 07 — UPDATE ENGINE

## Le problème que ce document résout

Jarvis ne doit jamais devenir un projet qui exige :

> « Julien, pense à mettre à jour Whisper / Ollama / PostgreSQL / les modèles / les
> dépendances. »

Un assistant personnel qui réclame de la maintenance manuelle finit par ne plus être
mis à jour, puis par devenir un risque de sécurité, puis par être abandonné. L'Update
Engine n'est pas une commodité : c'est ce qui rend le projet **durable**.

Contrainte symétrique, tout aussi importante :

> **Une mise à jour qui échoue aux tests n'atteint jamais la production.**

---

## 1. Le pipeline

Aucune étape n'est optionnelle.

```
DÉTECTION
   ↓  nouvelle version disponible (dépendance, modèle, adaptateur, politique)
TÉLÉCHARGEMENT
   ↓
VÉRIFICATION
   ↓  signature (Sigstore) + intégrité + rotation de confiance (TUF)
ENVIRONNEMENT ISOLÉ (LAB)
   ↓  installation sur un clone, sans secrets de production
TESTS DE NON-RÉGRESSION
   ↓  suite complète des scénarios dorés (05)
TESTS DE SÉCURITÉ
   ↓  scénarios adversariaux B1–B12
TESTS DE CONTRAT D'OUTIL
   ↓
BENCHMARK
   ↓  qualité, latence, coût, intégrité mémoire — comparés à la référence
CANARY
   ↓  fraction du trafic réel, surveillance rapprochée
PROMOTION
   ↓
SURVEILLANCE
   ↓
ROLLBACK si régression
```

---

## 2. Ce qui peut se mettre à jour automatiquement

- Dépendances applicatives.
- Modèles locaux.
- Adaptateurs de fournisseurs et d'outils.
- Prompts et configuration.
- Correctifs de sécurité.

## 3. Ce qui ne va jamais directement en production

Tout changement touchant à :

- une politique de sécurité ;
- le modèle de permissions ;
- une migration de base de données ;
- la sémantique d'un outil ;
- le routage de modèles ;
- un effet de bord externe.

Ces changements exigent une validation étagée **et** une décision humaine explicite.

---

## 4. Intégrité : ne rien inventer

La signature de mise à jour est un problème résolu par des gens dont c'est le métier.
Nous **assemblons** (ADR-011) :

- **TUF** — distribution et rotation de confiance. Sa propriété décisive est la
  signature **M-parmi-N** : la compromission d'une seule clé ne suffit pas à publier
  une mise à jour, et la rotation de clés est prévue par le protocole plutôt que
  bricolée après coup.
- **Sigstore** — signature et provenance des artefacts.

**Une mise à jour non vérifiable est refusée.** Sans exception, sans mode dégradé,
sans option de configuration pour l'ignorer.

---

## 5. Le système Twin : LIVE et LAB

| | LIVE | LAB |
|---|---|---|
| Rôle | Jarvis réel | Clone isolé |
| Données | réelles | snapshots anonymisés |
| Secrets | production | **aucun** |
| Outils | réels | simulés |
| Effets externes | oui | **aucun** |

**Le LAB n'a jamais accès aux secrets de production.** C'est la propriété qui rend
l'ensemble sûr : une mise à jour malveillante testée dans le LAB ne peut rien
exfiltrer, parce qu'il n'y a rien à exfiltrer.

### Shadow testing

Une nouvelle version reçoit les mêmes requêtes que LIVE **sans exécuter les actions**.

```
LIVE → version N     → intention, plan, appel d'outil, réponse
LAB  → version N+1   → intention, plan, appel d'outil, réponse
```

On compare les quatre sorties. Une divergence sur l'intention ou sur l'appel d'outil
est un signal fort — bien plus informatif qu'un test unitaire, parce qu'il porte sur du
trafic réel.

---

## 6. Critères de promotion

Une version ne passe en production que si **toutes** ces conditions sont vraies :

```
tests critiques        = 100 %
tests de sécurité      = 100 %
tests de politique     = 100 %
régression             = aucune
qualité                ≥ référence
latence                ≤ seuil
intégrité mémoire      = vraie
fausse confirmation    = 0
```

Un seuil non atteint n'est jamais « acceptable pour cette fois ».

---

## 7. Mise à jour de modèle

Un nouveau modèle ne devient **jamais** production automatiquement. Il passe :

```
benchmark Jarvis → benchmark sécurité → benchmark outils
→ benchmark mémoire → benchmark latence
```

### La règle qui compte

> **Un modèle globalement plus intelligent peut être refusé s'il est moins fiable
> pour Jarvis.**

Le meilleur modèle n'est pas celui qui gagne les classements généraux. C'est celui qui
se trompe le moins sur *nos* tâches : français, commandes, ambiguïtés, extraction,
mémoire, appel d'outils, respect des politiques, refus corrects, taux d'hallucination.

Cette règle a une conséquence pratique : le benchmark Jarvis doit exister **avant** la
première mise à jour de modèle, sinon il n'y a rien à comparer.

---

## 8. Canary

Après promotion, la nouvelle version reçoit d'abord une fraction du trafic réel.

Surveillance rapprochée sur : taux de succès, taux de vérification, latence p95, coût,
taux de clarification, erreurs d'outils, et **taux de fausse confirmation**.

---

## 9. Rollback

Toute mise à jour est réversible. On conserve :

```
version_courante · version_précédente · backup · état_de_migration
```

**Le rollback automatique se déclenche** dès qu'une métrique critique se dégrade —
sans attendre une décision humaine. Une régression détectée à 3 h du matin ne doit pas
attendre le réveil.

Une migration de schéma doit toujours avoir : migration, rollback, backup, test
d'intégrité. Une migration sans chemin de retour n'est pas déployable.

---

## 10. Canaux

```
SECURITY      ← appliqué en priorité, pipeline complet malgré l'urgence
STABLE        ← production
BETA          ← LAB uniquement
EXPERIMENTAL  ← LAB uniquement
```

La production utilise **STABLE + SECURITY**. L'urgence d'un correctif de sécurité
raccourcit les délais, jamais le pipeline.

---

## 11. Backups

- Chiffrés.
- Versionnés.
- Locaux d'abord ; copie distante chiffrée optionnelle.
- **Jamais de secrets en clair.**

Portent : mémoire, configuration, politiques, configuration des outils, journal d'audit.

### Test de restauration

> **Un backup jamais restauré n'est pas un backup.**

Périodiquement, automatiquement :

```
backup → environnement temporaire → restauration → contrôle d'intégrité
```

Si la restauration échoue, c'est un incident de sévérité maximale — au même titre
qu'une faille.

---

## 12. Reprise après sinistre

Depuis une machine vierge :

```
1. restaurer le backup
2. vérifier l'intégrité
3. redémarrer le noyau
4. reconstruire les index
5. vérifier les politiques
6. passer le diagnostic
7. revenir en LIVE
```

Ce chemin est testé, pas documenté en théorie.

---

## 13. Mode dégradé

Même avec des composants cassés :

```
Vision OFF · Cloud OFF · Calendrier OFF
```

Jarvis continue avec ses autres capacités, et **dit** ce qui est indisponible.

---

## 14. Auto-maintenance : ce qui est permis

✅ Redémarrer un service · reconstruire un index · retenter une opération · changer de
modèle · nettoyer un cache · vérifier les backups · effectuer un rollback.

❌ Supprimer une protection · modifier une règle de sécurité · exfiltrer des données ·
élargir les droits du modèle · désactiver l'audit · supprimer des logs.

> **Auto-maintenance ≠ auto-destruction.**

---

## 15. Auto-diagnostic

Commande : « Jarvis, fais ton diagnostic. »

```
Core        OK
Memory      OK
Policy      OK
Models      OK
Tools       14/15 OK
Storage     72 %
Security    OK
Updates     2 en attente
Backup      restauration testée il y a 3 jours
```

Surveillance continue : latence, erreurs, outils défaillants, coût, mémoire, espace
disque, température, disponibilité des modèles, sécurité, versions, état des backups.
