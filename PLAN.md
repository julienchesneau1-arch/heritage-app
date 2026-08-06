# Ce qu'il reste pour que l'application soit utilisable de bout en bout

Écrit le 5 août 2026, remis à jour le 6. Deux listes : **ce que vous seul
pouvez faire**, et **ce que j'ai fait**. La seconde est close. La première
est tout ce qui reste, et elle bloque la mise en ligne.

---

## A. Ce que vous devez faire — pour que ce soit en ligne et testable

### A1. Un enregistrement DNS *(5 minutes, bloquant)*

Sur la page Hostinger, dans le DNS de votre domaine :

| Type | Nom | Valeur |
|---|---|---|
| A | `memoire` (ou le sous-domaine de votre choix) | l'IP du VPS |

**Ne touchez pas à l'enregistrement de savore.** La propagation prend de
quelques minutes à une heure.

### A2. Relancer l'installateur *(2 minutes)*

```bash
cd /opt/heritage
git pull
DOMAINE=memoire.<votre-domaine> ./installer-a-cote.sh
```

Il refuse de démarrer si le nom ne résout pas encore — attendez la
propagation plutôt que de forcer. Il obtiendra le certificat, et **ne dira
« https » que s'il l'a réellement obtenu**.

### A3. Les deux tâches planifiées *(2 minutes)*

```bash
crontab -e
```

```cron
# Sauvegarde : base + archives, trente jours sur place.
0 3 * * * cd /opt/heritage && ./sauvegarde.sh >> /var/log/heritage-backup.log 2>&1

# Traitement des transcriptions en attente (voir A4 : inutile sans clé).
*/10 * * * * curl -fsS -X POST -H "x-worker-secret: $(grep TRANSCRIPTION_WORKER_SECRET /opt/heritage/.env | cut -d= -f2)" http://127.0.0.1:8081/api/transcriptions/process >/dev/null
```

Sans la première, une panne de disque emporte cinquante ans de mémoire.
C'est la seule ligne de ce document que je qualifierais d'urgente.

### A4. Une décision : la transcription *(à trancher, non bloquant)*

Deux chemins, et ils ne s'excluent pas.

**Le chemin gratuit — dans le navigateur du relecteur.** Aucune clé, aucun
coût, aucune durée maximale. Le relecteur ouvre le brouillon, clique, son
navigateur télécharge le modèle une fois (~80 Mo) puis transcrit sur sa
machine. **Je n'ai jamais pu le tester** : la bibliothèque et le modèle
viennent de jsDelivr et Hugging Face, tous deux inaccessibles depuis mon
environnement de développement — comme Docker Hub, qui avait causé la
panne du premier déploiement. C'est aujourd'hui **le plus gros inconnu du
produit**, et le premier test que je vous demanderai de faire.

**Le chemin payant — l'API.** Ajoutez `OPENAI_API_KEY=` dans
`/opt/heritage/.env` puis `docker compose up -d`. Compter environ 0,006 $
la minute d'audio. Le cron de A3 traite alors les brouillons tout seul.

Mon conseil : **ne mettez pas de clé tout de suite.** Testez d'abord le
chemin gratuit et dites-moi ce qui se passe. S'il marche, il est meilleur
sur tous les plans — coût, durée, confidentialité.

### A5. Fonder votre famille *(10 minutes)*

`https://<votre-domaine>/commencer`. Le lien personnel rendu à la fin est
**le seul qui autorise à supprimer** : gardez-le.

Puis, sur `/famille`, ajoutez les autres et **distribuez leurs liens
personnels**. Ce n'est pas du confort : tant qu'une seule personne en
détient un, la famille a un point de défaillance unique — c'est aussi le
plan de succession du lien familial.

**Ne lancez pas le seed** : il charge la famille Martin de démonstration.

---

## B. Ce que j'ai fait depuis — et ce qu'il en reste

**B1 à B4 sont faits.** La boucle de l'entretien est fermée : l'écran du
relecteur nomme qui a parlé et rappelle la question, le narrateur du récit
est la voix et non le relecteur, un brouillon effacé disparaît sans dire ce
qu'il contenait. Le geste de suspension existe à l'écran, avec son filtrage
partout et sa présence dans l'export. Les demandes portées s'affichent au
moment où quelqu'un écrit sur le sujet. Les onze écrans sont composés.

**B5 se réduit à un point, et il vous appartient** (§A4). L'audit
d'accessibilité est fait. Le pilote S3 aussi : Docker Hub est bloqué depuis
mon environnement, mais pas le registre npm — un serveur S3 complet s'y
installe, et le pilote lui a parlé pour de bon. Il reste que ce serveur
n'est pas Cloudflare R2 : rien n'est établi sur la latence, les quotas ni
les politiques de bucket. C'est un cran de plus, pas la vérification
complète.

### Ce que les outils vérifient, et ce qu'ils ont trouvé

Treize outils vivent dans `outils/`, et une seule commande les lance tous :

```bash
npm run verifier              # tout, ~6 minutes
npm run verifier -- --rapide  # sans l'échelle, ~90 secondes
```

Aucun n'est branché sur `npm test` : ils exigent un navigateur, une base
peuplée ou un serveur S3, et un test qui ne peut pas tourner partout finit
désactivé. Le détail de ce qu'ils établissent — et surtout de ce qu'ils
N'établissent PAS — est dans `outils/README.md`.

| Outil | Ce qu'il vérifie | État |
|---|---|---|
| `etancheite.mjs` | étanchéité entre familles, lecture et écriture | 36/36 |
| `accessibilite.mjs` | axe-core, WCAG 2.1 AA, 18 pages | 0 violation |
| `clavier.mjs` | tabulation réelle : pièges, contour de focus, ordre | 0 défaut, 11 pages |
| `captures.mjs` | la planche de `redesign/captures/` | 18 captures |
| `stockage-s3.mts` | le pilote S3 contre un vrai serveur S3 | 10/10 |
| `hors-ecran.mjs` | le livre imprimé, et le hors-ligne réseau coupé | 13/13 |
| `possession.mts` | l'aller-retour export → restauration, base réelle | 29/29 |
| `demarrage.mjs` | l'étage d'exécution rejoué, migrations + démarrage | 7/7 |
| `permissions.mjs` | les en-têtes, le micro, l'enregistreur de bout en bout | 12/12 |
| `echelle.mjs` | 5 000 récits fabriqués, mesurés, effacés | 12/12 |
| `pannes.mjs` | 404, base coupée, retour à la normale | 8/8 |
| `passeur.mts` | le Passeur sur 180 jours : tarissement, répétition, règles | 12/12 |
| `oubli.mts` | huit retraits confrontés à 34 sorties, par canaris | 9/9 |

Ce qu'ils ont trouvé, et qu'aucune relecture n'avait vu :

- Le nom d'un membre **retiré de la famille** ressortait en clair sur six
  sorties, et deux de plus trouvées en balayant le source. Dix sélections
  ne chargeaient même pas `isDeleted` : la règle n'était pas oubliée, elle
  était rendue inapplicable par un `select`.
- `?includeArchived=1` **levait aussi le filtre des récits suspendus** :
  « voir les archives » rendait ce que l'auteur avait retiré.
- Le Passeur adressait **117 questions à un mort**, chaque jour pendant six
  mois. Aucune n'arrivait — trois refus en amont les arrêtaient toutes — de
  sorte que l'invariant tenait par coïncidence et non par règle. Le service
  n'avait aucune garde ; une quatrième porte l'aurait ouvert en silence.
- Le plancher de 16 px de la §6.4 n'était pas tenu en vingt-neuf endroits.
- Les libellés du graphe étaient rendus à 6,6 px, et les éléments voisins
  n'étaient atteignables qu'en touchant un point de neuf pixels.
- Le contour de focus ne posait que la largeur et la couleur ; le style
  venait du navigateur — une règle dont l'effet tenait au hasard.
- `00-premier-jour.webp` montrait le sélecteur d'identité. Sans cookie de
  membre, `/` renvoie sur `/qui` : le dossier affirmait montrer un écran
  qu'il n'avait jamais chargé. La capture se prend désormais chez une
  famille vide, créée et effacée pour l'occasion.
- Et l'audit lui-même avait ses identifiants écrits en dur : une base
  re-semée, et il visitait seize pages en 404 pour conclure « 0 violation ».

C'est la même faute à chaque fois, et c'est celle contre laquelle ce
produit est écrit : **affirmer ce qu'on n'a pas établi**. Elle ne se trouve
pas en relisant. Elle se trouve en mesurant.

### B6. Trois décisions prises, et pourquoi

**La mort.** Le produit ne savait pas ce que c'était. Doctrine :
*il cesse d'être un acteur, il reste un sujet* (`src/lib/deces.ts`).
Il n'est plus proposé comme relecteur, on ne peut plus prendre son
identité, son lien personnel n'ouvre plus de session, une session déjà
ouverte retombe sur « Qui êtes-vous ? ». Il reste NARRATEUR — « je note ce
que ma grand-mère racontait » est l'objet même du produit après une mort —
ses récits restent, et sa demande portée devient définitive puisque
personne ne peut plus la lever.

**La parcimonie.** Le type de structure ne s'imprime plus sur chaque récit :
`maison-demenagement · factuel` est du vocabulaire de classement, muet pour
qui vient lire l'histoire de sa grand-mère. Il reste dans le filtre, dans
l'API et dans l'export. Retirer l'affichage n'est pas retirer la donnée.

**La primitive.** « Raconter la suite » vivait en bas de page entre
« Archiver » et « Corriger ». Elle remonte contre le texte, en geste
principal, avec la filiation dans le même bloc — sans aucun compte, la §12
interdisant le score.

Ce que je ne ferai toujours pas sans vous le demander :
- Toucher à l'audio d'un récit (« Écouter Robert le raconter »).
- Étendre les marques aux récits : décision de modèle.

---

## C. Dans quel ordre, et pourquoi

Il ne reste que votre colonne.

| | Quoi | Pourquoi maintenant |
|---|---|---|
| 1 | DNS + certificat (A1, A2) | Rien ne se teste tant que ce n'est pas en ligne, et une mémoire ne se sert pas en clair. |
| 2 | Sauvegarde en cron (A3) | Une panne de disque avant la première sauvegarde efface tout. C'est la seule ligne urgente. |
| 3 | Fonder votre famille (A5) | Sans une vraie famille, tout le reste est une démonstration. |
| 4 | Essayer la transcription locale (A4) | Le plus gros inconnu du produit, et je ne peux pas le lever d'ici. |

---

## D. L'état réel, sans arrondi

**Ce qui marche et que j'ai vérifié** : créer une famille, ses membres,
les deux niveaux de liens et leurs révocations, écrire un récit, ouvrir un
fil, marquer, retirer ses mots, la veillée, le graphe centré, les
traditions, l'import WhatsApp/Messenger/SMS, le calendrier `.ics` avec son
retrait individuel, l'export et la restauration, le livre imprimable, la
reddition de comptes, l'enregistrement d'un entretien, la réserve.

**Ce qui marche mais n'a jamais servi à personne** : tout le reste de cette
liste. Aucune famille réelle n'a utilisé cette application. C'est la seule
phrase de ce document qui vaut plus que les autres.

**Ce qui n'existait pas au 5 août et existe aujourd'hui** : la suspension
à l'écran, l'affichage des demandes portées, l'identité de la voix sur
l'écran du relecteur, l'habillage des onze écrans, et trois outils de
mesure qui refusent de conclure sur une page qu'ils n'ont pas chargée.

**Ce que je n'ai toujours pas pu vérifier**, et qui ne se vérifie pas d'ici :
la transcription locale dans un vrai navigateur (§A4). jsDelivr et Hugging
Face sont toujours injoignables depuis cet environnement — retesté, pas
supposé. Le pilote S3, lui, a été essayé contre un vrai serveur S3 ; contre
Cloudflare R2, non. Tant que la sauvegarde de §A3 tourne, le disque du VPS
suffit de toute façon.
