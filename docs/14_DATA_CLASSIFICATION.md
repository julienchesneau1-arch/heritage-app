# 14 — CLASSIFICATION DES DONNÉES

**Foundation 2.2 — spécification. Non implémenté.**

Référence : mandat Foundation 2.2 §5, `docs/12 §7`, ADR-028.

---

## 1. Le problème que ce document résout

Le dépôt possède **déjà deux systèmes de classification**, et c'est le premier
défaut à corriger avant d'en ajouter un troisième.

| Existant | Valeurs | Répond à |
|---|---|---|
| `PrivacyClass` | `RED` · `ORANGE` · `GREEN` | *cette donnée peut-elle sortir ?* |
| `DataCategory` | 14 valeurs (`CREDENTIAL`, `HEALTH`, `TASK`…) | *de quoi cette donnée parle-t-elle ?* |

`PrivacyClass` est **trop grossier** : `RED` mélange un mot de passe et un
bulletin de salaire, qui n'appellent pourtant pas le même traitement. Un mot de
passe ne doit jamais atteindre **aucun** modèle, même local. Un bulletin de
salaire peut être analysé localement.

**Décision : les cinq niveaux ci-dessous REMPLACENT `PrivacyClass`.** Ils ne
s'y ajoutent pas. Deux systèmes de classification qui coexistent finissent
toujours par diverger, et le jour où ils divergent, aucun ne fait autorité.

`DataCategory` est conservé : il répond à une autre question, et c'est lui qui
**détermine** le niveau (§3).

---

## 2. Les cinq niveaux

| Niveau | Exemple | Stockage | Modèles autorisés | Cloud | Journalisation | Rétention | Chiffrement |
|---|---|---|---|---|---|---|---|
| **PUBLIC** | météo, horaires d'ouverture | libre | tous | ✅ autorisé | contenu autorisé | libre | non requis |
| **PERSONAL** | tâches, notes, préférences | local | déterministe · local · cloud **si autorisé par requête** | ⚠ sur autorisation explicite, par requête | métadonnées seulement | illimitée, effaçable | au repos, à terme |
| **SENSITIVE** | agenda, emails, contacts, documents | local | déterministe · local **uniquement** | ❌ **interdit** | métadonnées seulement | illimitée, effaçable | au repos |
| **HIGHLY_SENSITIVE** | santé, finances, documents d'identité | local | déterministe · local **uniquement** | ❌ **interdit** | **existence seule** — jamais le contenu | durée limitée, effacement garanti | au repos, **obligatoire** |
| **RESTRICTED** | mots de passe, jetons, clés privées | coffre | **aucun** — pas même local | ❌ **interdit** | **rien**, pas même l'existence de la valeur | jusqu'à révocation | obligatoire |

### `RESTRICTED` mérite d'être lu attentivement

C'est le seul niveau où **certains traitements sont interdits même localement**.
Un secret ne doit jamais entrer dans un contexte de modèle, quel qu'il soit :

- pas dans un prompt, même local ;
- pas dans un embedding — un vecteur reste dérivé de la valeur ;
- pas dans un log, même de débogage ;
- pas dans un message d'erreur.

C'est déjà partiellement en vigueur : les secrets sont résolus **au Tool
Gateway** et remis à l'outil seul (invariant S3), et `redactString` couvre la
seconde barrière. Ce qui manque est la **classification explicite** qui rendrait
la règle vérifiable plutôt que coutumière.

---

## 3. Comment le niveau est déterminé

**Jamais par le modèle.** C'est le point que le mandat souligne, et il vaut
d'être répété :

> Le LLM ne choisit jamais lui-même son niveau de confidentialité.
> Le système le détermine **avant** lui.

Trois sources, dans cet ordre de priorité :

```text
1. CATÉGORIE          `DataCategory` → niveau plancher
                      CREDENTIAL      → RESTRICTED         (jamais négociable)
                      HEALTH          → HIGHLY_SENSITIVE
                      FINANCIAL       → HIGHLY_SENSITIVE
                      EMAIL, MESSAGE,
                      CALENDAR,
                      CONTACT,
                      DOCUMENT,
                      LOCATION        → SENSITIVE
                      TASK, PROJECT,
                      PERSONAL_MEMORY → PERSONAL
                      WEATHER         → PUBLIC
                      OTHER           → PERSONAL           (défaut fermé)

2. PROVENANCE         une valeur `EXTERNAL_UNTRUSTED` ne peut jamais
                      ABAISSER le niveau d'un ensemble

3. UTILISATEUR        peut MONTER un niveau, jamais le descendre en dessous
                      du plancher de la catégorie
```

Trois propriétés en découlent, toutes vérifiables :

- **le niveau ne peut que monter.** Même mécanique que `strictest()` dans le
  Policy Gate — et ce doit être le même code, pas un second mécanisme qui lui
  ressemble ;
- `OTHER` tombe sur `PERSONAL`, pas sur `PUBLIC`. Une catégorie inconnue est
  traitée comme personnelle : le défaut penche vers la prudence ;
- un ensemble hérite du **niveau maximum** de ses éléments. Trois tâches
  `PERSONAL` et un bulletin de salaire forment un ensemble
  `HIGHLY_SENSITIVE` — c'est l'erreur classique du RAG, qui agrège des
  fragments et perd leur classification en route.

---

## 4. L'ordre qui interdit au coût de décider

Ratifié en `docs/12 §7`, repris ici parce que c'est la conséquence directe de
cette classification :

```text
REQUÊTE
   ↓
CLASSIFICATION            ← ce document
   ↓
POLICY / CONFIDENTIALITÉ  ← quels traitements sont permis
   ↓
CAPACITÉS AUTORISÉES      ← quels modèles, quels outils
   ↓
CHOIX DU MODÈLE           ← le moins coûteux parmi les ÉLIGIBLES
   ↓
BUDGET                    ← jour / mois / plafond par opération
```

Et **jamais** :

```text
LOCAL → échec → CLOUD → échec → PREMIUM
```

La différence tient en une phrase :

> **Un modèle non autorisé n'existe pas comme repli — même si tous les modèles
> autorisés sont indisponibles.**

Le comportement attendu dans ce cas n'est pas une escalade, c'est une phrase :

> « Je peux analyser ce document localement, mais le moteur local est
> actuellement indisponible. Je ne l'envoie à aucun service externe. »

C'est `FAIL CLOSED` (`docs/13 §6`) appliqué à la confidentialité.

---

## 5. Ce que cette classification change au code existant

**Aucune ligne aujourd'hui : ce document est une spécification.** Voici ce
qu'elle impliquera.

| Élément | Changement |
|---|---|
| `PrivacyClass` (3 valeurs) | remplacé par `DataLevel` (5 valeurs) |
| `memories.privacy_class` | migration vers le nouveau domaine |
| `notes.privacy_class` | idem |
| `ToolDefinition.privacyClass` | devient le **niveau maximum** que l'outil accepte de traiter |
| Policy Gate — règle « RED + egress → DENY » | devient « niveau ≥ SENSITIVE + egress → DENY » |
| `requiresRed()` | remplacé par une table catégorie → plancher |

**Compatibilité de la migration :** `RED → HIGHLY_SENSITIVE`,
`ORANGE → PERSONAL`, `GREEN → PUBLIC`. Cette conversion est **volontairement
prudente** dans un sens et **imprudente dans l'autre** :

- `RED → HIGHLY_SENSITIVE` : les `CREDENTIAL` devront être re-classés
  `RESTRICTED` par leur catégorie, pas par leur ancienne classe ;
- `GREEN → PUBLIC` : ⚠ **à vérifier ligne par ligne avant migration**. Une
  donnée aujourd'hui `GREEN` par défaut d'attention deviendrait publiquement
  envoyable. La migration doit défaillir plutôt que deviner.

---

## 6. Tests exigés avant de considérer ce document acquis

1. `CREDENTIAL` est `RESTRICTED`, quelle que soit la classe demandée à
   l'écriture ;
2. un ensemble hérite du niveau maximum de ses éléments ;
3. l'utilisateur peut monter un niveau, jamais le descendre sous son plancher ;
4. une donnée `SENSITIVE` n'atteint aucun palier cloud, **même si tous les
   paliers locaux sont indisponibles** ;
5. une valeur `RESTRICTED` n'apparaît dans aucun prompt, aucun embedding,
   aucun log — vérifié par scan, pas par relecture ;
6. `OTHER` tombe sur `PERSONAL` et non sur `PUBLIC` ;
7. la migration depuis `GREEN` **échoue bruyamment** sur toute ligne dont la
   catégorie n'est pas explicitement publique.

Le test 4 est le plus important : c'est celui qui prouve que le coût ne décide
pas de la confidentialité.
