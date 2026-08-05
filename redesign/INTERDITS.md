# Ce qu'un redesign ne doit jamais réintroduire

Chaque ligne d'ici correspond soit à une règle de la Constitution
(`HERITAGE_SPEC.md` §6, §12, Annexe A), soit à un défaut réel corrigé pendant
la construction. Ce ne sont pas des préférences de goût : ce sont les
mécaniques par lesquelles ces produits transforment une mémoire familiale en
obligation.

Les motifs listés ici sont **séduisants** — ils rendent une maquette plus
vivante, plus riche, plus « produit ». C'est exactement pourquoi ils sont
écrits.

---

## Le score, sous toutes ses formes

**Interdit :** note, pourcentage servi comme un résultat, jauge de
complétion, objectif à atteindre, palier, niveau, streak, classement,
« vous êtes dans le top », compteur de contributions par membre.

**Pourquoi :** §12, « ne pas utiliser de like ni de score ». Et une raison
que la spec ne donne pas : une famille ne peut rien faire d'un pourcentage,
sinon écrire pour le faire monter — ce qui est l'optimisation d'engagement
que la même ligne interdit.

**Ce qui a déjà été retiré pour cette raison :** la page « Transmission »
s'ouvrait sur « 23 % » en corps 4xl avec un objectif de 20 % dessous ; les
traditions affichaient « relevée 3 fois » ; la liste des récits, « a
engendré 2 récits ».

**Ce qui reste permis :** un **compte** est un fait — « 5 récits imprimés
sur 5 conservés » dans le colophon du livre est une vérification, pas une
note. La distinction : le compte permet de vérifier qu'on n'a rien perdu ;
le score classe les gens.

## Le like, et tout ce qui lui ressemble

**Interdit :** cœur, pouce, étoile, favori, décompte de réactions.

**À la place, et à conserver :** trois marques à vocabulaire fermé —
**« J'y étais »**, **« Je m'en souviens »**, **« Je ne savais pas »**. Ce
sont des **faits de première main**, pas des avis. Elles affichent des
**noms**, jamais des nombres : on voit *qui* y était, pas *combien*.

## Tout ce qui fabrique l'urgence

**Interdit :** pastille rouge, badge de non-lus, indicateur de présence
(« en ligne »), « est en train d'écrire », `@everyone`, notification poussée,
minuteur, « plus que 2 jours ».

**Pourquoi :** §6.1 et §12. Le fil emprunte sa **forme** aux salons de
discussion, jamais leur **moteur**.

## L'affichage de l'inactivité

**Interdit :** « personne n'a parlé depuis trois semaines », « dernière
activité le… », « ça fait longtemps que… », un graphe d'activité, un
calendrier de contributions.

**Pourquoi :** cela transforme un rythme familial normal en reproche. Dix
messages par mois, c'est une famille.

**Nuance importante :** `lastMessageAt` sert à **trier**, jamais à
afficher. Ordonner est utile ; montrer la décrépitude ne l'est pas.

**Une seule exception, nommée :** le « Rappel patrimonial » de la page de
reddition de comptes liste les récits non relus depuis douze mois. C'est
l'Annexe A point 5 — garantir qu'aucun récit ne devient inaccessible par
effet d'algorithme — et c'est la page où le produit s'accuse lui-même.

## Le zéro à la place d'une mesure impossible

**Interdit :** afficher `0 %`, `0/100` ou une jauge vide quand la donnée
n'a pas pu être calculée.

**Pourquoi :** « distorsion 0/100 » sur une famille sans aucune lecture
enregistrée se lit « mémoire parfaitement fidèle » alors qu'on n'a rien pu
regarder. C'est l'amendement 6, clause 1.

**Ce qu'il faut prévoir dans le design :** tout composant qui affiche un
chiffre a **deux états** — la valeur, ou un tiret cadratin **avec la raison
en `.justification` juste dessous**. L'état « non mesurable » n'est pas une
erreur : c'est le plus fréquent sur une jeune famille, et il doit être aussi
soigné que l'autre.

## La vue bornée qui se tait

**Interdit :** une liste tronquée, un graphe limité ou une page paginée qui
n'annonce pas ce qu'elle laisse dehors.

**Pourquoi :** huit points sur un graphe laissaient croire que Robert
n'apparaissait que dans huit récits alors qu'il y en avait quatorze.

**Ce qu'il faut prévoir :** « 8 récits affichés sur 14 », « Récits 51 à 63
sur 63 », « 12 récits archivés correspondent aussi » sont **des éléments du
composant**, pas des notes de bas de page à faire tenir où l'on peut.

## Plus d'une suggestion par écran

**Interdit :** une grille de cartes recommandées, un carrousel, « à
découvrir aussi », un flux infini.

**Ce qui existe :** au plus **un** Passeur et **un** signal temporel sur
l'accueil. Si les deux manquent, il ne reste que le nom de la famille — et
c'est un résultat valide, pas une page cassée.

## La suggestion sans son pourquoi

**Interdit :** afficher une question ou un récit suggéré sans la
justification qui l'accompagne.

**Pourquoi :** §6.2, dernière ligne. Le produit choisit ce qu'il montre, et
ce choix exclut le reste ; l'exclusion doit être défendable et **dite**.

**Ce qu'il faut prévoir :** le composant « suggestion » a trois zones
obligatoires — l'énoncé, la justification en petit gris, et « Ne plus me
montrer ». Aucune n'est facultative, aucune ne va dans un menu.

## L'inférence émotionnelle

**Interdit :** « un souvenir qui vous tient à cœur », « vous semblez »,
« émouvant », un code couleur par humeur, des émojis de sentiment.

**Pourquoi :** amendement 1. Le produit ne déduit jamais une émotion d'une
donnée. Le filtre est exécutable et testé.

## La date que l'on ne connaît pas

**Interdit :** afficher la date de saisie d'un récit là où le lecteur
attend la date de l'événement, sans le dire.

**Pourquoi :** « La montre arrêtée · 3 janvier 2026 » se lit comme la date
de l'histoire ; c'était le jour où quelqu'un l'a tapée.

**Ce qu'il faut prévoir :** deux formes — « 10 juin 1994 » quand
l'événement est daté, « noté le 3 janvier 2026 » sinon. Le mot compte autant
que la date.

## Le nom d'un membre retiré

**Interdit :** afficher le nom de quelqu'un qui s'est retiré de la famille,
où que ce soit — récits, fils, livre, transcriptions.

**Ce qu'il faut prévoir :** l'état **« Membre anonymisé »** partout où un
nom s'affiche. Ce n'est pas un cas rare à traiter en fin de projet : c'est
le point 6 de la Constitution, le droit à l'oubli.

## Le livre qui renvoie à l'écran

**Interdit :** QR code, adresse web, « retrouvez la suite sur… », mention
de l'application dans le livre imprimé.

**Pourquoi :** Annexe A point 7, dispensabilité. Le livre est la seule
pièce qui serve vraiment cette ligne : il doit fonctionner **sans l'app**,
et donc ne jamais y ramener.

**Et :** rien n'y est borné. Partout ailleurs le produit limite ce qu'il
montre ; le livre est la sortie, et une sortie incomplète ne libère
personne.

## Le vocabulaire de produit servi à la famille

**Interdit :** « engagement », « rétention », « taux de transmission »,
« conversion », « North Star », « onboarding », « profil ».

**Pourquoi :** ces mots mesurent l'application, pas les gens. La page de
métriques s'appelle désormais « Ce que l'application fait de votre
mémoire », et elle est au pied de page.

## Une navigation qui grossit

**Interdit :** ajouter une entrée à la barre sans en retirer une.

**Pourquoi :** la §1 de la spec en dessine sept. Le test
`tests/retrait.test.ts` refuse une huitième. Un menu de neuf entrées dont
sept mènent à une page vide n'est pas parcimonieux, il est décoratif — et il
demande à une famille qui arrive d'apprendre un vocabulaire avant d'avoir dit
un seul mot.

**Ce qui existe :** une section reste **repliée** tant qu'elle est vide, et
« Tout le reste » les rend toutes accessibles avec une ligne qui dit à quoi
chacune sert. C'est un `<details>` natif — ni script, ni état.
