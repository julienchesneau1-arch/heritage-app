# Inventaire des écrans

Un écran redessiné qui perd un état perd une fonctionnalité. Chaque entrée
donne **la fonction, les états, les données affichées et les contraintes**.

Les captures correspondantes sont dans `captures/`.

---

## Chrome — présent sur toutes les pages

### Barre du haut (`src/components/Nav.tsx`)

- Titre « Héritage », lien vers l'accueil.
- À droite : « Famille » et le nom du membre courant (lien vers `/qui`).
  Si aucun membre n'est identifié : « Qui êtes-vous ? ».
- Une ligne d'entrées : **Aujourd'hui**, puis les sections **non vides**,
  puis **Raconter** (en accent).
- Un `<details>` « Tout le reste » qui déplie les sections vides, chacune
  avec **une phrase disant à quoi elle sert**.
- `aria-current="page"` + soulignement sur la page courante.
- **Aucun badge, aucun compteur, aucune pastille.**

Les sept sections et leur condition d'ouverture :

| Section | Visible quand | Rôle affiché dans « Tout le reste » |
|---|---|---|
| Veillée | ≥ 1 récit | Trois récits à lire à voix haute quand la famille est réunie. |
| Récits | ≥ 1 récit | Tout ce qui a été gardé, du plus récent au plus ancien. |
| À mettre au propre | ≥ 1 brouillon | Les enregistrements transcrits, à relire avant de les garder. |
| Archives | ≥ 1 archive | Les photos, les documents, les enregistrements. |
| Traditions | ≥ 1 tradition | Ce qui revient chaque année, et qu'on ne veut pas perdre. |
| Graphe | ≥ 1 entité | Les personnes, les lieux, les objets — et ce qui se dit de chacun. |
| Le livre | ≥ 1 récit | Tout ce qui a été gardé, composé pour le papier — avec ce qui manque. |

### Pied de page (`src/app/layout.tsx`)

Deux liens, toujours : **« Exporter la mémoire »** (§6.3) et **« Ce que
l'application fait de votre mémoire »**.

### Lien d'évitement

Premier élément focalisable : « Aller au contenu », invisible jusqu'au focus.

---

## `/` — Aujourd'hui

**Fonction.** Au plus une chose à faire, ou rien.

**États, par ordre de priorité :**

1. **Pas de contexte** → redirection vers `/bienvenue`.
2. **Pas de membre identifié** → redirection vers `/qui`.
3. **Mémoire vide** (0 récit et 0 fil) → **Le premier jour**, ci-dessous.
4. **Un Passeur** : question + justification + « Répondre » + « En faire un
   récit » + « Ne plus me montrer ».
5. **Un signal temporel** : une occasion datée du jour, avec sa raison, et
   « Ne plus me montrer ».
6. **Ni l'un ni l'autre** : seul « La mémoire de la famille X. » reste.
   **C'est un résultat valide, pas une page cassée.**

**Contraintes.** Un Passeur maximum. Un signal maximum. Justification
obligatoire sous chaque suggestion.

### Le premier jour (`src/components/premier-jour.tsx`)

L'écran le plus important du produit : c'est là que la règle des deux
secondes se joue. Trois phrases, dans cet ordre — **ce que c'est**, **comment
ça marche**, **quoi faire** :

> Ici, la famille X se raconte.
> Quelqu'un dit une chose. Quelqu'un d'autre ajoute la sienne. Quand il y en
> a assez, cela devient un récit qui reste.
> Rien à rédiger : personne n'écrit de mémoires ici. Une phrase suffit, et
> elle peut être dite à voix haute.

Puis **un seul champ**, un sélecteur « qui parle », un bouton.

En dessous, **un seul autre chemin**, en lien souligné et **jamais en
bouton** — il ne doit pas rivaliser avec l'action :

> La famille se parle peut-être déjà ailleurs — dans un groupe WhatsApp, où
> tout défile et où personne ne retrouve rien. → Reprendre une conversation
> existante

**Testé :** un seul `<ChampDeParole>`, un seul `<Link>`, aucun `btn` sur ce
lien, aucune visite guidée ni liste d'étapes à cocher, moins de 320
caractères pour les trois phrases.

---

## `/fils/[threadId]` — Le fil

**Fonction.** Parler à plusieurs, à peu de frais. La forme vient des salons
de discussion, le moteur non.

**Affiché par message :** le corps, **la voix** (narrateur si déclaré, sinon
auteur — « Membre anonymisé » si la personne s'est retirée), la date, les
trois marques.

**Actions :** répondre (champ + « qui parle »), marquer, **« Retirer mes
mots »** (uniquement sous ses propres messages, et seulement avec une
identité vérifiée), « En faire un récit ».

**États :** fil ancré à une entité / à un récit / à rien ; fil vide
impossible (l'ouvrir, c'est déjà y parler) ; fil déjà cristallisé → « Lire
le récit ».

**Interdits spécifiques :** aucun non-lu, aucune présence, aucune saisie en
cours, aucun décompte de marques, aucune date de dernière activité.

---

## `/recits` — Récits

**Fonction.** La seule vue exhaustive. Toutes les vues bornées y renvoient.

**Filtres :** recherche plein texte insensible aux accents (`?q=`), type de
structure (`?type=`), inclure les archivées (`?archivees=`), page (`?page=`).

**Par ligne :** titre, auteur (ou « Auteur anonymisé »), date — sous la
forme « noté le … » si l'événement n'est pas daté — type de structure, et
les marqueurs « archivé » / « en quarantaine ».

**Trois états vides distincts, et c'est le cœur de cette page :**

| Situation | Ce qui s'affiche |
|---|---|
| Aucun récit du tout | « Aucun récit pour l'instant. » |
| Aucune correspondance, archives comprises | « Aucun récit ne correspond… » |
| Aucune correspondance **active**, mais des archivés correspondent | « Aucun récit actif ne correspond » **+ le nombre d'archivés qui correspondent**, avec le lien pour les inclure |

**Pagination :** 50 par page, et l'annonce « Récits 51 à 63 sur 63 ».

---

## `/recits/[storyId]` — Un récit

**Affiché :** titre ; **« Raconté par X, noté par Y »** (la voix d'abord, la
plume ensuite) ; date de l'événement ou « noté le … » ; type de structure ;
ton ; le texte intégral ; les entités liées ; **les chaînes de transmission**
— « né de X », « a engendré Y », en **liens qu'on suit**, jamais en compteur ;
les fils attachés ; la provenance si le texte vient d'une transcription
(modèle utilisé, qui l'a vérifiée, quand).

**Actions :** « Poser une question », « Archiver », « Raconter la suite »,
« Corriger », « Supprimer » (identité vérifiée, auteur ou narrateur
seulement).

---

## `/recits/nouveau` — Raconter

**Fonction.** L'autre porte, pour ceux qui veulent écrire.

**Champs :** titre, texte, **narrateur choisi séparément de l'auteur**, date
de l'événement (facultative — et si elle manque, elle manque, on ne la
fabrique pas), type de structure, ton, entités mentionnées, récit parent
(quand on répond à une transmission).

**Deuxième chemin :** l'enregistrement vocal (`AudioRecorder`), qui produit
un **brouillon** à relire — jamais un récit direct.

---

## `/veillee` — La veillée

**Fonction.** Trois récits, un par écran, faits pour être lus à voix haute
quand la famille est réunie.

**Quatre écrans successifs (`?etape=`) :**

1. **Ouverture** : « 3 récits, à lire à voix haute. Ce sont les mêmes pour
   toute la famille ce soir. » + « Personne n'a choisi ces récits pour vous
   plaire. Chacun est là pour une raison, qui vous sera dite avant de le
   lire. »
2 à 4. **Un récit** : « 1 sur 3 », titre en très grand, auteur, date, **la
   raison de sa présence**, puis le corps en `text-xl leading-loose` — c'est
   du texte à lire debout, à voix haute.
5. **Clôture** : « Voilà. » puis « Quelqu'un se souvient-il d'autre chose ?
   C'est le moment de le dire à voix haute — pas de l'écrire. » et
   **« L'application n'a pas besoin d'être ouverte pour que la mémoire
   passe. »** Deux actions : « Noter ce qui a été dit », « Refermer ».

**Il n'y a pas de quatrième récit.** C'est un choix, pas une limite technique.

**État vide :** « Il n'y a pas encore de récit à lire ensemble. » + « Raconter
le premier ».

---

## `/graphe` — Le graphe

**Fonction.** Une image à saisir d'un coup d'œil, **et** la porte vers les
fils d'entités.

**Composition :** une entité au centre, ses voisins immédiats. **Au plus 8
récits et 12 éléments**, quelle que soit la taille de la mémoire. Cercles :
bleu personne, marron lieu, orange objet, rouge récit. Traits gris = liens
**déclarés**, jamais déduits. Légende obligatoire.

**Sous le graphe :** le fil de cette entité, le champ pour y parler, et la
liste des récits qui en parlent.

**Contraintes :** ni zoom, ni physique de particules — ce n'est pas un outil
d'exploration. Et **la vue dit ce qu'elle cache** : « 8 récits affichés sur
14 ».

**États :** sans `?entite=`, un index des entités les plus reliées. Entité
sans récit actif : « Aucun récit actif ne mentionne cette entité ».

---

## `/traditions`

**Par tradition :** nom, description, **quand elle revient** — « Chaque
année, le 15 octobre », « Chaque mardi », « Chaque mois » — et, si elle
dort, la raison.

**Actions :** « Nous l'avons faite » (seulement le jour où elle tombe),
« Endormir » / « Réveiller ». Formulaire d'ajout en bas.

**Ni compteur d'accomplissements, ni date de dernière fois.** « Endormir »
est le verbe qui compte : une tradition qui s'arrête n'est pas un échec, et
c'est **l'application** qui dit avoir cessé de la proposer.

---

## `/archives`

Liste des photos, documents et enregistrements : titre, type, date de dépôt,
poids, récit rattaché. Téléversement borné à 50 Mo, types contrôlés.

**État vide :** « Aucune archive. »

---

## `/brouillons` — À mettre au propre

**Fonction.** Les transcriptions en attente de relecture humaine. **Aucune
transcription n'entre dans la mémoire sans qu'un humain l'ait validée** —
Whisper invente des phrases, surtout sur les silences et les voix hésitantes.

**Par brouillon :** date d'enregistrement, qui l'a demandé, l'état
(en attente / prêt / échoué).

**Sur `/brouillons/[draftId]` :** le texte proposé, **les passages douteux
signalés**, l'audio réécoutable, l'édition libre, la validation.

**État vide :** « Aucun brouillon en attente. » Et quand rien n'est douteux :
la page le dit sans prétendre avoir vérifié ce qu'elle ne pouvait pas.

---

## `/importer` — Reprendre une conversation

**Fonction.** Le seul chemin qui ne demande pas de produire du neuf.

**Déroulé :** choisir un fichier (export WhatsApp, Messenger ou SMS) →
**analyse dans le navigateur, le fichier ne part jamais** → association des
participants aux membres → **cocher les moments à garder** → envoi des seuls
passages cochés.

**Affiché :** la plage de dates lue (pour vérifier d'un coup d'œil que le
fichier n'a pas été lu en mois/jour), le nombre de lignes **non
rattachées** — comptées, jamais devinées ni jetées en silence — et
l'avertissement sur les échanges à deux, qui ont été écrits à une seule
personne.

---

## `/famille`

**Trois blocs :**

1. **Le lien de la famille** — `/f/<id>`, ce qu'il permet, le jeton de
   secours, et **« Changer ce lien »** avec sa conséquence dite d'avance.
2. **Les membres** — nom, génération, naissance, décès, « en un mot », et la
   case **« ne pas faire figurer ces dates au calendrier »**. Par membre :
   son lien personnel, son adresse de calendrier, « Révoquer ce lien »,
   « Retirer de la famille ».
3. **Le calendrier** — ce qu'on donne à Google ou Apple en s'abonnant, dit
   **avant** de donner le lien, pas après.

Puis « Reprendre une conversation » et « Ajouter un membre ».

---

## `/transmission` — Ce que l'application fait de votre mémoire

**Fonction.** La reddition de comptes. Accessible par le pied de page.

**Trois sections :**

1. **Ce que l'algorithme écarte** : récits jamais revus depuis 12 mois,
   récits sur-exposés, récits mis en sourdine, distorsion. Chacun avec sa
   note explicative, **et un tiret cadratin quand la mesure est impossible**.
2. **Ce que la forme du produit fait à la parole** : la part des messages
   notés par quelqu'un d'autre que celui qui parle.
3. **Rappel patrimonial** : les récits non relus depuis douze mois, listés
   ici **et nulle part ailleurs**.

Puis **« Ce qui ne figure plus ici »** — la page nomme le chiffre qu'elle a
cessé d'afficher, parce que le retirer en silence serait le retirer deux fois.

---

## `/livre` — Le livre

**Fonction.** La sortie. La seule pièce qui serve la dispensabilité.

**Composition :** page de titre ; les récits dans leur **filiation** — un
récit né d'un autre est en retrait, avec un filet ; « Raconté par X, noté par
Y » ; « Date de l'événement non renseignée » quand c'est le cas.

Puis **« Ce que ce livre ne dit pas »**, qui est le cœur de l'objet :

- les **questions restées sans réponse**, chacune suivie de **lignes vides
  pour écrire à la main** ;
- les **récits dont on ignore la date** ;
- les **personnes qu'aucun récit ne mentionne**.

Puis le **colophon** : « 5 récits imprimés sur 5 conservés par la famille X.
2 récits sont nés d'un autre. »

**Contraintes :** rien n'est borné ; aucun lien, aucun QR code, aucune
adresse ; le navigateur fabrique le PDF, aucun service externe.

---

## Écrans d'entrée et de bord

| Route | Fonction |
|---|---|
| `/commencer` | Créer une famille et son premier membre. Le seul écran avant qu'une famille existe. |
| `/bienvenue` | Cette adresse n'est rattachée à aucune famille. Explique le lien privé, propose de commencer ou de restaurer. |
| `/qui` | Se déclarer membre (identité **déclarée**, qui ne permet pas de supprimer). |
| `/restaurer` | Recharger un export Héritage. |
| `/f/[familyId]` | Entrée par le lien familial : pose le cookie, redirige. |
| `/f/[familyId]/m/[memberId]/[token]` | Entrée par le lien personnel : identité **vérifiée**. |
| `/hors-ligne` | Servie par le Service Worker quand le réseau manque. |

---

## Les deux niveaux d'identité — à rendre lisibles

Ce n'est pas un détail technique : c'est ce qui autorise ou interdit de
détruire, et l'interface doit le montrer.

| Lien | Identité | Peut |
|---|---|---|
| `/f/<familyId>` | **déclarée** | lire, écrire, questionner, répondre, archiver |
| `/f/<familyId>/m/<id>/<jeton>` | **vérifiée** | tout cela, **et supprimer ses propres récits et messages** |

Quand une action de destruction est refusée faute d'identité vérifiée, le
message dit **quoi faire** — « il faut un lien personnel » — et non « accès
refusé ».
