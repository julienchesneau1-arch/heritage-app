# 29 — LA MIGRATION QUI T'ATTEND

**Une seule décision est demandée, et elle ne peut pas être prise par le code.**

---

## Pourquoi ce document existe

Le Data Firewall se construit en quatre étapes. Trois sont livrées et tournent :

| | | Direction |
|---|---|---|
| **F1** | classification `docs/14 §3`, branchée à rien | pure |
| **F2** | le Policy Gate consulte le niveau | rétrécit |
| **F3** | journal d'égression consultable (**C4**) | additif |
| **F4** | **migration des colonnes stockées** | **élargit** |

Les trois premières ne peuvent que refuser davantage ou observer. **F4 est la
seule migration du dépôt dont l'erreur expose une donnée** : une ligne `GREEN`
mal convertie devient `PUBLIC`, c'est-à-dire *envoyable*.

Un défaut dans le cloisonnement bloque une action légitime — ennuyeux, visible,
corrigible. Un défaut ici n'arrête rien : il expose, en silence.

`docs/14 §5` le dit dans ces termes :

> `GREEN → PUBLIC` : ⚠ **à vérifier ligne par ligne avant migration.** Une donnée
> aujourd'hui `GREEN` par défaut d'attention deviendrait publiquement envoyable.
> **La migration doit défaillir plutôt que deviner.**

La vérification ligne par ligne porte sur **tes** données. Ce n'est pas une
décision d'agent.

---

## Ce qui est déjà fait

La migration est **écrite, testée, et hors du chemin du lanceur** :

```text
infrastructure/db/migrations-en-attente/0013_data_level.up.sql
infrastructure/db/migrations-en-attente/0013_data_level.down.sql
```

`ops/db/migrate.ts` ne lit que `migrations/`. Le placement est la garantie —
pas une note qu'on pourrait oublier de lire.

**Elle ne devine jamais.** Toute ligne `GREEN` dont la catégorie ne confirme pas
le caractère public fait **échouer** la migration en la nommant, et la
transaction est annulée : rien n'est à moitié converti.

Le refus est éprouvé, pas déclaré — `tests/privacy/migration-data-level.test.ts`
sème exactement les lignes que `docs/14 §5` redoute, joue le SQL réel, et
vérifie qu'il refuse. Avec son contrôle négatif : une base propre passe.

---

## ⚠ REVUE LIGNE PAR LIGNE — faite le 19/08/2026, deux défauts BLOQUANTS

Julien a demandé que cette revue soit conduite à sa place. Elle l'a été, sur la
base de test, en transaction annulée. **Résultat : ne pas appliquer cette
migration en l'état.**

### Ce qui est SAIN — vérifié, pas supposé

| Point | Vérification |
|---|---|
| `data_category` et `privacy_class` sont `NOT NULL` | pas de piège `NULL <> 'WEATHER'`, qui aurait laissé passer une ligne non confirmée |
| Le garde-fou refuse et NOMME la ligne | mesuré : mémoire `GREEN`/`PERSONAL_MEMORY` → refus ; note `GREEN` → refus |
| Contrôle négatif | base sans `GREEN` → passe ; `GREEN`/`WEATHER` → passe |
| Table des planchers | les 14 catégories de `docs/14 §3` sont couvertes par le `CASE`, aux bons niveaux |
| Ordre des branches | `RED` avant les catégories `SENSITIVE` : une donnée ne peut que MONTER |
| La descente | ne retire que l'information fine, ne peut rien exposer |

**La propriété pour laquelle cette migration a été écrite tient.** Elle ne devine
pas.

### Défaut n°1 — ⚠ BLOQUANT : après application, Jarvis ne peut plus rien écrire

```text
INSERT INTO notes    …  → null value in column "data_level" violates not-null constraint
INSERT INTO memories …  → null value in column "data_level" violates not-null constraint
```

`data_level` est `NOT NULL` **sans `DEFAULT`**, et **aucun `INSERT` de `src/` ne
le renseigne** — ni `src/tools/notes.ts`, ni `src/core/memory/store.ts`.

Appliquer la migration aujourd'hui, c'est perdre la création de notes et
l'écriture en mémoire **à la première utilisation**.

Pourquoi personne ne l'avait vu : toute la vérification portait sur le
**garde-fou** — *refuse-t-elle de deviner ?* — et aucune sur l'état du système
**après**. On avait éprouvé la porte, jamais la pièce d'après.

### Défaut n°2 — le plancher de catégorie ne tient plus après la migration

```text
HEALTH + data_level = 'PUBLIC'      → ACCEPTÉ   ⚠
CREDENTIAL + data_level = 'PUBLIC'  → refusé    ✓
```

`docs/14 §3` pose *« le niveau ne peut que monter »*. La migration l'applique
**une seule fois**, dans son `UPDATE`. Ensuite, seule `CREDENTIAL` reçoit une
contrainte permanente : `HEALTH` et `FINANCIAL` n'en ont aucune.

Le jour où le code apprendra à écrire `data_level` (défaut n°1), c'est **lui
seul** qui tiendra le plancher. Or `docs/14` dit l'inverse :

> le niveau ne peut que monter. Même mécanique que `strictest()` dans le Policy
> Gate — et ce doit être le **même code**, pas un second mécanisme qui lui
> ressemble.

Un plancher tenu par la seule application **est** un second mécanisme.

### Ce qu'il faut faire avant d'appliquer

1. **Un `DEFAULT`** sur `data_level`, ou le code qui l'écrit — sans quoi rien ne
   s'écrit plus. Si `DEFAULT`, ce doit être `'PERSONAL'` : `docs/14` pose
   `OTHER → PERSONAL` comme *défaut fermé*.
2. **Les contraintes de plancher** pour `HEALTH` et `FINANCIAL`, sur le modèle
   de `memories_credential_restricted` qui, lui, fonctionne.
3. **Trancher** : `privacy_class` survit à la migration. Deux registres du même
   fait cohabitent, et ADR-041 dit ce qui arrive ensuite. Soit une contrainte
   les lie, soit une migration ultérieure retire l'ancien.

Les trois constats sont **figés en tests** dans
`tests/privacy/migration-data-level.test.ts` : ils tomberont dès qu'un correctif
sera posé, ce qui est leur fonction.

### ⚠ Un piège que ce document t'aurait fait rencontrer

Les commandes `psql` ci-dessous **ne nomment aucune base**. Or `.env` définit
`JARVIS_DB_NAME=jarvis_dev`.

Je suis tombé dedans en conduisant cette revue : ma première tentative a visé
`jarvis_dev` au lieu de `jarvis_test`, et sur un **pool** de connexions — de
sorte que le `BEGIN` n'englobait rien. Aucun dégât (les colonnes ne se sont pas
créées, et aucun code du dépôt n'écrit `GREEN` dans ces tables), mais l'erreur
était réelle et c'est une barrière de nom de base qui l'a arrêtée.

**Avant chaque commande de cette page : vérifie sur quelle base tu es.**

```sql
SELECT current_database();
```

---

## Ce qu'il te reste à faire

### 1. Regarder

```sql
SELECT id, data_category, privacy_class, left(content, 60)
  FROM memories WHERE privacy_class = 'GREEN';

SELECT id, privacy_class, left(content, 60)
  FROM notes    WHERE privacy_class = 'GREEN';
```

Pour chaque ligne, une seule question :

> **Cette donnée peut-elle partir sur Internet ?**

Pas « est-elle anodine ». Pas « me gênerait-elle ». **Peut-elle sortir.**

### 2. Trancher

| Réponse | Geste |
|---|---|
| oui, réellement publique | `data_category = 'WEATHER'` — la seule catégorie dont le plancher est `PUBLIC` |
| non, ou je ne sais pas | `privacy_class = 'ORANGE'` — le doute se résout vers la protection |

**Les notes n'ont pas de catégorie.** Aucune ne peut donc être confirmée
publique, et leur présence en `GREEN` bloque la migration par construction.
C'est voulu : une note sans catégorie est exactement le « `GREEN` par défaut
d'attention » que le document redoute.

### 3. Appliquer

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f infrastructure/db/migrations-en-attente/0013_data_level.up.sql
```

Si elle refuse, elle nomme les lignes fautives : retour à l'étape 1.

### 4. Ranger

Déplacer les deux fichiers dans `migrations/` et enregistrer la version dans
`schema_migrations`, pour que le lanceur ne la rejoue pas.

---

## Ce qui reste vrai si tu ne fais rien

**La protection est déjà là.** F2 est livrée : une donnée `SENSITIVE` n'atteint
aucun palier cloud, même cloud activé — c'est le test que `docs/14 §6` désigne
comme le plus important, et il passe.

F4 n'ajoute pas de protection. Elle rend la classification **plus fine** en
base, et elle est le préalable au Model Router de `docs/04 §10`.

Autrement dit : **rien ne presse, et c'est exactement pour ça qu'elle attend.**
