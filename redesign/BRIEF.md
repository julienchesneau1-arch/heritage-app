# Héritage — brief de redesign

**À coller dans Claude Design (ou tout autre outil) avec le dossier `redesign/`.**

Ce document existe pour qu'un redesign complet soit possible **sans perdre une
seule fonctionnalité, ni une seule garantie**. Il est écrit à l'envers d'un
brief habituel : il commence par ce qui ne doit pas bouger, parce que dans ce
produit la plupart des contraintes visuelles sont des contraintes *morales*
avant d'être esthétiques.

Ce qui accompagne ce fichier :

| Fichier | Ce que c'est |
|---|---|
| `BRIEF.md` | ce document — le cadre et l'inventaire écran par écran |
| `COPIE.md` | **tout** le texte visible de l'application, extrait du source, par fichier |
| `ECRANS.md` | l'inventaire écran par écran, avec états et données |
| `INTERDITS.md` | ce qu'un redesign ne doit jamais réintroduire, et pourquoi |
| `captures/` | les captures de l'application actuelle, telle qu'elle tourne |
| `../HERITAGE_SPEC.md` | la spécification complète, Constitution comprise |

---

## 1. Ce que fait ce produit, en trois phrases

Une famille dépose ce qu'elle se raconte. Une chose dite en appelle une
autre — c'est la **primitive** : *une histoire doit pouvoir engendrer une
autre histoire*. Et le succès ultime n'est pas l'usage quotidien, c'est que
la famille continue de transmettre **sans l'application**.

Tout le reste en découle. Un redesign qui rend l'application plus collante
la rend moins bonne.

## 2. Le public

Trois générations sur le même compte familial. La grand-mère sur une
tablette, le petit-fils sur un téléphone, le parent entre les deux. Les
conséquences pour le design ne sont pas négociables :

- **Mobile d'abord**, 390 px de large comme référence. C'est une PWA.
- **16 px minimum** partout, et un réglage de taille de lecture par
  appareil (pas par membre : c'est souvent le même compte sur les deux).
- **Cibles tactiles 44 × 44 minimum.**
- **Contraste 4,5:1 minimum**, vérifié — les valeurs actuelles sont
  15,6:1 (encre/papier), 5,3:1 (gris/papier), 7,2:1 (accent/papier).
- Aucune information portée par la couleur seule. La navigation souligne
  la page courante en plus de la colorer, et porte `aria-current`.

## 3. Ce qui peut changer, et ce qui ne peut pas

### Libre

La palette, les typographies, la grille, les proportions, les ombres, le
rythme vertical, les micro-interactions, l'illustration, la forme des
boutons, la disposition de la navigation, la mise en page du livre.

L'identité actuelle — papier crème, encre chaude, un seul accent terre de
Sienne, une serif de lecture — n'est pas sacrée. Elle est le résultat d'un
seul principe : *une mémoire familiale doit ressembler à un objet de
famille, pas à un tableau de bord*. Un autre chemin vers ce principe est
bienvenu.

### Verrouillé

Ce sont des règles écrites dans la Constitution du produit (`HERITAGE_SPEC.md`
§6, §12, Annexe A). Elles ont chacune coûté un correctif, et plusieurs ont
été violées par mégarde avant d'être testées automatiquement.

| Règle | Conséquence pour le design |
|---|---|
| **Jamais plus d'une suggestion par écran** | Un écran d'accueil ne propose qu'une chose. Pas de grille de « recommandations ». |
| **Jamais de badge, de pastille, de compteur de nouveautés** | La navigation ne porte aucun nombre. |
| **Jamais de score, de note, de jauge de progression** | Ni « profil complété à 60 % », ni « 12 récits ce mois-ci », ni streak. |
| **Jamais l'affichage de l'inactivité** | Pas de « dernière activité il y a 3 semaines ». Dix messages par mois, c'est une famille, pas un échec. |
| **Jamais de carrousel ni de flux infini** | Les listes sont bornées, paginées, et **disent ce qu'elles bornent**. |
| **Jamais de notification poussée** | Aucun composant de notification à dessiner. |
| **Toute suggestion porte sa justification en petit texte gris** | Un composant « suggestion » sans emplacement pour le *pourquoi* est invalide. |
| **« Ne plus me montrer » sur chaque suggestion** | Toujours visible, jamais dans un menu. |
| **« Archiver » visible sur chaque récit** | Pas caché derrière trois points. |
| **« Exporter » au pied de chaque page** | La famille possède ses données, et ça se voit. |
| **Une mesure impossible s'écrit « — » avec sa raison** | Prévoir l'état « non mesurable » dans tout composant de chiffre. Ce n'est pas un état d'erreur : c'est un état normal. |
| **Une vue bornée dit ce qu'elle cache** | « 8 récits affichés sur 14 » fait partie du composant, pas d'une note de bas de page. |
| **Un membre retiré s'affiche « Membre anonymisé »** | Prévoir l'état anonyme partout où un nom apparaît. |

Voir `INTERDITS.md` pour le détail et les cas limites.

## 4. Le ton

Le langage est contraint et **testé automatiquement** (`src/lib/constitution.ts`).
Deux filtres refusent une chaîne de caractères :

- **Aucune inférence émotionnelle.** « Vous semblez ému », « ce souvenir
  vous tient à cœur » : refusés. Le produit ne déduit jamais un sentiment
  d'une donnée.
- **Aucune formule coercitive.** « Vous n'avez pas lu… », « il y a
  longtemps que… », « ne manquez pas » : refusés.

Règle positive : on nomme le lieu, jamais le manque. « Ici, la famille
Martin se raconte » et non « Vous n'avez encore rien écrit ».

Toute nouvelle chaîne écrite pendant le redesign doit passer ces deux
filtres. Ils sont exécutables :

```ts
import { constitutionEmotionFilter, isNonCoerciveLanguage } from '@/lib/constitution';
constitutionEmotionFilter(texte) && isNonCoerciveLanguage(texte)   // doit valoir true
```

## 5. Les jetons actuels, pour référence

```ts
// tailwind.config.ts
colors: {
  paper:  '#faf8f4',   // fond
  ink:    '#1c1917',   // texte
  muted:  '#6b6864',   // justifications, métadonnées
  rule:   '#e3ded5',   // filets, bordures
  accent: '#7c4a2d',   // un seul accent, terre de Sienne
}
fontFamily: {
  serif: ['Iowan Old Style', 'Palatino', 'Georgia', 'serif'],  // corps de lecture
  sans:  ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'], // interface
}
maxWidth: { reading: '38rem' }
```

Quatre classes composées portent l'essentiel de l'interface :

| Classe | Rôle |
|---|---|
| `.btn` | action secondaire — bordure, fond transparent |
| `.btn-primary` | action principale — fond accent, une seule par écran |
| `.justification` | le petit gris : pourquoi cette chose est là, ce qu'elle ne dit pas |
| `.section-label` | intertitre en capitales espacées, 0,68 rem |

`.justification` est le composant le plus important du produit. Il ne
décore pas : il porte la reddition de comptes. Un redesign qui l'efface
casse la Constitution.

**Aucune police distante.** L'application doit fonctionner hors ligne
(Service Worker, page `/hors-ligne`). Une police web doit être
auto-hébergée, pas appelée depuis un CDN.

## 6. Le livre : une deuxième feuille de style

`/livre` compose **pour le papier**. `src/app/globals.css` contient un bloc
`@media print` complet : `@page { margin: 20mm 18mm }`, sauts de page avant
chaque récit racine, `page-break-inside: avoid` sur les récits et les
questions, navigation et pied de page masqués, et `a[href]::after { content: none }`
— une adresse imprimée entre parenthèses serait du bruit dans un objet qui
ne doit renvoyer à aucun écran.

Le redesign doit livrer **deux** directions : l'écran et le papier. Elles
peuvent différer.

## 7. Comment procéder

1. Lire `INTERDITS.md`. C'est la partie où un redesign se casse.
2. Parcourir `captures/` pour voir l'état actuel — ce sont de vraies
   captures de l'application compilée, pas des maquettes.
3. Prendre `ECRANS.md` écran par écran. Chaque entrée liste **la fonction,
   les états, les données affichées et les contraintes**. Un écran redessiné
   qui perd un état perd une fonctionnalité.
4. Piocher la copie dans `COPIE.md` plutôt que de la réécrire de mémoire :
   plusieurs phrases sont le résultat d'un arbitrage constitutionnel et
   sont couvertes par des tests.
5. Rendre les jetons sous forme de variables CSS ou de config Tailwind, pas
   de valeurs en dur : `src/app/globals.css` et `tailwind.config.ts` sont les
   deux seuls endroits à toucher pour la peau.

## 8. Ce qui casserait les tests

431 tests passent aujourd'hui. Certains lisent **le source des composants**
pour vérifier des interdits — un redesign qui les fait échouer a
probablement réintroduit ce qu'ils protègent. Les plus susceptibles de
réagir :

| Test | Ce qu'il vérifie |
|---|---|
| `tests/retrait.test.ts` | Aucune page n'affiche de score, d'objectif, d'inactivité, ni de date fabriquée. Au plus 7 sections dans la barre. |
| `tests/fil.test.ts` | Le fil n'emprunte rien au moteur des salons de discussion. |
| `tests/premier-jour.test.ts` | Le premier écran ne propose qu'une action, un seul formulaire, un seul autre lien — et jamais sous forme de bouton. |
| `tests/constitution.test.ts` | Les filtres de langage. |
| `tests/livre.test.ts` | Le livre ne contient ni lien, ni QR code, et n'omet aucun récit. |
| `tests/amendement-6.test.ts` | Aucun chiffre affirmé sans base. |

Lancer `npm test` après chaque étape, pas à la fin.
