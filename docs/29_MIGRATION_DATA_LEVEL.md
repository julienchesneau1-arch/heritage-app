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
