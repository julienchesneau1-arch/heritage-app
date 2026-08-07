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
| `etancheite.mjs` | fabrique deux familles et tente de lire ET d'écrire chez l'autre |
| `accessibilite.mjs` | axe-core sur 18 pages, WCAG 2.1 AA |
| `clavier.mjs` | presse Tab : pièges, contour de focus calculé, `tabindex` positif |
| `permissions.mjs` | les en-têtes servis, puis appuie sur « Enregistrer une voix » et compte les octets |
| `hors-ecran.mjs` | bascule en média `print`, produit un PDF ; coupe le réseau et vérifie le repli |
| `demarrage.mjs` | rejoue l'étage d'exécution du Dockerfile et lance sa vraie `CMD` |
| `possession.mts` | exporte une famille, la restaure, compare — retraits compris |
| `stockage-s3.mts` | fait dialoguer le pilote avec un vrai serveur S3 |
| `echelle.mjs` | fabrique 5 000 récits, mesure chaque page, efface |
| `pannes.mjs` | coupe la base pour de vrai et lit ce que la famille voit |
| `passeur.mts` | fait vivre le Passeur 180 jours, une horloge simulée dans le magasin |
| `oubli.mts` | plante un canari dans chaque objet retiré, puis fouille les 34 sorties |
| `conservateur.mts` | deux familles identiques, un seul écart : l'une ouvre Transmission |
| `signaux.mts` | joue une année d'écrans d'accueil, jour par jour, membre par membre |
| `captures.mjs` | régénère `redesign/captures/` |

`passeur.mts` et `conservateur.mts` sont les deux qui mesurent une
**durée**, et c'est ce qui les distingue de tous les autres : ils portent
sur des promesses qu'un seul jour ne peut pas mettre en défaut.

Le Passeur est ce que la famille rencontre tous les jours, et il n'avait jamais été regardé au-delà
d'un seul : ses trois manières de mal vieillir — se tarir, marteler le même
récit, laisser une règle manger les quatre autres — ne lèvent aucune erreur
et ne cassent aucun test. Le service prend son horloge en paramètre et son
magasin en injection ; on lui en fournit un dont les expirations suivent
l'horloge de la simulation, sans quoi la parcimonie « une question par
heure » bloquerait tout après le premier appel et le délai de 14 jours ne
s'écoulerait jamais. Rien n'est modifié dans le produit pour ce contrôle.

Le Conservateur, lui, se mesure par comparaison. Sa mission — « garantir
que rien ne devient inaccessible par effet d'algorithme » (§3.2) — ne se
lit dans aucun appel de fonction. On monte donc deux familles identiques,
mêmes récits, mêmes lectures, et on ne change QU'UNE chose : l'une ouvre
la page Transmission chaque jour, l'autre jamais. Si les deux ne se
comportent pas pareil, c'est que le mécanisme dépendait d'autre chose que
de lui-même.

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
- Une route répondait **« c'est fait » sur zéro ligne modifiée** : endormir
  la tradition d'une autre famille rendait HTTP 200. La donnée n'a jamais
  été en danger — le service est cloisonné — mais l'écriteau mentait.
- **Aucune page d'erreur ni de 404 en français.** Base coupée, la famille
  lisait « Application error: a server-side exception has occurred », sans
  un mot sur ce qu'il advenait de ses récits.
- **La limite de débit ne limitait rien.** `clientIp` lisait la valeur de
  gauche de `X-Forwarded-For` — celle que le client envoie. 120 requêtes
  avec une adresse inventée à chaque fois : 120 servies, sur une limite
  annoncée à 100 par minute. Et elle n'était posée que sur 2 routes sur 19,
  pendant que la checklist du document cochait la ligne comme faite.
- **Le produit proposait un mort comme relecteur.** Dans la démo par
  défaut, le grand-père est décédé en 2014 ; l'écran de l'entretien
  l'offrait pour relire l'enregistrement qu'on venait de faire sur lui.
  Les filtres ne portaient que sur `isDeleted` — « retiré de la famille ».
- **Le produit se comptait parmi les endeuillés.** Le signal du jour
  anniversaire disait : « Il y a 12 ans, Robert Martin **nous quittait**. »
  Deux fautes dans cinq mots. Le « nous » : le produit n'est pas de la
  famille, personne ne lui a demandé d'en être. « Quittait » : un
  euphémisme choisit un registre de deuil — une famille dit « mort », une
  autre « parti », une troisième ne dit rien, et ce n'est pas au logiciel
  de trancher un matin sur l'écran d'accueil. `src/lib/deces.ts` l'écrivait
  pourtant depuis le premier jour : « le ton appartient à la famille, pas
  au produit ». La phrase est devenue nominale — pas de « nous », pas
  d'euphémisme, et **aucun participe à accorder**, le produit ignorant le
  genre et n'ayant pas à le demander pour une phrase.
- **Le budget de visibilité de la §3.2 dépendait d'une visite de page.**
  `isOverexposed()` lit une clé dont `checkOverexposure()` est le seul
  écrivain, et aucun chemin du produit ne l'appelait : il n'était atteint
  que par `report()`, c'est-à-dire quand quelqu'un ouvrait la page
  Transmission ou appelait `/metrics`. Mesuré sur deux familles identiques,
  60 jours, mêmes récits et mêmes lectures — celle qui ouvre Transmission :
  récit vedette signalé **60 jours sur 60**, jamais proposé par le Passeur.
  Celle qui ne l'ouvre pas : le même récit à **52 % des impressions** pour
  un seuil de 15 %, signalé **aucun jour**, et encore proposé cinq fois.
  Une famille qui ne consulte pas ses statistiques — c'est-à-dire la
  plupart — n'avait pas de Conservateur. Le calcul se conduit désormais
  lui-même, au moment où le Passeur a besoin du verdict, avec un repère à
  six heures pour ne pas refaire le `groupBy` à chaque question.
- **Le nom d'un membre retiré ressortait en clair sur six sorties**
  mesurées — la page Archives et cinq routes d'API — et un balayage du
  source en a trouvé deux de plus, que la configuration du contrôle
  n'atteignait pas : le livre imprimé (le narrateur d'un récit, et qui a
  posé une question restée sans réponse) et la page de correction. La §2.1
  règle 1 se précise pourtant elle-même — « la règle ne dit pas anonymisé
  dans les récits, elle dit anonymisé » — et `voixDe()` la tenait dans les
  fils. Cause réelle, et c'est elle qui compte : **dix de ces sélections ne
  chargeaient même pas `isDeleted`**. La règle n'était pas oubliée, elle
  était rendue INAPPLICABLE par un `select`, sans que rien ne le signale.
  D'où `QUI` et `nommer()`, qui vont désormais par paire, et un test qui
  balaie `src/app` pour qu'aucune sélection ne puisse la redésarmer.
- **`?includeArchived=1` levait aussi le filtre des récits suspendus.** Les
  deux conditions étaient dans la même parenthèse. « Voir les archives » et
  « voir ce que l'auteur a retiré » sont deux demandes différentes, et la
  seconde n'est offerte à personne (§2.1 règle 2 amendée).
- **Le Passeur adressait 117 questions à un mort.** Sur 180 jours simulés,
  il fabriquait chaque jour une question destinée au grand-père décédé en
  2014. Personne ne les voyait jamais : trois refus en amont — la page
  d'accueil, le choix d'identité, le lien personnel — les arrêtaient toutes.
  L'invariant tenait donc par coïncidence, et non par règle : le service
  n'avait aucune garde. Une quatrième porte (une notification, un courriel,
  un flux) l'aurait ouvert sans que rien ne s'en aperçoive.
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
- **L'export garde le nom d'un membre retiré, et c'est un arbitrage.** Le
  retrait est un soft-delete, donc réversible ; anonymiser l'export rendrait
  chaque restauration définitive. `oubli.mts` classe cette sortie comme
  tolérée, avec sa raison, et l'imprime à chaque passage — quiconque détient
  le lien familial peut y lire ce nom. C'est une décision, pas une étanchéité.
- **Le type de signal `RECENT_ACTIVITY`.** Il ne s'est jamais déclenché sur
  une année simulée du jeu d'essai. Il n'est donc pas en panne — il est
  NON MESURÉ, et l'outil le nomme à chaque passage.
- **Que le budget de visibilité soit le BON seuil.** L'outil établit qu'il
  s'applique, pas qu'il soit juste : personne n'a observé une vraie famille
  pour savoir si « deux fois la part uniforme » correspond à quoi que ce
  soit de vécu.
- **La règle `RARE_PATRIMONY` du Passeur.** Sur 180 jours simulés, elle ne
  s'est jamais déclenchée : le jeu d'essai n'a pas de patrimoine assez
  ancien. Elle n'est donc pas en panne — elle est NON MESURÉE, et l'outil
  l'écrit à chaque passage plutôt que de la laisser se confondre avec les
  quatre qui ont parlé.
- **Une famille réelle.** Aucune n'a utilisé ce produit. Tout ce qui est
  écrit ici sur l'usage reste une hypothèse.

---

## Ce que les outils se sont fait à eux-mêmes

Trois défauts trouvés dans les instruments pendant cette passe, tous du
même genre que ceux qu'ils cherchent :

- `oubli.mts` **interrogeait la recherche avec le canari qu'il traquait**,
  et le champ de recherche réaffiche ce qu'on tape : trois « fuites » sur
  quatre étaient de sa main. Il plante désormais deux mots — celui qu'on
  tape, celui qu'on cherche.
- `etancheite.mjs` **comptait une requête impossible comme une porte
  fermée**. `BASE` non renseigné, application arrêtée : le corps valait
  « ERREUR … », ne contenait donc pas le secret, et les onze lectures
  croisées se déclaraient étanches sans qu'une requête soit partie.
- `etancheite.mjs` **promettait en commentaire ce que son code ne faisait
  pas** : « sans TRUST_PROXY=1, le seau reste commun et la section 8 le
  DIT ». Elle ne le disait pas — elle rendait « 73 servies » sur une
  limite de 100, en rouge, sans qu'aucune ligne du produit soit en cause.
  Et le remplacer par une lecture de `process.env` aurait interrogé le
  mauvais processus : `TRUST_PROXY` est lu par le SERVEUR. C'est donc
  mesuré — une adresse neuve juste après la rafale — et non lu.

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
