# Héritage — dossier complet

Tout ce qui a été construit, comment, et pourquoi. Écrit le 5 août 2026,
remis à jour le 6, après 41 commits sur la branche
`claude/heritage-app-spec-acztj1`.

Les chiffres de ce document viennent du dépôt, pas de mémoire :
`git log`, `wc -l`, `vitest run`, `prisma migrate`.

---

## Sommaire

1. [Ce qu'est le produit](#1-ce-quest-le-produit)
2. [Les chiffres](#2-les-chiffres)
3. [La Constitution, et ses six amendements](#3-la-constitution-et-ses-six-amendements)
4. [Le modèle de données](#4-le-modèle-de-données)
5. [Les quatre acteurs algorithmiques](#5-les-quatre-acteurs-algorithmiques)
6. [Toutes les fonctionnalités](#6-toutes-les-fonctionnalités)
7. [Identité et sécurité](#7-identité-et-sécurité)
8. [La pile technique](#8-la-pile-technique)
9. [Comment ça a été construit — les 41 étapes](#9-comment-ça-a-été-construit--les-41-étapes)
10. [La méthode : chasser une classe de défaut](#10-la-méthode--chasser-une-classe-de-défaut)
11. [Les tests](#11-les-tests)
12. [Le déploiement](#12-le-déploiement)
13. [Ce qui n'a pas été vérifié](#13-ce-qui-na-pas-été-vérifié)
14. [Ce qui reste ouvert](#14-ce-qui-reste-ouvert)

---

## 1. Ce qu'est le produit

Une PWA francophone où une famille dépose ce qu'elle se raconte.

**La primitive**, dont tout découle : *une histoire doit pouvoir engendrer
une autre histoire*. Ce n'est pas un slogan — c'est la seule chose que le
produit mesure, et le lien parent → enfant a sa propre table (`Passage`).

**La contrainte finale**, qui interdit la moitié des réflexes du métier :
*le succès ultime est que la famille continue de transmettre sans l'app*
(Annexe A, point 7). Un produit qui rendrait ses utilisateurs dépendants
aurait échoué à sa propre définition.

Le point de départ est un document que vous avez écrit — `HERITAGE_SPEC.md`,
version 1.0 du 28 juillet 2026, fondé sur la Constitution de la Mémoire V7.5
et le PRD Héritage V1.0. Ce document est resté la source de vérité pendant
toute la construction : chaque écart y est écrit et justifié, et à partir
d'un certain point la règle a été qu'aucune action ne se fasse sans le
relire d'abord.

---

## 2. Les chiffres

| | |
|---|---|
| Commits | 41 |
| Fichiers TypeScript / TSX | 99 |
| Lignes de code applicatif | 14 554 |
| Lignes de tests | 6 048 |
| Lignes de documentation | 4 584 |
| Tests, tous verts | **568**, en 28 fichiers |
| Modèles de données | 15 |
| Migrations SQL | 10, toutes écrites à la main |
| Routes | 45 (24 pages, 19 routes d'API, 2 routes d'entrée) |
| Services | 16 |
| Outils de mesure | 4 (`outils/`), hors `npm test` |
| Amendements constitutionnels | 6, dont 3 ajoutés en cours de route |

Rapport tests / code : **0,42 ligne de test par ligne de code**. La plupart
des tests ne vérifient pas que le code marche, mais qu'il ne fait pas ce
qu'il a interdit — plusieurs lisent le source des composants pour cela.

---

## 3. La Constitution, et ses six amendements

Sept principes gouvernent le produit (Annexe A de la spec) :

1. **Primitive** — une histoire doit pouvoir engendrer une autre histoire.
2. **Parcimonie** — montrer le minimum nécessaire, jamais le maximum possible.
3. **Exclusion justifiée** — toute histoire affichée exclut les autres ;
   cette exclusion doit être défendable.
4. **Pas d'inférence émotionnelle** — jamais déduire un sentiment d'une donnée.
5. **Accessibilité active** — aucune histoire ne devient inaccessible par
   effet d'algorithme.
6. **Oubli = droit** — archivage, silence, suppression sont des décisions
   familiales absolues.
7. **Dispensabilité** — le succès ultime est que la famille continue sans l'app.

Les amendements sont **exécutables**, pas commentés :

| | Ce qu'il dit | Où il vit |
|---|---|---|
| **1** | Pas d'inférence émotionnelle | `src/lib/constitution.ts` — filtre appliqué à toute sortie de modèle. Les apostrophes typographiques sont normalisées avant test : « tu as l'air » et « tu as l’air » sont la même phrase. |
| **3** | La famille possède ses données | `/api/family/:id/export` rend tout, sans traitement ni filtre. `/restaurer` relit deux formats, car un export d'il y a six mois doit encore s'ouvrir. |
| **5** | Pas d'imposition algorithmique | Le Conservateur ne modifie jamais l'ordre d'affichage. Il peut écarter un récit sur-exposé des suggestions, et le documenter. |
| **6** | Le produit n'affirme que ce qu'il a vérifié | `src/lib/honnetete.ts`, quatre clauses, 20 tests. **Ajouté en cours de route** — voir §10. |
| **§3.1 amendé** | Ce que le produit *capte* ≠ ce qu'un humain lui *apporte* | Un fichier exporté, relu et coché par une personne relève de la saisie utilisateur. Le produit n'accède jamais à une source du téléphone. |
| **§12 étendu** | « Ni like ni score » vaut pour **toutes** les pages | La règle n'était appliquée qu'au fil. `tests/retrait.test.ts` la porte partout, y compris aux phrases que les services écrivent en base. |

Deux filtres de langage refusent une chaîne de caractères :

```ts
constitutionEmotionFilter(texte)   // « vous semblez ému » → false
isNonCoerciveLanguage(texte)       // « il y a longtemps que… » → false
```

Règle positive : on nomme le lieu, jamais le manque. « Ici, la famille
Martin se raconte », et non « Vous n'avez encore rien écrit ».

---

## 4. Le modèle de données

15 modèles PostgreSQL, via Prisma 5.

| Modèle | Rôle |
|---|---|
| `Family` | Le tenant isolé. Porte `tokenVersion` — la rotation du lien familial. |
| `Member` | Une personne. `isDeleted` (soft-delete), `tokenVersion` (révocation individuelle), `calendarOptOut` (retrait du flux `.ics`), génération, dates. |
| `Story` | Un récit. Auteur **et** narrateur, `eventDate` distincte de `createdAt`, type de structure, ton, archivage, quarantaine, et `suspendedAt` / `suspendedForId` — suspendu par son auteur, pour quelqu'un de nommé. |
| `Entity` | Personne, lieu ou objet. `normalizedName` sans accents pour le rapprochement. |
| `Archive` | Photo, document, enregistrement. Texte extrait facultatif. |
| `Tradition` | Ce qui revient. Périodicité, sommeil et raison du sommeil. |
| `Thread` | Un fil. S'accroche à une entité, à un récit, ou à rien — **au plus un ancrage**, contrainte `CHECK` en base. |
| `Message` | Une prise de parole. Auteur **et** narrateur, comme un récit. |
| `MessageMark` | Les trois marques. Vocabulaire fermé, contraint en base. |
| `Passage` | **La primitive.** Le lien parent → enfant, avec son déclencheur. |
| `TranscriptionDraft` | Un brouillon de transcription, à relire avant d'entrer dans la mémoire. Porte `spokenById` (la voix), `reviewerId` (qui relira) et `promptText` (la question posée). |
| `StoryMute` | Une mise en sourdine, **par membre** — pas globale. |
| `VisibilityLog` | L'audit du Conservateur. Toute impression est traçable. |
| `Reserve` | Ce dont quelqu'un ne veut pas qu'on lui parle. `portee` distingue la réserve silencieuse — le défaut — de la demande portée à la famille. |
| `SuspensionRequest` | Une demande de suspension, **jamais anonyme**. Elle n'agit pas : seul l'auteur du récit décide. |

**Dix migrations, toutes écrites à la main**, jamais générées :

```
20260803123956_initial
20260803131826_narrateur
20260803133903_identite_sourdine_recherche
20260803171619_transcription_brouillons
20260803184759_consensus_transcription_locale
20260803210000_le_fil          ← transporte les données avant de détruire
20260804120000_liberte
20260805090000_retrait         ← réécrit une phrase déjà stockée en base
20260805140000_entretien_reserve
20260805170000_suspension
```

La migration `le_fil` mérite un mot : elle **transporte** les conversations
de l'ancien modèle vers le nouveau **avant** de détruire quoi que ce soit,
et lève une exception si le transport est incomplet. Une migration qui perd
la parole d'une famille est pire qu'une migration qui échoue.

---

## 5. Les quatre acteurs algorithmiques

Chacun est indépendant. Ils communiquent par la base, jamais entre eux —
sauf le Passeur, qui consulte le Conservateur pour écarter les récits
sur-exposés.

| Service | Mission | Ce qu'il ne fait jamais |
|---|---|---|
| **TriggerModel** | Détecter quand le présent active le passé | Lire une donnée non déclarée dans l'app (GPS, contacts, agenda) ; envoyer une notification |
| **Conservateur** | Empêcher qu'une histoire devienne inaccessible par effet d'algorithme | Modifier l'ordre d'affichage ; pousser un récit oublié ; corriger un biais qu'il a mesuré |
| **Passeur** | Augmenter la probabilité qu'une histoire en engendre une autre | Poser plus d'une question par session ; poser une question sans justification ; parcourir tout le corpus |
| **LLMOperator** | Exécuter des opérations informationnelles vérifiables | Décider ; inventer un fait ; inférer une émotion |

Le **Conservateur mesure sans corriger**, et c'est délibéré : il calcule la
distorsion — l'écart entre qui raconte et qui est lu — et l'affiche sans y
toucher. Corriger serait imposer.

Le **LLM est facultatif**. Sans `OPENAI_API_KEY`, chaque service rend un
repli déterministe : le Passeur pose ses questions, la cristallisation d'un
fil rend le fil lui-même ligne à ligne, la classification retombe sur un
type par défaut. **Aucune fonctionnalité ne casse.** C'est ce qui permet de
tenir le coût près de zéro.

---

## 6. Toutes les fonctionnalités

### Fonder et gérer une famille

- Création d'une famille avec son premier membre (`/commencer`) — une
  mémoire sans personne pour la porter n'a pas de sens.
- Ajout, correction, retrait des membres. Le retrait est un **soft-delete** :
  les récits restent, la personne devient « Membre anonymisé » **partout**.
- Deux niveaux d'identité, deux liens (voir §7).
- Rotation du lien familial (« Changer ce lien ») et révocation individuelle
  des liens personnels.
- Restauration depuis un export (`/restaurer`), deux formats acceptés.

### Déposer de la mémoire — cinq chemins

1. **Dire une chose** — un champ, une phrase, et c'est un fil. Le chemin le
   plus court, et celui du premier jour.
2. **Écrire un récit** (`/recits/nouveau`) — titre, texte, narrateur choisi
   séparément de l'auteur, date de l'événement, type de structure parmi 33,
   ton, entités mentionnées, récit parent.
3. **Dicter** — enregistrement audio, découpage automatique des longs
   fichiers, transcription, **relecture humaine obligatoire**.
4. **Importer une conversation** — WhatsApp, Messenger ou SMS, lu dans le
   navigateur, coché à la main.
5. **Cristalliser un fil** — le fil devient un récit, et lui survit comme
   provenance.

### Le fil

- S'accroche à une entité, à un récit, ou à rien.
- Auteur **et** narrateur par message : dans un fil écrit, le clavier rapide
  parle à la place de celui qui se souvient.
- Trois marques à vocabulaire fermé — « J'y étais », « Je m'en souviens »,
  « Je ne savais pas ». Des **faits**, pas des avis, affichés en **noms**,
  jamais en nombres.
- « Retirer mes mots » : l'auteur ou le narrateur, personne d'autre. Le
  dernier message emporte son fil.
- **Ce qu'il refuse d'emprunter aux salons de discussion**, et qui est
  testé : compteur de non-lus, présence, « est en train d'écrire »,
  notification, `@everyone`, décompte de réactions, affichage de
  l'inactivité.

### La transcription

- Deux moteurs : **local** dans le navigateur (WebGPU/WASM, coût nul, durée
  illimitée) ou Whisper par API.
- **Consensus entre deux modèles** : les passages où ils divergent sont
  signalés comme douteux.
- Découpage des longs enregistrements avec chevauchement, pour ne pas couper
  un mot en deux.
- **Aucune transcription n'entre dans la mémoire sans relecture humaine.**
  Whisper est génératif et invente des phrases, surtout sur les silences et
  les voix hésitantes.
- La provenance est affichée sur le récit : quel modèle, qui a vérifié, quand.

### L'import de conversations

- **Trois sources, un seul modèle canonique** : WhatsApp (quatre formats
  d'export selon la plateforme et la langue), Messenger (JSON, avec
  réparation du double encodage UTF-8 de Facebook), SMS (XML de SMS Backup&Restore).
- **Le fichier ne quitte jamais l'appareil** : l'analyse a lieu dans le
  navigateur, seuls les passages cochés partent au serveur.
- Jamais l'archive entière — un fichier de conversation à la fois.
- Les lignes non rattachées sont **comptées et affichées**, jamais devinées
  ni jetées en silence.
- La plage de dates lue est montrée, pour vérifier d'un coup d'œil que le
  fichier n'a pas été lu en mois/jour.
- Les participants non associés à un membre gardent leur nom d'export.
- Un avertissement distinct pour les échanges à deux : importer ne change
  pas de support, il change d'**auditoire**.

### Lire et retrouver

- **Aujourd'hui** — au plus une question du Passeur, au plus un signal daté.
  Si les deux manquent, il ne reste que le nom de la famille, et c'est un
  résultat valide.
- **Récits** — la seule vue exhaustive. Recherche insensible aux accents,
  filtre par type, pagination par 50, et **trois états vides distincts** :
  aucun récit, aucune correspondance, aucune correspondance *active* avec le
  compte des archivés qui correspondent.
- **Un récit** — la voix d'abord (« Raconté par Jeanne, noté par Claire »),
  les entités liées, **les chaînes de transmission en liens qu'on suit**, les
  fils, la provenance.
- **Graphe** — centré sur une entité, au plus 8 récits et 12 éléments, liens
  déclarés jamais déduits, et **il dit ce qu'il cache**. C'est aussi la porte
  vers les fils d'entités.
- **Archives** — photos, documents, enregistrements.
- **Traditions** — ce qui revient, et « endormir », le verbe qui compte.

### La veillée

Trois récits, un par écran, en très grand, faits pour être lus à voix haute
quand la famille est réunie. Chacun précédé de la raison de sa présence. Il
n'y a **pas de quatrième écran** : la clôture dit *« Quelqu'un se
souvient-il d'autre chose ? C'est le moment de le dire à voix haute — pas de
l'écrire »*, puis *« L'application n'a pas besoin d'être ouverte pour que la
mémoire passe »*.

### Le livre

La **sortie**, et la seule pièce qui serve vraiment la dispensabilité.

- Composé pour le papier : feuille de style d'impression complète, marges
  `@page`, sauts contrôlés, navigation masquée.
- Les récits dans leur **filiation** — un récit né d'un autre est en retrait.
- **Rien n'est borné.** Partout ailleurs le produit limite ce qu'il montre ;
  ici il est la sortie, et une sortie incomplète ne libère personne.
- Une section entière dit **ce que ce livre ne dit pas** : les questions
  restées sans réponse (avec des lignes vides pour écrire à la main), les
  récits dont on ignore la date, les personnes qu'aucun récit ne mentionne.
- Un colophon donne le compte imprimé sur le compte conservé.
- **Aucun QR code, aucune adresse, aucune dépendance externe** — le
  navigateur fabrique le PDF.

### Le calendrier familial

- Un flux iCalendar (RFC 5545) auquel chacun abonne son agenda. Zéro
  infrastructure, zéro coût.
- **La ligne constitutionnelle** : *une date ne sort de l'application que si
  elle existe sans elle.* Le 8 novembre 2014 existe que l'app existe ou non ;
  une série de connexions, non.
- Y entrent : naissances des vivants, décès, traditions, dates d'événements
  racontés. **Pas `Story.createdAt`** — celle-là, le produit se la fabrique.
- Une **règle annuelle** publiée, jamais des occurrences calculées : « il y a
  10 ans » gravé aujourd'hui serait faux l'an prochain.
- Aucun `VALARM` : l'application ne décide pas d'interrompre. `TRANSP:TRANSPARENT` :
  ces journées ne rendent personne occupé.
- L'adresse porte le jeton personnel : « Révoquer ce lien » coupe aussi le
  calendrier.
- `calendarOptOut` retire une personne du flux sans la retirer de la mémoire.
- Ce qu'on donne à Google ou Apple en s'abonnant est **écrit avant** le lien.

### La reddition de comptes

`/transmission`, au pied de page : ce que l'algorithme écarte, met en
sourdine, sur-expose, n'a jamais remontré. Plus le « Rappel patrimonial ».
Chaque mesure impossible s'écrit « — » **avec sa raison**.

La page nomme aussi ce qu'elle a **cessé** d'afficher : retirer un chiffre
sans le dire serait le retirer deux fois.

### L'entretien — répondre à voix haute

Le chemin pour qui n'écrit pas, et c'est souvent celui qui détient le plus.

- **`/entretien`, l'écran d'avant.** Deux choses s'y règlent, et avant le
  premier enregistrement. QUI RELIRA : on désigne quelqu'un à chaque
  entretien, jamais une fois pour toutes — un relecteur permanent
  deviendrait le dépositaire de tous les secrets de la maison sans que
  personne l'ait décidé. Sans relecteur nommé, l'entretien ne commence pas.
- **`/entretien/parler`, l'écran où l'on parle.** Un écran, une question, un
  bouton. Le menu se réduit à un titre. Aucun compteur, aucune progression,
  aucune durée cible, aucun encouragement : l'application pose une question
  et se tait. « Passer » est de la même taille que « Garder » et ne demande
  jamais pourquoi.
- **Le brouillon appartient à la voix**, pas au relecteur : celui qui a
  parlé peut l'effacer tant que rien n'en est né, et le relecteur voit
  seulement qu'il n'y a rien à relire.
- **Le narrateur du récit qui en naît est celui qui a parlé** (§2.3), jamais
  celui qui a tapé.

### La réserve — ce dont on ne veut pas qu'on parle

Posée une fois, jamais répétée, et **silencieuse par défaut** : une réserve
visible apprendrait à toute la famille que le sujet existe et qu'il fait
mal. L'application cesse simplement de poser des questions dessus — par le
sujet lui-même, et par les récits qui y sont rattachés, sans quoi la même
question reviendrait par la porte de derrière.

**Porter la demande est un second geste, explicite.** Elle s'affiche alors,
avec le nom de son auteur et dans ses mots, **au moment où quelqu'un écrit
sur le sujet** — et l'application laisse écrire. Elle porte la demande, elle
ne l'applique jamais : le jour où une machine impose le respect d'un
souhait familial, ce n'est plus un acte de respect mais une règle qu'on
contourne.

La règle générale, née ici : **un signal comportemental ne peut que
RETIRER, jamais ajouter.** Deux passages sur un sujet, et on cesse de le
proposer. Rien n'en est déduit dans l'autre sens.

### La suspension — par accord de l'auteur, jamais par objection

Quelqu'un s'estime concerné par un récit et demande qu'il ne s'affiche
plus. La première version que j'avais proposée suspendait automatiquement :
elle contredit la §2.6 — « un membre peut décider de ne plus voir un récit ;
il ne peut pas décider à la place des autres » — et revient à un veto
déguisé. Elle a été **écartée contre ma propre recommandation**.

Ce qui existe : l'objecteur **demande**, en étant nommé, dans ses mots.
**Seul l'auteur suspend**, et l'application le lui dit — « ne rien faire est
une réponse ». Aucune relance, aucun compte de demandes en attente : ce
serait une pression.

Un récit suspendu quitte **ce qui circule** — pages, recherche, Passeur,
veillée, graphe, livre, calendrier, API — et reste dans **ce qu'on possède** :
l'export ne filtre rien (amendement 3). C'est la frontière qui existait
déjà pour les récits archivés et mis en quarantaine. Aucun `Passage` n'est
détruit : la suspension est réversible, la suppression ne l'est pas.

### Accessibilité et confort

- **16 px minimum, mesuré et non affirmé.** Un test parcourt tout `src/` et
  refuse `text-sm` et `text-xs` hors de deux exceptions nommées. La règle
  était appliquée à l'œil ; vingt-neuf endroits y échappaient.
- **Cibles tactiles 44 × 44**, y compris les pastilles d'entités, qui
  mesuraient 26 px de haut.
- **Contrastes calculés**, jamais estimés : `tests/contraste.test.ts`
  applique la formule WCAG 2.1 aux couleurs lues dans la configuration —
  17 paires, dont l'aplat de la veillée à 12,89:1 et la justification sur
  crème à 4,84:1. Une opacité sur du texte est refusée par un autre test :
  `opacity-80` sur une couleur mesurée à 4,84:1 la ramène à 3,28:1.
- **axe-core sur l'application qui tourne** : 18 pages, WCAG 2.1 AA,
  0 violation (`outils/accessibilite.mjs`).
- **La tabulation, pressée pour de vrai** : pièges, contour de focus
  réellement calculé, `tabindex` positif — 11 pages, 0 défaut
  (`outils/clavier.mjs`).
- **Taille de lecture réglable par appareil**, pas par membre : la tablette
  de la grand-mère et le téléphone de sa petite-fille n'ont pas les mêmes
  yeux, et c'est souvent le même compte.
- Lien d'évitement clavier, `aria-current`, libellés associés, focus visible.
- PWA : manifeste, Service Worker (réseau d'abord, cache en secours), page
  hors-ligne.

---

## 7. Identité et sécurité

Il n'y a **pas de mot de passe** — c'est le choix de la spec, et il tient
pour **lire**. Il ne tenait pas pour **détruire**.

| Lien | Identité | Peut |
|---|---|---|
| `/f/<familyId>` | **déclarée** | lire, écrire, questionner, répondre, archiver |
| `/f/<familyId>/m/<memberId>/<jeton>` | **vérifiée** | tout cela, **et supprimer ses propres récits et messages** |

- Cookies signés HMAC-SHA256, `HttpOnly`, `Secure` en production,
  `SameSite=Strict`, comparaison en temps constant.
- Le **niveau** d'identité est signé : sans cela, il suffirait de remplacer
  `declared` par `verified` à la main dans le cookie.
- `Member.tokenVersion` révoque un lien personnel, et lui seul.
- `Family.tokenVersion` fait tourner le lien familial pour tout le monde.
  La version entre dans la signature et se confronte à la base : une
  signature reste valide après rotation, seule la base sait qu'elle est
  périmée.
- Les routes d'API dérivent l'identité **du cookie signé, jamais d'un
  paramètre**.
- Isolation par famille : toute requête filtre par `familyId`.
- `FAMILY_TOKEN_SECRET` est vérifié au démarrage — absente, laissée à sa
  valeur de développement, ou trop courte, l'application journalise la cause
  exacte et rend 500 sur toutes les requêtes. `/api/sante` re-teste, pour
  qu'un orchestrateur marque le conteneur malade.
- Validation Zod sur toutes les entrées, limitation de débit, en-têtes de
  sécurité, pas d'indexation.

**La faille corrigée en route** : l'identité du membre se choisissait
librement dans une liste, et la suppression d'un récit la vérifiait contre un
`?memberId=` fourni par l'appelant lui-même. La garde consistait à demander à
quelqu'un s'il avait le droit, et à le croire.

---

## 8. La pile technique

| | |
|---|---|
| Cadre | Next.js 14, App Router, composants et actions serveur |
| Langage | TypeScript strict |
| Base | PostgreSQL 16 + Prisma 5 |
| Style | Tailwind CSS, palette « Organic » — quatre rampes de neuf teintes, contrastes calculés |
| Polices | Caprasimo et Figtree, **auto-hébergées** : un `@import` Google Fonts se résout en `system-ui` hors ligne, et l'application est une PWA |
| Tests | Vitest, plus axe-core et Playwright dans `outils/` |
| Compilation | `output: 'standalone'` |
| Conteneur | Docker multi-étages, image finale sans code source ni dépendances de développement |
| TLS | Caddy (machine vierge) ou nginx existant (cohabitation) |
| Redis | **absent volontairement** — utile seulement à plusieurs instances |
| Stockage | disque local ou S3/R2, pilote écrit |
| Modèle de langue | facultatif |

Coût visé, tout compris : **6 à 10 € par mois** sur un VPS Hostinger KVM 1.

---

## 9. Comment ça a été construit — les 41 étapes

Chaque ligne est un commit réel.

### Le socle (3 août)

| # | Ce qui a été fait | Ampleur |
|---|---|---|
| 1 | `Initial commit` | 1 fichier |
| 2 | **Schéma, 4 acteurs algorithmiques, API, PWA** — l'implémentation complète de la spec v1.0 | 67 fichiers, 14 899 lignes |
| 3 | Borner le coût du Passeur, relayer les questions sans réponse, finir le sprint 7 | 696 lignes |
| 4 | La veillée, et les questions en un geste | 618 lignes |
| 5 | **Faire une place aux deux générations qui ne tapent pas** — taille de lecture, dictée, simplifications | 670 lignes |
| 6 | Sept points d'un coup : accueil, correction d'un récit, identité vérifiée, échelle, pilote S3, restauration, intégration continue | 2 654 lignes |

### La transcription (3 août)

| # | | |
|---|---|---|
| 7 | La transcription — **sans promettre ce qu'aucun modèle ne peut tenir** | 1 325 lignes |
| 8 | Transcription locale à coût nul, durée illimitée, **consensus entre deux modèles** | 1 383 lignes |
| 9 | Deux défauts de la transcription, trouvés en me relisant | 228 lignes |

### La chasse à l'affirmation sans base (3 août)

| # | | |
|---|---|---|
| 10 | **Cesser d'afficher des zéros là où rien n'a pu être mesuré** | 343 lignes |
| 11 | Le graphe dit ce qu'il cache ; la veillée renonce au superlatif qu'elle n'a pas vérifié | 128 lignes |
| 12 | Ramener le Passeur et la liste des récits à ce qu'ils vérifient | 453 lignes |
| 13 | Ne plus balayer tout le corpus pour trouver les récits du jour | 89 lignes |

### Les grandes extensions (3–4 août)

| # | | |
|---|---|---|
| 14 | **Le calendrier familial** : l'occasion sans la notification | 604 lignes |
| 15 | **Le fil** — le virage complet : `Conversation` devient `Thread`/`Message`, le livre devient la sortie et plus jamais l'entrée | 32 fichiers, 2 147 lignes |
| 16 | Préparer la mise en ligne, et fermer une porte laissée ouverte | 547 lignes |
| 17 | **Les deux premières secondes** : ce qu'une famille neuve voyait vraiment | 402 lignes |
| 18 | **Amendement 6** — le produit n'affirme que ce qu'il a vérifié | 456 lignes |
| 19 | Reprendre une conversation qui existe déjà (WhatsApp) | 1 189 lignes |
| 20 | Messenger et SMS : **trois sources, un seul modèle** | 997 lignes |
| 21 | Retirer ses mots, `apporté ≠ capté`, et **le livre** | 1 057 lignes |

### Les audits (4–5 août)

| # | | |
|---|---|---|
| 22 | **Quatre manquements à la Constitution** : le cascade qui détruisait la parole des autres, l'anonymisation absente des fils, le lien familial irrévocable, le calendrier sans retrait | 34 fichiers |
| 23 | **La passe de retrait** : ce que le produit cesse de dire | 472 lignes |

### La mise en ligne (5 août)

| # | | |
|---|---|---|
| 24 | Rendre impossible d'écraser l'application déjà en ligne sur le VPS | 392 lignes |
| 25 | Kit de redesign complet, et installateur qui cohabite | 20 fichiers, 1 527 lignes |
| 26 | **Corriger la panne du premier déploiement réel** : le `CMD` de l'image | 109 lignes |
| 27 | L'installateur vérifie le domaine avant de toucher à nginx | 97 lignes |

### La parole, et ce qu'on refuse d'en dire (5–6 août)

| # | | |
|---|---|---|
| 28-33 | Le dossier complet, l'avenir, la spec de l'entretien | 4 documents |
| 34 | **Le mode entretien** : un écran, une question, un bouton | 12 fichiers |
| 35 | **La réserve** : ce dont on ne veut pas qu'on parle, silencieux par défaut | 9 fichiers |
| 36 | Fermer la boucle de l'entretien, et le plan de ce qui reste | 8 fichiers |
| 37 | L'application prend la direction « 2a », sans perdre une fonctionnalité | 21 fichiers |
| 38 | **La suspension** prend corps, et la demande portée s'affiche | 14 fichiers |
| 39 | **Audit d'accessibilité** : 17 violations trouvées, 0 restante | 16 pages |
| 40 | Habiller les dix écrans restants, et trois défauts trouvés en le faisant | 41 fichiers |
| 41 | **Presser Tab pour de vrai**, et deux outils qui mentaient | 5 fichiers |

---

## 10. La méthode : chasser une classe de défaut

Le fil rouge de cette construction n'est pas une fonctionnalité. C'est un
**type d'erreur**, nommé au commit 10 et poursuivi jusqu'au dernier :

> **Le produit affirmait ce qu'il ne savait pas.**

Aucun de ces défauts ne plantait. Aucun ne faisait échouer un test
d'exécution. Ils ne se voient qu'en posant, pour chaque phrase affichée,
deux questions : *sur quoi repose-t-elle, et que vaut-elle quand cette base
est vide ?*

### Les cas trouvés

| Ce qui s'affichait | Ce que ça voulait dire | Comment ça se lisait |
|---|---|---|
| `distorsion 0 / 100` | aucune lecture enregistrée | « mémoire parfaitement fidèle » |
| `0 récit sur-exposé` | aucune impression à examiner | « nous avons vérifié, tout va bien » |
| `transmission 0 %` | trois récits, corpus trop mince | « cette famille ne transmet pas » |
| 8 points sur un graphe | 14 récits existaient | « Robert n'apparaît que 8 fois » |
| « le récit qui relie le plus » | plusieurs en reliaient autant | un classement qui n'avait pas départagé |
| « aucun passage douteux » | aucun indice de confiance n'existait | une réassurance fabriquée |
| « il y a 10 ans » dans un flux `.ics` | vrai aujourd'hui, faux l'an prochain | une date gravée qui vieillit |
| « La montre arrêtée · 3 janvier 2026 » | date de saisie, pas de l'événement | la date de l'histoire |
| « port 8081 libre » | `ss` et `netstat` n'existaient pas | un port disponible |
| « en ligne sur https:// » | certbot venait d'échouer | un site sécurisé |

Les deux derniers sont dans mes propres outils de déploiement — le défaut
s'attrape partout, y compris chez celui qui le chasse.

### La réponse : l'amendement 6, en quatre clauses exécutables

**Clause 1 — Une mesure impossible ne vaut pas zéro.** Tout taux est une
`Mesure`, une **union discriminée** : le compilateur refuse qu'on lise
`.valeur` sans avoir traité le cas non mesurable. Un `number | null` se
rendait tel quel dans du JSX ; c'est ce qui distingue une règle d'un vœu.
Les **comptes** restent des `number` — « zéro récit » est un fait.

**Clause 2 — Une vue bornée dit ce qu'elle borne.** `divulguer()` se tait
quand rien n'est caché : on ne meuble pas non plus.

**Clause 3 — Un superlatif se vérifie avant de s'énoncer.** On demande
toujours **un candidat de plus** que nécessaire, et on compare.

**Clause 4 — Rien de dérivé du présent n'est gravé.** Tout texte mis en
cache, exporté ou copié chez un tiers passe par
`contientUnCalculPerissable()`.

### Autres défauts marquants, trouvés en testant plutôt qu'en relisant

- **`\b` en JavaScript ne fonctionne pas à côté d'un accent** — la classe de
  mots est `[A-Za-z0-9_]`. Deux motifs n'ont jamais rien détecté. Rencontré
  **deux fois** ; chaque motif porte désormais son propre exemple, avec un
  test qui vérifie qu'il déclenche encore.
- **Un test qui se testait lui-même** — un fichier qui écrit « aucun
  compteur de non-lus » contient littéralement les mots interdits. Les tests
  de source retirent maintenant les commentaires avant de chercher :
  confondre *interdire* et *faire*, c'est ne rien tester.
- **La réparation du mojibake détruisait le texte sain** — `arrêtée` devenait
  `arr` suivi de deux caractères de remplacement, puis `t`, puis un autre.
  Vérifié avant d'écrire le code ; la détection est devenue une
  précondition, et la réparation s'interrompt au premier U+FFFD.
- **Une date de seed inversée** — la réponse précédait sa question dans le
  jeu d'essai.
- **`onDelete: Cascade` sur `Thread.story`** — supprimer un récit effaçait la
  question qu'un autre membre avait posée dessous. Vérifié sur la base
  réelle : deux messages avant, zéro après.
- **Le `CMD` de l'image Docker** — `node_modules/.bin/prisma` est un lien
  symbolique que l'étage d'exécution ne copiait pas. Le conteneur sortait sur
  « not found » avant de servir. Trouvé au premier déploiement réel, sur le VPS.

### La règle de travail

À partir du milieu du projet, une règle s'est imposée : **aucune action sans
avoir relu la spec, et sans justifier contre elle**. Chaque commit cite les
sections concernées. Quand j'ai proposé un ajout qui s'en écartait, l'écart
a été écrit dans le document plutôt que dissimulé — c'est ainsi que §3.1 a
été amendé pour distinguer *captation* et *apport*.

---

## 11. Les tests

**568 tests, 28 fichiers, tous verts**, plus quatre outils de mesure qui
tournent hors de `npm test` parce qu'ils exigent un navigateur, une base
peuplée ou un serveur S3 : `outils/accessibilite.mjs` (axe-core, 18 pages,
0 violation), `outils/clavier.mjs` (la tabulation pressée pour de vrai,
11 pages, 0 défaut), `outils/captures.mjs` (la planche de
`redesign/captures/`) et `outils/stockage-s3.mts` (le pilote S3 contre un
vrai serveur S3, 10 contrôles).

Les quatre fichiers ajoutés depuis : `entretien.test.ts` (le silence de
l'écran où l'on parle), `reserve.test.ts` (les deux chemins par lesquels
une question pouvait revenir), `suspension.test.ts` (demander n'est pas
suspendre) et `contraste.test.ts` (la formule WCAG appliquée aux couleurs
lues dans la configuration, plus le plancher de 16 px sur tout `src/`).

| Fichier | Tests | Ce qu'il protège |
|---|---|---|
| `passeur.test.ts` | 41 | Pas de question sans justification, pas de comparatif non vérifié, coût borné |
| `transcription.test.ts` | 34 | Aucune transcription n'entre sans relecture ; les doutes sont signalés |
| `whatsapp.test.ts` | 30 | Quatre formats d'export, rien de deviné, rien de jeté |
| `fil.test.ts` | 25 | Le fil n'emprunte pas le moteur des salons de discussion |
| `calendrier.test.ts` | 25 | Une date ne sort que si elle existe sans l'app |
| `import-sources.test.ts` | 25 | Trois sources, un modèle, mojibake réparé sans casse |
| `audio-chunking.test.ts` | 22 | Aucun mot coupé entre deux morceaux |
| `amendement-6.test.ts` | 20 | Les quatre clauses de l'honnêteté |
| `liberte.test.ts` | 20 | Retirer ses mots sans emporter ceux des autres |
| `constitution.test.ts` | 19 | Les filtres de langage |
| `identite.test.ts` | 19 | Les deux niveaux, les révocations, la clé de production |
| `livre.test.ts` | 19 | Rien n'est perdu, aucun lien, aucun QR code |
| `retrait.test.ts` | 18 | Aucun score, aucune inactivité, aucune date fabriquée, 7 sections max |
| `veillee.test.ts` | 17 | Trois récits, une raison chacun, pas de quatrième |
| `transcription-consensus.test.ts` | 17 | Deux modèles, divergences signalées |
| `premier-jour.test.ts` | 13 | Une action, un formulaire, trois phrases |
| `conservateur.test.ts` | 12 | Mesurer sans corriger |
| `metriques-honnetes.test.ts` | 11 | Pas de zéro à la place d'une inconnue |
| `image.test.ts` | 9 | L'image n'invoque que ce qu'elle embarque |
| `conservateur-echelle.test.ts` | 9 | Seuil relatif à la taille du corpus |
| `metrics.test.ts` | 9 | Parents distincts, pas 300 % |
| `storage.test.ts` | 9 | Le pilote de stockage |
| `story.test.ts` | 9 | Le cycle de vie d'un récit |
| `trigger-model.test.ts` | 8 | Aucune source externe, aucune notification |

Une partie de ces tests **lit le source des composants** pour vérifier une
interdiction. C'est la seule façon d'empêcher une pastille rouge de revenir
dans six mois.

---

## 12. Le déploiement

**Cible** : un VPS Hostinger qui héberge déjà ASSEMBLAGES / savore, qui doit
rester en ligne.

Quatre garde-fous, par construction et non par consigne :

1. `name: heritage` fige le nom du projet Compose. Sans lui, il se déduit du
   **dossier** : un `docker compose down` lancé du mauvais répertoire
   deviendrait imprévisible.
2. L'application est publiée sur `127.0.0.1:8081` — joignable depuis la
   machine seule, donc par le proxy déjà installé. Sans le préfixe
   `127.0.0.1:`, Docker ouvrirait le port sur toutes les interfaces **et
   percerait le pare-feu au passage**.
3. Le proxy Caddy est derrière un profil `autonome` qu'il faut écrire en
   toutes lettres. `docker compose up -d` ne le démarre jamais.
4. `preflight.sh` lit l'état de la machine sans rien modifier, et refuse le
   feu vert si un port est pris **ou s'il n'a pas pu vérifier**.

`installer-a-cote.sh` enchaîne tout : vérification du domaine, secrets
(jamais remplacés — écraser `FAMILY_TOKEN_SECRET` déconnecterait toutes les
familles), construction, démarrage, puis branchement du proxy. Il détecte
nginx ou Caddy, écrit un **fichier séparé**, teste la configuration **avant**
de recharger, et retire ce qu'il vient d'ajouter si le test échoue.

**État au 5 août 2026** : l'application tourne sur le VPS et répond
`{"statut":"ok"}`. nginx est branché, savore intact. Le certificat reste à
obtenir — l'enregistrement DNS du sous-domaine doit être créé.

Sauvegardes : `sauvegarde.sh`, base compressée + archives binaires, trente
jours sur place, hors-site prêt vers Cloudflare R2. Le script **s'arrête
plutôt que de mentir** : il enchaînait `pg_dump | gzip > fichier`, où c'est
le dernier maillon du tube qui donne le code de retour — un `pg_dump` en
échec produisait vingt octets et un « sauvegarde faite » serein, pendant
que la purge effaçait la dernière copie valide au bout de trente nuits. Il
vérifie désormais le code de retour, refuse une sortie vide, relit
l'archive, et ne promeut le fichier du jour qu'après. Six tests le
tiennent, et ils échouent tous sur l'ancienne version.

---

## 13. Ce qui n'a pas été vérifié

Cette section existe parce qu'un dossier qui ne dit que ses réussites ment
par omission.

- **Le pilote S3/R2 a tourné contre un vrai serveur S3, mais pas contre
  Cloudflare R2.** `outils/stockage-s3.mts` lance un serveur S3 complet en
  local et fait dialoguer le pilote avec lui : signature v4, aller-retour
  de 512 Ko d'octets aléatoires vérifiés par empreinte, absence, retrait,
  panne. Dix contrôles, tous passés. Ce que cela n'établit pas, et qu'il ne
  faut pas lui faire dire : rien sur la latence réelle, les quotas, les
  politiques de bucket, ni sur les en-têtes que R2 traite différemment.
- **La transcription locale WebGPU n'a jamais tourné dans un vrai
  navigateur.** L'architecture est testée, le découpage audio est testé, le
  consensus est testé — le chargement du modèle dans une vraie page, non.
  C'est aujourd'hui le plus gros inconnu du produit.
- **L'image Docker n'avait jamais été construite** avant le déploiement
  réel, Docker Hub étant bloqué par le proxy de l'environnement de
  développement. C'est exactement là que la première panne est survenue.
  `tests/image.test.ts` couvre désormais la classe de défaut, pas l'image.
- **Le livre et le hors-ligne se vérifient maintenant**, et ne se
  vérifiaient pas avant. `outils/hors-ecran.mjs` bascule le rendu en média
  `print`, produit un vrai PDF, et contrôle que le menu, la navigation et
  le pied de page ne s'impriment pas, qu'aucune adresse web ne suit les
  liens, qu'un récit ne se coupe pas entre deux pages, et que le fond est
  blanc. Puis il coupe le réseau — par un relais qu'il tient lui-même,
  parce que ni `setOffline` ni l'interception de Playwright n'atteignent
  une requête émise par le Service Worker — et vérifie qu'une page déjà lue
  reste lisible et qu'une page jamais lue rend le repli plutôt qu'un
  contenu vide.

- **Aucune famille réelle n'a utilisé le produit.** Tout ce qui est écrit ici
  sur l'usage est une hypothèse.

---

## 14. Ce qui reste ouvert

- **Obtenir le certificat TLS** : créer l'enregistrement DNS `A`, relancer
  `installer-a-cote.sh` avec le vrai sous-domaine.
- **Table d'alias persistante pour les imports** : les participants sont
  re-associés à chaque import, d'une source à l'autre.
- **Test du pilote S3 contre un vrai bucket R2** — le dialogue S3 est
  vérifié en local, le service de Cloudflare ne l'est pas.
- **La transcription locale dans un vrai navigateur.**
- **Trois choses que je ne toucherai pas sans qu'on me le demande** :
  l'audio jouable sur un récit (« Écouter Robert le raconter »), les
  marques étendues aux récits, et la réduction des 33 types de structure —
  j'ai un soupçon là-dessus, pas une donnée.

Le redesign, lui, n'est plus ouvert : la direction « 2a » est appliquée à
tous les écrans, et `redesign/captures/` en porte les 18 captures,
régénérables par `outils/captures.mjs`.

---

*Ce document décrit l'état de la branche `claude/heritage-app-spec-acztj1`
au 6 août 2026. Les chiffres du §2 sont comptés sur l'arbre, pas recopiés.*
