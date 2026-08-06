# Revue de la direction « 2a — Pleins aplats, allégé »

Direction reçue le 5 août 2026. Je l'ai **rendue dans un navigateur** et
**mesuré** plutôt que lue, parce que c'est la seule façon de savoir.

**Verdict : à retenir.** Elle rend le produit vivant sans le rendre ludique,
et plusieurs de ses choix sont meilleurs que ce qui existe. Trois corrections
sont nécessaires avant implémentation, dont une est un manquement mesuré à la
§6.4. Trois écrans montrent des fonctionnalités qui n'existent pas.

---

## 1. Ce qui est meilleur que l'existant

**La couleur en aplat plein écran, une teinte par écran.** Le produit actuel
est monochrome crème avec un seul accent ; c'est sobre et c'est un peu mort.
Un aplat terre cuite sur le premier jour, une sauge sur un récit, l'encre sur
la veillée : on sait où l'on est sans lire. Et ça ne coûte aucune règle — la
§6.1 parle de parcimonie, pas d'austérité.

**La veillée en thème sombre, corps à 26 px.** C'est juste. On lit à voix
haute, souvent le soir, le téléphone tenu à distance. Le produit actuel se
contente de `text-xl` sur fond crème. Ici la forme sert enfin l'usage.

**« Qui a dit quoi » avec des noms et jamais un nombre** (écran 3). Le
handoff l'a compris et l'écrit en gras dans son propre README. C'est la règle
la plus facile à trahir et elle est tenue.

**Le pied de page.** « Exporter la mémoire » et « Ce que l'application fait
de votre mémoire » y sont, tous les deux, sur les quatre écrans. La
reddition de comptes descendue au pied lors de la passe de retrait est
respectée sans que j'aie eu à le demander.

**« noté le 3 janvier 2026 ».** La convention `dateDuRecit()` — nommer la
date de saisie au lieu de la faire passer pour celle de l'événement — est
reprise telle quelle. C'était une correction discrète ; elle a été vue.

---

## 2. Ce qui doit être corrigé — mesuré, pas supposé

### 2.1 `.text-muted` échoue au contraste, et c'est la classe la plus utilisée

Le README affirme : *« tous les textes remontés à 16 px minimum […] fonds
descendus d'un cran de rampe pour tenir 4.5:1 »*.

`organic.css` définit :

```css
.text-muted { color: color-mix(in srgb, var(--color-text) 55%, transparent); }
```

Mesuré, formule WCAG 2.1 :

| Texte | Fond | Rendu | Ratio | Seuil | |
|---|---|---|---|---|---|
| `.text-muted` | crème `#f5ead8` | `#807a71` | **3,57** | 4,5 | **échec** |
| `.text-muted` | `#f9f4ed` | `#827e7b` | **3,68** | 4,5 | **échec** |

Ce n'est pas un détail de coin d'écran : `.text-muted` porte **les sept
descriptions de « Tout le reste »**, l'étiquette « Le Passeur », et les
justifications. C'est exactement le texte explicatif dont dépend le lecteur
le plus âgé — celui pour qui le plancher de 16 px a été posé.

**Correction :** monter le mélange de 55 % à **65 %** (70 % sur la carte
Passeur, fond plus clair).

| Fond | Mélange requis | Couleur rendue | Ratio obtenu |
|---|---|---|---|
| crème `#f5ead8` | 65 % | `#6b655e` | 4,84 |
| `#f9f4ed` | 65 % | `#6c6966` | 4,98 |
| `#ffc6a5` (carte Passeur) | 70 % | `#635046` | 5,01 |

Les onze autres paires que j'ai mesurées passent, dont plusieurs largement —
le corps sur aplat terre cuite est à 6,21, la veillée à 12,89. **La direction
est bonne ; c'est une seule variable qui est fausse.**

> Ce point est la démonstration exacte de l'amendement 6, appliqué à un
> document de design : le contraste était **affirmé** dans le README et
> **non mesuré**. Il ne s'agit pas d'un reproche — c'est le défaut le plus
> courant qui existe, et je l'ai commis moi-même quatre fois sur ce projet.
> Il s'agit de mesurer avant d'écrire.

### 2.2 Les polices ne se chargent pas

`organic.css` ligne 2 :

```css
@import url('https://fonts.googleapis.com/css2?family=Caprasimo…&family=Figtree…');
```

Rendu dans un navigateur sans accès à Google Fonts, la police des titres se
résout à `Caprasimo, system-ui, sans-serif` → **system-ui**. Toute
l'identité typographique disparaît, silencieusement, et la maquette reste
belle — c'est le pire cas : l'échec ne se voit pas.

Le README le signale en « point ouvert n° 1 ». Je le remonte en **bloquant** :
l'application est une PWA avec Service Worker et une page hors-ligne. Une
police distante n'est pas un arbitrage esthétique, c'est une régression
fonctionnelle. **Caprasimo et Figtree en `woff2` dans le projet, `@font-face`
local, `font-display: swap`.**

### 2.3 Deux actions principales sur le premier écran

Écran 1 : un bouton « Raconter » en haut à droite **et** un bouton « Envoyer »
pleine largeur dans la carte. Le produit actuel n'en a qu'un — c'est
délibéré, et `tests/premier-jour.test.ts` le vérifie : un seul formulaire, un
seul lien, et ce lien ne doit pas porter de classe `btn`.

Sur une famille qui n'a rien, « Raconter » mène à un formulaire complet
(titre, type, ton, entités) : c'est exactement la page blanche que le premier
jour a été construit pour éviter.

**Correction :** sur le premier jour seulement, « Raconter » redevient un
lien texte, ou disparaît. Sur l'écran du Passeur (écran 2), le bouton est
justifié — la famille sait déjà ce qu'elle fait.

---

## 3. Trois écrans montrent ce qui n'existe pas

Ce n'est pas une faute du designer : c'est ce qui arrive quand une maquette
va plus vite que le produit. Mais il faut le décider avant de coder, pas
pendant.

**« Écouter Robert le raconter — 2 min 14 »** (écran 4). Il n'existe
aujourd'hui aucun audio attaché à un récit lisible depuis la veillée. Les
enregistrements vivent dans `Archive` et dans `TranscriptionDraft`, et rien
ne les rejoue à côté du texte.

**C'est la meilleure idée du handoff, et je voudrais la construire.**
Entendre la voix de quelqu'un lire son propre récit, à la veillée, est plus
fort que tout ce que j'ai proposé dans `AVENIR.md`. Et c'est cohérent avec le
mode entretien : si l'entretien produit l'audio **et** le texte, alors le
récit garde sa voix. C'est le lien qui manquait entre les deux.

**Les trois marques sur un récit** (écran 3 : « J'y étais / Claire, Robert »).
Aujourd'hui `MessageMark` porte sur un **message de fil**, jamais sur un
récit. Deux options : étendre les marques aux récits, ou n'afficher sur la
page d'un récit que les marques des messages du fil dont il est né. Je penche
pour l'extension — « j'y étais » est un fait de première main qui vaut autant
sur un récit.

**La barre de progression en trois segments** (écran 4). Cas limite. Le
produit affiche déjà « 1 sur 3 », donc la position n'est pas nouvelle. Mais
une barre segmentée est l'affordance de « compléter la série ». Je la
remplacerais par les trois points ou par rien : la veillée n'est pas une
tâche à finir, et son dernier écran dit précisément le contraire.

---

## 4. Ce qui reste à dessiner

Le README les nomme (point ouvert n° 3) et il a raison de s'arrêter : le fil,
le graphe, l'import, le livre, la page Famille, la reddition de comptes,
`/brouillons`. Soit **sept écrans sur les onze** du produit.

À cela s'ajoute maintenant **le mode entretien** (`SPEC_ENTRETIEN.md`), qui
est le prochain à construire et qui n'existe dans aucune direction. C'est
l'écran le plus contraint du produit : un écran, une question, un bouton,
aucun clavier, aucun compteur, aucune progression. Cette direction — aplat
plein, forme ronde, une action évidente — lui va parfaitement. **Je
demanderais l'entretien avant les six autres.**

---

## 5. Récapitulatif

| | Action |
|---|---|
| `.text-muted` 55 % → 65 % (70 % sur `accent-300`) | **bloquant**, mesuré |
| Polices auto-hébergées en `woff2` | **bloquant**, PWA hors ligne |
| « Raconter » en bouton sur le premier jour | à retirer, casse un test existant |
| Barre de progression de la veillée | à remplacer par trois points, ou rien |
| Audio sur un récit | **à construire** — meilleure idée du lot |
| Marques sur un récit | décision de modèle à prendre |
| Écran du mode entretien | à dessiner **en premier** |

Le reste de la direction est bon et je l'appliquerais tel quel.
