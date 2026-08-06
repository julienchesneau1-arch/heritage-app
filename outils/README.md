# `outils/` — ce qui s'exécute, par opposition à ce qui se relit

```bash
npm run verifier            # tout, ~6 minutes
npm run verifier -- --rapide  # sans l'échelle, ~90 secondes
```

Ces outils ne sont pas dans `npm test`, et c'est délibéré : ils exigent un
navigateur, une base peuplée ou un serveur S3. Un test qui ne peut pas
tourner partout finit désactivé, et un test désactivé est pire qu'un outil
qu'on lance.

Il faut donc `.env` renseigné (`DATABASE_URL`, `FAMILY_TOKEN_SECRET`), une
base semée (`npm run db:seed`) et une compilation (`npm run build`). Le
lanceur démarre l'application si elle ne répond pas, et arrête ce qu'il a
démarré.

---

## Ce que chacun établit

| Outil | Ce qu'il exécute |
|---|---|
| `accessibilite.mjs` | axe-core sur 18 pages, WCAG 2.1 AA |
| `clavier.mjs` | presse Tab : pièges, contour de focus calculé, `tabindex` positif |
| `permissions.mjs` | les en-têtes servis, puis appuie sur « Enregistrer une voix » et compte les octets |
| `hors-ecran.mjs` | bascule en média `print`, produit un PDF ; coupe le réseau et vérifie le repli |
| `demarrage.mjs` | rejoue l'étage d'exécution du Dockerfile et lance sa vraie `CMD` |
| `possession.mts` | exporte une famille, la restaure, compare — retraits compris |
| `stockage-s3.mts` | fait dialoguer le pilote avec un vrai serveur S3 |
| `echelle.mjs` | fabrique 5 000 récits, mesure chaque page, efface |
| `captures.mjs` | régénère `redesign/captures/` |

---

## Ce qu'ils ont trouvé, et qu'aucune relecture n'avait vu

- Le micro était **fermé à l'application elle-même** : `Permissions-Policy:
  microphone=()` n'autorise personne, l'origine comprise. Le mode entretien
  ne pouvait enregistrer aucun mot en production.
- Une **restauration republiait** les récits suspendus et levait les
  quarantaines : un retrait ne survivait pas à un changement d'hébergeur.
- Une **panne de stockage passait pour une disparition** : le produit
  annonçait un enregistrement perdu alors qu'il était intact.
- Le **graphe s'effondrait à 5 000 récits** (1,58 s) : un `count` parcourait
  toute la mémoire de la famille pour en compter 42.
- Le **plancher de 16 px** de la §6.4 n'était pas tenu en 29 endroits, et
  les libellés du graphe étaient rendus à 6,6 px.
- `00-premier-jour.webp` **montrait le sélecteur d'identité** : la capture
  était prise sans cookie de membre, et `/` redirige alors vers `/qui`.

---

## Ce qu'ils NE prouvent pas

Cette section compte autant que la précédente. Un outil vert qui laisse
croire à plus qu'il n'a mesuré est exactement ce que ce dépôt combat.

- **La transcription locale dans un vrai navigateur.** jsDelivr et Hugging
  Face sont injoignables depuis l'environnement de développement — retesté,
  pas supposé. C'est le plus gros inconnu du produit.
- **Cloudflare R2.** `stockage-s3.mts` parle à un vrai serveur S3, ce qui
  n'est pas le service de Cloudflare : rien n'est établi sur sa latence, ses
  quotas, ses politiques de bucket ni les en-têtes qu'il traite autrement.
- **L'image Docker.** Les CDN de blobs des trois registres (Docker Hub,
  ghcr.io, public.ecr.aws) sont refusés par la politique du relais réseau.
  `demarrage.mjs` reconstitue l'étage d'exécution à l'identique, ce qui en
  approche le plus — mais ce n'est pas une image construite.
- **Une famille réelle.** Aucune n'a utilisé ce produit. Tout ce qui est
  écrit ici sur l'usage reste une hypothèse.

---

## La règle qui a produit tout ce dossier

Cinq fois, ces outils se sont menti avant de trouver quoi que ce soit :
un audit qui visitait des pages en 404, un contrôle clavier qui parcourait
onze fois le même écran d'accueil, un test « hors ligne » qui ne coupait
rien, un contrôle de possession qui cochait « vérifié » sur des ensembles
vides, et une sonde de performance qui chronométrait un comptage sur zéro
ligne — celle-là m'a fait publier une correction inefficace.

D'où la règle qu'ils appliquent tous : **ne rien conclure avant d'avoir
établi qu'on a mesuré quelque chose.** Chaque outil contient au moins un
contrôle de son propre contrôle — l'adresse d'arrivée, un jeu d'essai non
vide, un état fabriqué exprès. C'est la ligne la plus utile de ce dossier.
