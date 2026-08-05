# Avis, philosophie, avenir

Écrit le 5 août 2026, à votre demande, après avoir construit ce produit
entièrement. Tout ce qui suit est adossé à `HERITAGE_SPEC.md` — quand je
propose quelque chose, je dis quelle règle l'autorise, et quand je critique,
je dis laquelle est en cause.

Un avertissement d'abord, et il vaut pour tout ce document : **aucune famille
réelle n'a utilisé cette application.** Ce qui suit est un jugement de
construction, pas un retour d'usage. Je le signale ici une fois, et je le
rappellerai là où l'écart compte.

---

## I. Ce que je pense de ce qui existe

### Ce qui tient vraiment

**La primitive est réelle, pas décorative.** Beaucoup de produits annoncent
un principe et bâtissent autre chose. Ici « une histoire doit engendrer une
autre histoire » a sa propre table (`Passage`), un déclencheur typé, une
mesure, et un service entier — le Passeur — dont c'est l'unique mission.
Quand j'ai voulu supprimer un récit et que ça effaçait la question posée
dessous, c'est la primitive qui a dit non, pas mon goût.

**La Constitution est exécutable.** C'est le choix le plus fort du document
initial et je ne l'ai vu nulle part ailleurs. Interdire l'inférence
émotionnelle dans un manifeste ne coûte rien ; la faire échouer un test
change ce qu'on peut écrire. `Mesure` est le meilleur exemple : c'est une
union discriminée, donc le compilateur **refuse** qu'on affiche un taux sans
avoir traité le cas où il n'est pas mesurable. On ne peut pas mentir par
distraction.

**Le livre est la meilleure idée du produit**, et je ne l'ai comprise qu'en
la construisant. C'est la seule pièce qui serve le point 7 — le succès est
que la famille continue sans l'app. Tout le reste augmente la dépendance ;
le livre la diminue. Et sa section « Ce que ce livre ne dit pas », avec des
lignes vides pour écrire à la main, est le moment où le produit admet
qu'il est incomplet — ce qu'aucun livre de famille commercial ne fait.

**Le fil a débloqué le produit.** Avant lui, entrer dans la mémoire exigeait
de rédiger un récit. Une page blanche devant une grand-mère de 92 ans, c'est
un produit mort. La bascule — le livre devient la **sortie**, plus jamais
l'entrée — est le tournant, et c'est vous qui l'avez provoquée en disant que
ça vous faisait penser à Discord.

### Ce qui ne tient pas encore

**La taxonomie des 33 types de structure narrative** (Annexe B). Je l'ai
implémentée parce que le document la demandait. Je ne crois pas qu'une
famille s'en serve. Elle demande à quelqu'un qui vient de raconter la montre
de son père de choisir entre 33 étiquettes. Je parie qu'à l'usage, deux ou
trois seront utilisées et que le reste sera du bruit — mais **je n'ai aucune
donnée**, et c'est exactement le genre d'affirmation que l'amendement 6
interdit de servir comme un fait. À vérifier sur une vraie famille, pas à
trancher ici.

**Les traditions et le calendrier se recouvrent.** Une tradition annuelle est
une date qui revient ; le flux `.ics` publie déjà les dates qui reviennent.
Deux mécanismes pour une même chose, avec deux endroits où oublier une règle.
La page Traditions garde une raison d'exister — le verbe « endormir » — mais
la frontière est floue.

**Le graphe reste le maillon faible.** Depuis le fil il n'est plus décoratif,
c'est la porte vers les fils d'entités. Mais 359 lignes pour une image que
la §5.3 interdit de rendre explorable, c'est cher. Je l'ai gardé à la passe
de retrait parce que le document le demande — pas parce que je l'aurais
inventé.

**Il n'y a rien pour la mort.** Une application de mémoire familiale dont la
raison d'être est qu'il sera un jour trop tard, et qui n'a rien pour le jour
où c'est arrivé, a un trou en son centre. `deathDate` existe, le calendrier
cesse de souhaiter l'anniversaire d'un défunt, c'est tout. J'y reviens en
partie IV.

---

## II. La philosophie, telle que je la comprends

### Le vrai sujet n'est pas la mémoire, c'est la question

La plupart des produits de ce domaine se trompent d'objet. Ils optimisent le
**stockage** : plus de photos, mieux rangées, retrouvables. Or une famille ne
perd pas ses souvenirs faute de disque dur. Elle les perd **faute d'occasion
de les dire**.

Ce que votre document a compris, et qui est rare : le goulot n'est pas la
capture, c'est le **déclenchement**. D'où le Trigger Model, d'où le Passeur,
d'où la veillée. L'application ne demande pas « qu'avez-vous à conserver ? »
mais « voici pourquoi c'est le moment de raconter ceci ».

C'est aussi pourquoi la question de l'enfant de sept ans (§5.5) est plus
importante qu'elle n'en a l'air. « Pourquoi ? » est le vrai moteur de
transmission dans une famille réelle. Le produit a réussi le jour où il a
cessé d'exiger qu'on sache écrire pour poser une question.

### La dispensabilité n'est pas de la modestie, c'est une stratégie

Le point 7 — *le succès ultime est que la famille continue sans l'app* — est
la ligne la plus radicale du document, et je pense qu'elle est aussi la plus
juste commercialement, pour une raison qui n'est pas morale.

Un produit qui retient ses utilisateurs par le manque construit une relation
que les gens finissent par détester. Ils restent, et ils en veulent au
produit de les retenir. Un produit qui rend la chose **transportable** — le
livre, l'export intégral, le calendrier dans l'agenda qu'on a déjà — construit
une relation où l'on revient parce qu'on veut. C'est plus lent. C'est plus
solide.

Le prix de cette ligne est réel et il faut le dire : **ce produit ne
grandira jamais tout seul.** Toutes les mécaniques de croissance connues —
notification, invitation virale, série, badge, partage public — sont
interdites par la §12 et la §6.1. Ce n'est pas un oubli à combler, c'est le
choix. Il faut donc que la croissance vienne d'ailleurs, et je propose où en
partie IV.

### Le défaut que ce projet m'a appris à nommer

Douze fois pendant la construction, le produit a **affirmé ce qu'il n'avait
pas établi**. `distorsion 0/100` sur une famille sans lecture se lisait
« mémoire parfaitement fidèle ». Huit points sur un graphe laissaient croire
qu'il n'y en avait que huit. Une date de saisie se lisait comme la date de
l'événement.

Aucun ne plantait. Aucun ne faisait échouer un test. Et deux d'entre eux
étaient dans mes propres outils de déploiement — « port libre » quand je
n'avais pas pu regarder, « en ligne sur https » quand le certificat venait
d'échouer.

Je crois que c'est **la** classe de défaut des produits qui manipulent de la
mémoire, parce que la mémoire est précisément le domaine où l'on ne peut pas
vérifier ce qu'on nous dit. Une application qui affirme une date, un lien de
parenté, un « c'était l'été 1971 » que personne n'a confirmé, fabrique du
faux souvenir. L'amendement 6 n'est pas une coquetterie d'ingénieur : c'est
la seule protection contre le pire échec possible de ce produit — **inventer
le passé d'une famille**.

---

## III. Le risque qui tuera ce produit si rien ne change

Je le dis franchement, parce que c'est le seul point où je pense que le
document ne répond pas.

**Ce produit dépend d'une seule personne par famille.**

Il y a toujours un porteur : celui qui a créé la famille, distribué les
liens, relancé les autres. Tous les projets de mémoire familiale meurent de
la même façon — le porteur se lasse, déménage, tombe malade, meurt — et rien
ne prend le relais. L'application a aujourd'hui trois réponses, et elles sont
minces :

- le Passeur, qui pose une question — mais à qui ouvre l'app ;
- le calendrier, qui met une date dans un agenda déjà consulté — le seul
  mécanisme actuel qui atteigne quelqu'un qui n'a pas ouvert l'application ;
- la veillée, qui suppose que quelqu'un décide de la lancer.

Les trois supposent une intention. Le jour où plus personne n'a l'intention,
la mémoire est intacte, complète, exportable — et morte.

**Le calendrier est la seule vraie trouvaille sur ce front**, et je crois
qu'elle est sous-exploitée. C'est le seul endroit où le produit existe en
dehors de lui-même, sans rien enfreindre : la date était là avant lui.

---

## IV. L'avenir — ce que je construirais, dans cet ordre

Chaque proposition porte la règle qui l'autorise. Aucune n'enfreint la §6.1,
la §12 ni l'Annexe A. Je les donne dans l'ordre où je les ferais.

### 1. Le mode entretien — la plus importante

**Le constat.** Les deux personnes qui détiennent le plus de mémoire dans une
famille sont souvent celles qui écrivent le moins. Le produit a déjà chacune
des pièces — le Passeur pose une question, l'enregistreur capte la voix, la
transcription passe par une relecture humaine — mais elles ne sont pas
assemblées en un geste.

**Ce que ce serait.** Un écran, une question, un gros bouton. On appuie, on
parle, on relâche. Question suivante. Aucun texte à lire au-delà de la
question, aucun clavier, aucun champ. À la fin, la transcription part chez
**quelqu'un d'autre** — l'enfant, le petit-enfant — qui relit et valide.

**Pourquoi c'est juste.** §2.3 sépare déjà le narrateur du scribe : ici la
séparation devient le mode d'emploi. §3.5 exige la relecture humaine, et le
relecteur n'a jamais eu de rôle aussi clair. §5.5 a déjà admis que « ceux que
la page blanche arrête » méritent un autre chemin.

**Ce que ça change.** C'est le seul dispositif qui rende le produit
utilisable par quelqu'un qui ne sait pas s'en servir. Et il crée un rôle pour
le jeune de la famille : non pas « écrire ses souvenirs » — personne ne veut
ça — mais **relire ceux de sa grand-mère**. C'est une tâche courte, concrète,
et qui donne envie de continuer.

### 2. L'objet comme déclencheur

**Le constat.** `Entity` connaît déjà trois types : personne, lieu, **objet**.
La montre de Robert est une entité, elle porte son fil. Mais la montre est
dans un tiroir, et le tiroir ne parle pas.

**Ce que ce serait.** Une étiquette imprimable — un simple code — que l'on
colle sous l'objet. Qui le prend et le scanne arrive sur le fil de cet objet.
Rien d'autre.

**Pourquoi ça ne viole rien.** La §3.1 exige que le déclencheur existe **sans
l'application** : un objet dans un tiroir existe sans elle, absolument. Ce
n'est pas une notification — c'est un humain qui touche une chose et qui
demande. Le sens de la flèche est le bon : ce n'est pas le produit qui
interrompt, c'est le monde qui rappelle.

**La réserve.** Le livre interdit le QR code (Annexe A point 7 : il ne doit
renvoyer à aucun écran). L'étiquette n'est pas le livre — elle est sur
l'objet, pas dans la sortie. Mais la frontière mérite d'être écrite dans la
spec avant d'être franchie, pas après.

### 3. Le rite du départ

**Le constat.** Le trou central. Le produit n'a rien pour le jour où
quelqu'un meurt, alors que c'est le jour où tout ce qu'il porte devient
irremplaçable.

**Ce que ce serait, et surtout ce que ce ne serait pas.** Rien
d'automatique. Rien de déclenché par une date. Une seule action manuelle,
posée par un membre : *« Jeanne est partie. »* Ce qui suit :

- l'application cesse de proposer son anniversaire (elle le fait déjà) ;
- un fil unique s'ouvre, qui n'est ni poussé ni notifié : il attend ;
- **son livre** devient composable — tous les récits qu'elle a racontés ou
  qui la mentionnent, dans un objet imprimable ;
- rien n'est supprimé, rien n'est archivé d'office.

**Pourquoi c'est délicat et pourquoi je le propose quand même.** L'amendement
1 interdit d'inférer une émotion — donc le produit ne dira jamais « nous
sommes désolés », ne changera pas de couleur, ne mettra pas de bandeau noir.
Il fera une chose et une seule : **rendre disponible ce qu'elle a dit**.
C'est la version la plus sobre possible, et c'est la seule que la
Constitution autorise. Un produit de mémoire qui n'a rien pour la mort n'a
pas fini de répondre à sa propre question.

### 4. La succession du lien

**Le constat.** `Family.tokenVersion` permet de faire tourner le lien
familial. Mais qui le fait tourner dans trente ans ? Le produit promet
cinquante ans de mémoire et n'a aucune réponse à « le fondateur n'est plus
là ».

**Ce que ce serait.** Un second porteur désigné, avec identité vérifiée, qui
peut faire tourner le lien et distribuer les nouveaux. Deux clés au lieu
d'une, et la famille sait où sont les deux.

**Pourquoi.** §4.1 assume qu'il n'y a pas de mot de passe : le lien **est**
le secret. Un secret sans succession est un secret perdu. Ce n'est pas une
fonctionnalité, c'est la condition pour que la promesse tienne.

### 5. Le livre, décliné

Le livre existe. Trois variantes coûtent peu et servent chacune une occasion
réelle :

- **le livre d'une personne** — tout ce que Jeanne a raconté, tout ce qui la
  mentionne. C'est le cadeau d'anniversaire, et c'est l'objet du deuil ;
- **le livre d'une année** — ce que la famille a gardé cette année-là.
  L'échéance annuelle est ce qui fait vivre les projets de famille ;
- **la carte** — une page : un récit, une question, et de la place pour
  répondre à la main. À poster à celui qui n'est pas en ligne du tout.

**Pourquoi.** Annexe A point 7. Chaque variante augmente ce qui existe hors
de l'application. La carte, en particulier, est le seul chemin vers le
membre de la famille qui n'aura jamais de compte — et il y en a un dans
chaque famille.

### 6. Le porteur, adressé de front

Le risque de la partie III mérite une réponse construite, pas un espoir.
Trois pistes, par ordre de solidité :

- **L'échéance annuelle.** Le livre de l'année, composé en novembre pour
  Noël. Une date que la famille se donne, pas que le produit impose. C'est
  la seule forme de régularité que la §12 autorise, parce qu'elle vient
  d'une tradition — et les traditions sont déjà un objet du modèle.
- **Le relecteur.** Le mode entretien crée un rôle sans le nommer : celui
  qui valide les transcriptions. C'est une tâche brève, utile, et qui n'exige
  aucune inspiration. Beaucoup plus facile à reprendre que « animer la
  mémoire familiale ».
- **La veillée à deux foyers.** Les mêmes trois récits, le même soir, dans
  deux maisons. Le produit n'a rien à synchroniser — ils sont déjà les mêmes
  pour toute la famille. Il suffit de le dire. **Sans jamais afficher qui est
  connecté** : ce serait la présence, et le fil l'interdit.

### 7. Ce que je ne ferais à aucun prix

Cette liste vaut autant que la précédente.

- **Aucun fil d'actualité, aucun partage public.** Une mémoire familiale
  n'a pas d'audience.
- **Aucun souvenir généré.** Ni texte « à la manière de », ni photo
  restaurée, ni voix synthétisée d'un défunt. C'est techniquement à portée et
  c'est la trahison maximale : le produit inventerait le passé qu'il est
  censé garder.
- **Aucune notification « il y a un an ».** C'est le mécanisme le plus
  rentable du secteur et le plus explicitement interdit ici (§3.1 : une date
  ne sort que si elle existe sans l'app).
- **Aucun classement entre membres.** Ni « le plus actif », ni « celui qui
  raconte le plus ».
- **Aucun abonnement pour accéder à sa propre mémoire.** Voir ci-dessous.

---

## V. Sur l'argent, puisque vous l'aviez demandé

Mon avis n'a pas changé, et je peux maintenant le justifier mieux.

**Ce qui est indéfendable :** faire payer l'accès. L'amendement 3 dit que la
famille possède ses données ; le point 6 dit que l'oubli est un droit absolu.
Un produit qui coupe l'accès à la mémoire d'une famille pour défaut de
paiement contredit les deux. Et commercialement, c'est un modèle qui repose
sur la peur de perdre — exactement ce que ce produit refuse.

**Ce qui est défendable, par ordre de justesse :**

1. **L'objet.** Le livre imprimé, relié, expédié. On paie une chose qu'on
   reçoit et qu'on garde. Le fichier reste gratuit — on paie le papier, pas
   la mémoire. C'est le seul modèle parfaitement aligné sur le point 7 :
   plus on vend, plus la famille est indépendante de l'application.
2. **L'hébergement.** Un prix fixe et bas pour ne pas tenir son propre
   serveur, avec l'export intégral disponible à tout moment et
   l'auto-hébergement documenté. On paie un service, pas un otage.
3. **L'entretien accompagné**, un jour, si le mode entretien existe : quelqu'un
   qui vient enregistrer une aïeule. C'est un métier, pas un logiciel.

**Ce que je ne ferais pas :** le gratuit limité à 50 récits. Décider qu'une
famille a trop de souvenirs pour son forfait est une phrase qu'on ne devrait
pas pouvoir écrire.

---

## VI. Ce que je changerais dans le document initial

Vous m'avez demandé de ne déroger à aucune règle. Je n'y déroge pas — je
propose de les amender là où elles se contredisent, comme on l'a déjà fait
six fois.

**§9.1, la North Star.** `transmission_rate > 20 %` mesure le produit, et
je l'ai retirée de l'écran de la famille pour cette raison. Mais je vais plus
loin : **la vraie réussite de ce produit n'est pas mesurable par lui.** Le
point 7 dit que le succès est que la famille transmette sans l'application —
or une transmission qui a lieu sans l'application ne laisse aucune trace
dedans. Le produit ne peut pas mesurer sa propre victoire. Je propose de
l'écrire dans la spec plutôt que de le contourner : `transmission_rate` reste
un indicateur de santé interne, et la North Star véritable est déclarée
**non instrumentable**. C'est cohérent avec l'amendement 6 : ne pas prétendre
mesurer ce qu'on ne peut pas voir.

**Annexe B, les 33 types.** Je propose de les garder en base et de n'en
proposer que quelques-uns à la saisie, le reste derrière un dépliant. La
liste est une richesse pour l'analyse et un obstacle à la saisie.

**§5.3, le graphe.** À réévaluer une fois qu'une famille aura cinquante
entités. Je n'ai pas de donnée, seulement un doute — et l'énoncer sans donnée
est déjà le maximum que je m'autorise.

**§3.1, le calendrier.** À promouvoir. Ce n'est pas une extension parmi
d'autres : c'est le seul mécanisme qui atteigne quelqu'un sans rien
enfreindre, et il mérite sa section propre plutôt qu'un « hors spec assumé ».

---

## VII. En un paragraphe

Ce n'est pas une startup et je crois qu'il ne faut pas essayer d'en faire
une : les mécaniques qui font grandir un produit sont précisément celles que
ce document interdit, et il a raison de les interdire. C'est un **objet** —
avec un logiciel autour — dont la valeur se mesure en décennies et dont la
meilleure publicité sera un livre posé sur une table basse, que quelqu'un
ouvre et qui demande d'où il vient. La prochaine chose à construire n'est
donc pas une fonctionnalité de plus : c'est **le mode entretien**, parce
qu'il est le seul qui aille chercher la mémoire là où elle se trouve
réellement — chez ceux qui ne taperont jamais.
