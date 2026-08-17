# Migrations écrites, testées, et NON APPLIQUÉES

Ce répertoire n'est **pas** lu par `ops/db/migrate.ts`. C'est délibéré.

Il contient les migrations dont l'application demande une **décision humaine**
que rien dans le code ne peut prendre à la place de l'utilisateur.

---

## 0013 — `DataLevel` remplace `PrivacyClass`

**Pourquoi elle n'est pas dans `migrations/` :** c'est la seule migration du
dépôt dont l'erreur **expose une donnée**.

Toutes les autres rétrécissent — elles ajoutent une contrainte, un refus. Un
défaut y bloque une action légitime : ennuyeux, visible, corrigible. Celle-ci
**élargit** : une ligne `GREEN` mal convertie devient `PUBLIC`, c'est-à-dire
*envoyable*. Le défaut ne bloque rien, il expose en silence.

`docs/14 §5` l'exige explicitement :

> `GREEN → PUBLIC` : ⚠ **à vérifier ligne par ligne avant migration.** La
> migration doit défaillir plutôt que deviner.

La vérification ligne par ligne porte sur des données réelles que seul leur
propriétaire peut arbitrer.

**La marche à suivre est en `docs/29`.** Le préalable non négociable :

```sql
SELECT id, data_category, privacy_class, left(content, 60)
  FROM memories WHERE privacy_class = 'GREEN';
SELECT id, privacy_class, left(content, 60)
  FROM notes    WHERE privacy_class = 'GREEN';
```

**Ce qui la rend sûre malgré tout :** elle ne devine jamais. Toute ligne `GREEN`
dont la catégorie ne confirme pas le caractère public fait **échouer** la
migration en la nommant, et la transaction est annulée — rien n'est à moitié
converti. Le refus est éprouvé par `tests/privacy/migration-data-level.test.ts`.

**Pour l'appliquer**, une fois la relecture faite :

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f infrastructure/db/migrations-en-attente/0013_data_level.up.sql
```

Puis déplacer les deux fichiers dans `migrations/` et enregistrer la version
dans `schema_migrations`, pour que le lanceur ne la rejoue pas.
