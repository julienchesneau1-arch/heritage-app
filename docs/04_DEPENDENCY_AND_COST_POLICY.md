# 04 — POLITIQUE DE DÉPENDANCES ET DE COÛT

Deux contraintes d'architecture, pas deux objectifs d'optimisation :

> **€0 de coût logiciel récurrent.**
> **Aucune dépendance ne va de soi.**

---

# PARTIE I — DÉPENDANCES

## 1. Le droit d'exister

Toute dépendance — bibliothèque, service, modèle, extension, protocole — doit remplir
cette fiche **avant** d'être ajoutée. Une fiche incomplète bloque le merge.

```yaml
nom:
version:
raison_d_etre:        # le besoin précis, pas "c'est pratique"
pourquoi_pas_natif:   # pourquoi une API native ou un composant existant ne suffit pas
criticite:            # CRITIQUE | IMPORTANTE | OPTIONNELLE
licence:              # + compatible avec un usage commercial futur ? oui/non
donnees_vues:         # ce que cette dépendance peut lire. Soyez précis.
acces_reseau:         # aucun | sortant | entrant | les deux
maintenance:          # dernière release, fréquence, taille de l'équipe
vulnerabilites:       # CVE connues, historique
strategie_maj:        # canal, automatisable ?
fallback:             # que se passe-t-il si elle disparaît demain ?
remplacement:         # comment on la remplace, concrètement, en combien de temps
```

Le champ le plus important est le dernier. Une dépendance dont on ne sait pas décrire
le remplacement n'est pas une dépendance : c'est un engagement.

---

## 2. Classification

| Niveau | Définition | Exigence |
|---|---|---|
| **CRITIQUE** | Sans elle, Jarvis ne fonctionne plus | **Une alternative identifiée et testée est obligatoire** |
| **IMPORTANTE** | Sa perte dégrade une capacité | Dégradation gracieuse documentée |
| **OPTIONNELLE** | Peut disparaître sans impact majeur | Aucune |

**Règle :** une dépendance CRITIQUE sans alternative testée est un défaut
d'architecture, pas un choix technique.

---

## 3. Politique de licence

| Licence | Statut |
|---|---|
| MIT, Apache 2.0, BSD, ISC | ✅ Autorisé |
| MPL, LGPL | ⚠️ Autorisé avec isolation en processus/bibliothèque séparée |
| GPL / AGPL | ⚠️ Uniquement en processus séparé, jamais lié au noyau |
| **Non commerciale** (CC-BY-NC, CPML…) | ❌ **Interdit dans le noyau** |
| Source-available non OSI (Sustainable Use, BSL…) | ⚠️ Périphérie uniquement, surveillée |

### Cas déjà tranchés

- **XTTS v2** — CPML, non commerciale → **exclu** (ADR-009).
- **n8n** — Sustainable Use License. L'usage interne personnel est libre ; la revente
  en service hébergé ne l'est pas ; certaines fonctionnalités « Enterprise » sortent de
  la licence communautaire. → **périphérie uniquement**, jamais le cerveau (ADR-015).
  À surveiller à chaque revue.

**Pourquoi cette rigueur sur un projet personnel ?** Parce qu'une licence non
commerciale au cœur du produit est une impasse silencieuse : elle ne pose aucun
problème jusqu'au jour où le projet devient autre chose, et il est alors trop tard pour
en sortir sans réécriture.

---

## 4. Fiche de sécurité par dépendance

```
maintenance · vulnérabilités · licence · permissions
accès réseau · accès aux données · historique de mises à jour · fallback
```

**Open source ≠ automatiquement sûr.** Une bibliothèque non maintenue depuis deux ans
est un risque, quelle que soit sa licence.

---

## 5. Assembler avant de développer

> Si une brique open source mature couvre le besoin **sans perte fonctionnelle ni perte
> de sécurité**, la proposer avant d'implémenter.

Les deux exceptions sont importantes :

- **Perte fonctionnelle** — la brique couvre 80 % du besoin et les 20 % restants sont
  ceux qui comptent.
- **Perte de sécurité** — la brique impose un modèle de confiance incompatible avec nos
  invariants (par exemple : elle exige de donner un accès direct au modèle).

Dans ces deux cas, développer est justifié. Dans les autres, non. Voir
`08_LANDSCAPE_AUDIT.md` pour l'application concrète de cette règle.

---

## 6. Tout service a un fallback

| Service indisponible | Comportement attendu |
|---|---|
| STT cloud | → STT local |
| Modèle local | → autre modèle local |
| Runtime local (Ollama) | → autre runtime local |
| Agenda | → cache local + notification honnête |
| Web | → réponse honnête (« je n'ai pas pu vérifier ») |
| Un outil tombe | → Jarvis continue, capacité dégradée signalée |

Jarvis doit dire :

> « Le fournisseur X est indisponible. Je bascule localement. »

Jamais :

> « Erreur inconnue. »

---

## 7. Tests d'indépendance

Exécutés à chaque release. Voir `05_GOLDEN_TESTS.md` pour les scénarios détaillés.

```
Test A — fournisseur cloud n°1 indisponible → Jarvis fonctionne
Test B — fournisseur cloud n°2 indisponible → Jarvis fonctionne
Test C — Internet indisponible              → le noyau fonctionne
Test D — Ollama indisponible                → fallback runtime local
Test E — un outil tombe                     → Jarvis continue
```

**Objectif de concentration :** aucun modèle ne doit porter plus de **70 %** des
capacités critiques. C'est une mesure, pas une intention : elle se calcule sur le
routage réel.

---

# PARTIE II — COÛT

## 8. La cible

```
Coût logiciel récurrent : 0 €/mois
```

Aucun abonnement obligatoire pour : LLM, base vectorielle, orchestration, mémoire,
transcription, TTS, automatisation.

### Ce qui reste inévitable

Électricité, matériel, connexion Internet, et éventuellement une sauvegarde chiffrée
distante. Ce sont des **coûts d'infrastructure**, pas des coûts d'API IA. La distinction
n'est pas cosmétique : les premiers sont maîtrisés, les seconds dépendent d'un tiers.

---

## 9. Le budget cloud

```
cloud_budget_monthly = 0 €     ← défaut
                     = 5 €
                     = 20 €
                     = unlimited
```

- Alerte à **50 %**.
- Blocage dur à **100 %**.
- **Aucun dépassement silencieux**, jamais.

---

## 10. Le CostGate

Tout appel cloud franchit :

```
CostGate(fournisseur, modèle, tokens_estimés, niveau_de_confidentialité, importance)
   → ALLOW_LOCAL | ALLOW_CLOUD | ASK_USER | DENY
```

Chaque appel est journalisé avec : `fournisseur`, `modèle`, `tokens`, `latence`,
`coût_estimé`, `coût_réel`, `classe_de_confidentialité`, **et la raison** du routage.

---

## 11. Tableau de bord

```
€ aujourd'hui · € cette semaine · € ce mois
appels par fournisseur
ratio local / cloud
tâche la plus coûteuse
économies réalisées par l'inférence locale
```

**Objectif : le pourcentage local augmente continûment.** S'il baisse, c'est un signal
de dérive architecturale, pas une fatalité économique.

---

## 12. Le cloud n'est jamais une fondation

Quand le cloud est utilisé :

```
Data Firewall → assainissement → choix du fournisseur → contrôle du coût
→ requête → réponse → destruction du contexte externe
```

Le fournisseur ne devient pas la mémoire. Le contexte envoyé est le minimum nécessaire,
et il est jeté après usage.

---

## 13. Critère économique de la V1

> Jarvis fonctionne **30 jours consécutifs à 0 €**, en usage réel, sans dégradation de
> l'expérience quotidienne.

Si ce test échoue, ce n'est pas le budget qu'on augmente — c'est l'architecture qu'on
corrige.
