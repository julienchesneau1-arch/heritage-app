# Transmission : Héritage — direction « 2a Pleins aplats, allégé »

## Vue d'ensemble
Direction visuelle retenue pour rendre l'app Héritage plus vivante sans qu'elle devienne un jeu : couleur en aplat plein écran (une teinte par écran), formes rondes en décor, une action évidente par écran. Construite sur le design system **Organic** du projet (crème / terre cuite / sauge, Caprasimo + Figtree, coins ronds, boutons pilule).

Cette direction a traversé trois itérations dans la conversation de design :
1. Une première version « pleins aplats » plus chargée (nav complète, bloc « De qui on parle » sur l'écran du Passeur, phrase d'app en plus du titre).
2. Une passe de contraste et de taille : tous les textes remontés à 16 px minimum (contrainte 10–70 ans), fonds descendus d'un cran de rampe pour tenir 4.5:1.
3. **2a**, la version allégée retenue : la nav du premier jour tombe à l'essentiel, le Passeur reste seul sur son écran (son bloc « De qui on parle » a été retiré — sa place est le graphe, pas encore dessiné), et la hiérarchie se fait par la couleur et l'espace plutôt que par la taille du texte, puisque tout est à 16 px ou plus.

## À propos des fichiers de design
Les fichiers de ce dossier sont des **références de design en HTML** — des maquettes montrant l'apparence et le contenu attendus, pas du code à copier tel quel dans l'app. La tâche est de **recréer ces designs dans l'environnement Claude Code existant** (React/Vue/composants internes, quel que soit le framework du projet), en réutilisant ses patterns établis — pas d'importer du HTML brut.

## Fidélité
**Haute fidélité** sur la palette, les tailles, les espacements et le texte : ce sont les valeurs finales du design system Organic. **Basse fidélité** sur deux points signalés ci-dessous (police auto-hébergée, contenu factice) qui restent à trancher côté implémentation.

## Écrans

### 1. Aujourd'hui — premier jour (famille sans aucun récit)
**But** : convaincre en une phrase, obtenir un premier récit sans qu'il ait l'air d'un formulaire.
**Fond** : aplat plein `--color-accent-700` (terre cuite).
**Structure** (de haut en bas) :
- Bandeau `--color-accent-800`, padding `--space-6 --space-6 --space-4` : ligne « Héritage » (Caprasimo, 22px) + « Famille · Claire » à droite (souligné, `--color-accent-200`) ; ligne « Aujourd'hui » (soulignement 3px, couleur `--color-accent-2-300`, `aria-current="page"`) + bouton « Raconter » (`.btn.cta`, fond `--color-accent-2-300`, texte `--color-accent-2-900`) aligné à droite ; ligne « ▸ Tout le reste » séparée par un filet.
- Zone titre, padding `--space-6 --space-6 --space-4`, `position: relative`, `overflow: hidden` : cercle décoratif 200×200px `border-radius: 50%` fond `--color-accent-2-600` positionné `top: -60px; right: -60px`. Titre H2 44px « Ici, la famille Martin se raconte. » couleur `--color-bg`. Deux paragraphes 19px/1.62 (`.lire`) couleur `--color-accent-100` : « Quelqu'un dit une chose... » et « Rien à rédiger... ».
- Carte de saisie : `.card.elev-md`, fond `--color-neutral-100`, texte `--color-text`, marge `--space-6 --space-4 --space-4`, padding `--space-6`, `gap: --space-4`. Contient : label Caprasimo 18px « Dites une première chose » ; zone de texte `.input` min-height 104px placeholder « Une phrase, ou trois mots. » ; sélecteur `.input.champ` « Qui parle · Claire ▾ » ; bouton `.btn.btn-primary.cta` pleine largeur, min-height 56px, 19px, « Envoyer ».
- Paragraphe `--color-accent-200` : « La famille se parle peut-être déjà ailleurs — dans un groupe WhatsApp, où tout défile et où personne ne retrouve rien. » + lien souligné « Reprendre une conversation existante » (`--color-accent-2-200`).
- Pied de page (`.pied`, fond `--color-accent-800`, `margin-top: auto`) : liens « Exporter la mémoire » et « Ce que l'application fait de votre mémoire », `--color-accent-200`, soulignés.

### 2. Aujourd'hui — Le Passeur (famille active)
**But** : présenter la suggestion du jour (le Passeur) et donner accès au reste de l'app sans surcharger l'écran.
**Fond** : `--color-bg` (crème).
**Structure** :
- Nav `.nav` fond `--color-accent-800`, texte `--color-bg` : marque « Héritage » + « Aujourd'hui » à droite.
- Rangée d'onglets sous la nav, padding `--space-4 --space-6 0` : « Aujourd'hui » (actif, souligné 3px `--color-accent-500`), « Récits », « Le livre » (texte atténué), bouton `.btn.btn-primary.cta` « Raconter » aligné à droite.
- Bloc Le Passeur, padding `--space-8 --space-6 --space-6` : étiquette `.label.text-muted` « Le Passeur » ; carte `.card.elev-md` fond `--color-accent-300`, `position: relative; overflow: hidden`, cercle décoratif 170×170px fond `--color-accent-500` opacité 0.5 en bas-droite. Contenu : citation Caprasimo 26px « « La montre arrêtée » raconte un fait sans en donner la raison. » ; justification `.just` couleur `--color-accent-800` « Ce récit dit... » ; deux boutons empilés pleine largeur — `.btn.cta` fond `--color-accent-900` texte `--color-accent-100` 56px 19px « Répondre », puis contour même couleur « En faire un récit » ; lien souligné `--color-accent-800` « Ne plus me montrer » (aligné à gauche, pas pleine largeur).
- « ▾ Tout le reste » : liste dépliée de 7 entrées, chacune un intitulé (span, poids normal, 16px) + une phrase `.just.text-muted` : Veillée / Récits / À mettre au propre / Archives / Traditions / Graphe / Le livre. Texte exact dans le fichier de référence.
- Pied de page standard (fond crème, filet visuellement neutre puisque `.pied` n'a pas de fond ici) avec les deux mêmes liens.

### 3. Un récit (« La montre arrêtée »)
**But** : lire un récit existant, voir qui y était, remonter/descendre la chaîne de transmission, agir.
**Fond** : `--color-bg`.
**Structure** :
- Nav fond `--color-accent-2-800` (sauge foncé), texte `--color-neutral-100` : « Héritage » + « Récits ».
- Bandeau titre fond `--color-accent-2-700`, padding `--space-6 --space-6 --space-8`, cercle décoratif 170px fond `--color-accent-2-600` en haut-droite. Titre H2 36px « La montre arrêtée » ; ligne « Raconté par Robert, noté par {{ nomPlume }} » (voir État plus bas) ; ligne `.just` `--color-accent-2-200` « noté le 3 janvier 2026 · Récit fondateur · Sobre ».
- Corps de lecture, padding `--space-8 --space-6 --space-6`, deux paragraphes `.lire` (19px/1.62, `--color-text`) — texte exact dans le fichier.
- Bloc « Qui a dit quoi », filet supérieur `--color-divider`, padding `--space-6 0` : trois lignes libellé Caprasimo + noms séparés par virgule — « J'y étais » / Claire, Robert ; « Je m'en souviens » / {{ nomPlume }} ; « Je ne savais pas » / Lucas. **Des noms, jamais un compteur.**
- Bloc « Transmission », étiquette + deux liens : « Né du récit « Le dimanche à Bordeaux » » et « A engendré « La boîte à couture » ».
- Actions : bouton primaire pleine largeur 56px « Poser une question », puis rangée de boutons secondaires « Raconter la suite », « Archiver », « Corriger ».
- Pied de page standard.

### 4. La veillée (lecture guidée, thème sombre)
**But** : mode lecture à voix haute pour un moment de famille — plein écran, sombre, une action de progression.
**Fond** : `--color-neutral-900` (encre), texte `--color-neutral-200`.
**Structure** :
- En-tête : « La veillée » (`.label`, couleur `--color-accent-400`) + « 1 sur 3 » à droite.
- Barre de progression : 3 segments 8px, le premier plein `--color-accent-400`, les deux suivants `--color-neutral-800`.
- Zone titre, cercle décoratif 190px fond `--color-accent-2-800` en bas-gauche. Titre H2 44px « Le dimanche à Bordeaux » ; « Robert · 10 juin 1994 » ; justification `--color-neutral-300` max-width 30ch expliquant pourquoi ce récit est proposé (« il relie 5 personnes, lieux ou objets... n'a pas été relu depuis sa création »).
- Corps de lecture, 26px/1.6, `--color-neutral-100` (plus grand que le corps standard — lecture à voix haute, à distance).
- Bloc écoute : fond `--color-accent-400`, coins très ronds, icône ▶ ronde 52px fond `--color-accent-900`, texte « Écouter Robert le raconter — 2 min 14 » couleur `--color-accent-900`.
- Pied : bouton primaire pleine largeur 56px « Récit suivant » (fond `--color-accent-400`), bouton contour pleine largeur « Refermer ».

## États et logique
Un seul état conditionnel dans ces 4 écrans : **`nomPlume`**, affiché sur l'écran 3 (« noté par {{ nomPlume }} » et « Je m'en souviens » / {{ nomPlume }}). Contrôlé par une bascule `membreRetire` (booléen) :
- `membreRetire = false` → `nomPlume = "Claire"`.
- `membreRetire = true` → `nomPlume = "Auteur anonymisé"`.

C'est la règle produit « un membre qui quitte la famille devient anonymisé partout, jamais supprimé rétroactivement » — à implémenter comme un flag sur l'auteur, pas comme une suppression de champ.

## Design tokens (système Organic — source : styles.css du design system, copié ici sous `organic.css`)

**Couleurs**
- Fond / crème : `--color-bg #f5ead8`, `--color-surface #ebddc5`, texte `--color-text #201e1d`.
- Neutre (rampe 100→900) : `#f9f4ed, #eee7db, #dcd3c4, #c0b6a5, #a19786, #82796a, #645c50, #474238, #2e2b25`.
- Accent — terre cuite (rampe 100→900) : `#fff2eb, #ffe1d0, #ffc6a5, #f6a06b, #d67f48, #b2622d, #8c491a, #643312, #402310`.
- Accent 2 — sauge (rampe 100→900) : `#f0fae1, #e1eecc, #ccdbb2, #aebf92, #8fa073, #728157, #56633f, #3d472b, #272e1b`.
- Ne jamais utiliser directement `#c67139` / `#7a8a5e` (couleurs « accent » sans suffixe de rampe) dans ces 4 écrans — toujours passer par le numéro de rampe utilisé dans la référence.

**Typographie**
- Titres : Caprasimo (`--font-heading`), poids 400 uniquement — c'est une police d'affichage à graisse unique.
- Corps : Figtree (`--font-body`), poids 400/600/700.
- Tailles utilisées : 44px (titre premier jour) / 36–43px (titres d'écran) / 26px (citation Passeur / lecture veillée) / 22px (marque) / 19px (corps de lecture `.lire`, boutons) / 16px (tout le reste — plancher imposé par le public 10–70 ans, ne pas descendre sous ce seuil).

**Espacement** : échelle `--space-1` à `--space-8` = 4.4 / 8.8 / 13.2 / 17.6 / 26.4 / 35.2px.
**Rayons** : `--radius-sm 8px`, `--radius-md 16px`, `--radius-lg 28px` ; les écrans (cadre téléphone) utilisent `28px × 1.3 ≈ 36px`.
**Ombres** : `--shadow-sm/md/lg`, teintées encre (`#2e2b25`), jamais noir pur.
**Composants réutilisés du design system** : `.btn.btn-primary` / `.btn.btn-secondary`, `.card`, `.input`, `.nav`, `.tag`, `.label`, `.text-muted`. Classes ad hoc ajoutées pour cette direction (à recréer dans l'implémentation, pas des classes du design system) : `.ecran` (cadre téléphone 390×812), `.pied` (pied de page collé en bas), `.lire` (paragraphe de lecture 19px/1.62), `.just` (justification/explication 16px/1.5), `.cta` (bouton min-height 44px), `.champ` (champ min-height 44px).

## Points laissés ouverts (à trancher avant ou pendant l'implémentation)
1. **Police auto-hébergée.** `organic.css` charge Caprasimo et Figtree via `@import` Google Fonts. Pour un usage hors ligne fiable, ces deux polices doivent être auto-hébergées (fichiers woff2 dans le projet) plutôt que chargées à l'exécution.
2. **Contenu de démonstration.** « Claire », « Robert », « Lucas », « La montre arrêtée », « Le dimanche à Bordeaux » sont des exemples inventés pour montrer la mise en page — à remplacer par du contenu réel ou par l'état vide approprié (voir COPIE.md du projet pour les textes d'état vide déjà validés).
3. **Écrans non couverts par cette direction** : le fil de discussion, la fiche d'un récit dans le graphe, la question posée par un enfant (« Passeur inversé »), l'export du livre papier. Si la direction 2a est confirmée, elle doit être étendue à ces écrans avant l'implémentation complète — sinon Claude Code devra improviser leur style à partir des seuls tokens ci-dessus, avec un risque d'incohérence.
4. **Contraintes produit non visibles dans le HTML** (à respecter dans l'implémentation même si le fichier de référence ne les montre pas en interaction) : aucune mécanique de score/badge/compteur/série nulle part dans l'app ; un membre retiré de la famille est anonymisé, jamais supprimé rétroactivement (voir État ci-dessus) ; toute suggestion automatique (comme le Passeur) doit rester congédiable (« Ne plus me montrer ») et justifiée en une phrase, jamais un chiffre seul.

## Fichiers
- `2a-reference.html` — les 4 écrans, HTML/CSS autonome, ouvrable directement dans un navigateur.
- `organic.css` — le design system Organic complet (tokens + classes de composants) dont ce design dépend.
