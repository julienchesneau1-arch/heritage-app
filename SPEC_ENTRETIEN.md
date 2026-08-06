# Le mode entretien — spécification

Extension hors spec v1.0, assumée. Rédigée après le verdict du comité et
la question sur le refus de parler d'un sujet — les deux se répondent, et
c'est pourquoi ils sont spécifiés ensemble.

---

## 1. Le problème

Les deux personnes qui détiennent le plus de mémoire dans une famille sont
souvent celles qui écrivent le moins. La §5.5 l'a déjà reconnu pour l'enfant
de sept ans ; c'est aussi vrai à l'autre bout.

Toutes les pièces existent — le Passeur pose une question, l'enregistreur
capte la voix, la transcription exige une relecture humaine (§3.5) — mais
elles ne sont pas assemblées en un geste. Aujourd'hui, pour raconter à voix
haute, il faut savoir naviguer jusqu'à `/recits/nouveau`, comprendre la
différence entre auteur et narrateur, choisir un type de structure. C'est
demander de savoir se servir d'une application pour avoir le droit de parler.

**Le mode entretien n'ajoute aucun concept. Il compose ce qui existe.**
C'est ce qui le rend peu risqué : s'il est faux, le retirer ne coûte rien.

---

## 2. Le principe

> Un écran. Une question. Un bouton.

Aucun clavier. Aucun texte à lire au-delà de la question elle-même. Aucun
choix à faire, hors « passer ».

Et une séparation qui est le cœur du dispositif : **celui qui parle n'est pas
celui qui relit.** §2.3 sépare déjà le narrateur du scribe ; ici la
séparation devient le mode d'emploi. Jeanne parle, Emma relit.

Cette séparation crée un rôle que personne n'avait : le relecteur. Ce n'est
pas « animer la mémoire familiale » — tâche vague dont on se lasse — c'est
« relire ce que ta grand-mère a dit hier », qui est court, concret, et se
reprend après six mois d'interruption. C'est la réponse la plus solide que
je voie au risque du porteur unique.

---

## 3. Les deux rôles

| | Celui qui parle | Celui qui relit |
|---|---|---|
| Voit | une question, un bouton | le texte proposé, l'audio, les passages douteux |
| Peut | parler, passer, réécouter, **détruire** | corriger, valider, **jamais publier sans validation** |
| Ne voit jamais | le texte transcrit avant de l'avoir voulu | ce qui a été détruit par celui qui a parlé |

**Le brouillon appartient à celui qui a parlé.** C'est le point le plus
important de cette section et il n'est pas dans le modèle actuel :
`TranscriptionDraft` a un `validatedById`, pas de propriétaire. Aujourd'hui,
celui qui parle ne peut pas reprendre ce qu'il vient de dire.

Il le pourra : **après avoir réécouté, avant que le brouillon ne devienne
quoi que ce soit, il peut le détruire entièrement.** Sans justification,
sans que le relecteur soit informé de ce qui a disparu — seulement qu'il n'y
a rien à relire.

---

## 4. Le déroulé

### 4.0 Avant d'enregistrer — ce qui doit être dit

Une phrase, avant le premier bouton, jamais après :

> **Ce que vous direz sera relu par Emma.**

La confidentialité d'un entretien n'est pas une note de bas de page. Quelqu'un
qui parle seul dans une pièce doit savoir qui l'écoutera, avant d'ouvrir la
bouche. Si personne n'est désigné, l'entretien ne commence pas.

Et, au même écran, l'accès à la réserve (§5) : *« Y a-t-il des choses dont
vous ne voulez pas qu'on vous parle ? »* — posé **une fois**, jamais répété.

### 4.1 La question

Plein écran, en grand. Elle vient du Passeur, ou de la liste courte de la
§5.5 (« Qui est-ce ? », « C'était quand ? », « C'était où ? », « Et après ? »),
ou d'une entité (« Parlez-moi de la montre de Robert »).

Sous la question, sa **justification** en petit gris — §6.2 l'exige pour
toute suggestion, et une question posée à voix haute n'y échappe pas.

### 4.2 Parler

Un seul bouton, très grand. On appuie, on parle, on relâche. L'enregistrement
s'affiche comme une durée, jamais comme une forme d'onde animée — rien qui
donne l'impression d'une performance.

**« Passer » est toujours présent, à côté**, de la même taille que le reste,
et il ne demande jamais pourquoi.

### 4.3 Réécouter

Immédiatement après, avant toute transcription : l'audio, un bouton pour
réécouter, deux issues — **« Garder »** ou **« Effacer »**. Effacer détruit
l'enregistrement, ne crée aucun brouillon, ne laisse aucune trace.

Ce moment est celui où quelqu'un qui vient de dire quelque chose qu'il
regrette peut le reprendre. Il doit être là, et il doit être avant la
transcription — sinon le texte existe déjà quelque part.

### 4.4 Question suivante

Sans compteur, sans « 3 sur 10 », sans barre de progression. On s'arrête
quand on veut ; « Terminer » est visible en permanence.

### 4.5 La relecture

Le relecteur reçoit ce qui a été gardé. L'écran existe déjà
(`/brouillons/[draftId]`) : texte proposé, audio à côté, passages douteux
signalés par le consensus entre deux modèles, édition libre, validation.

Une seule addition : **le nom de celui qui a parlé est le narrateur du récit
qui en naîtra**, jamais celui du relecteur. C'est déjà la règle §2.3 ; ici
elle est automatique.

---

## 5. La réserve — le droit de ne pas parler d'un sujet

Cette section répond à la question posée le 5 août : *« si une personne ne
veut absolument pas parler d'un sujet, quitte à demander aux autres de ne pas
en parler, comment l'application doit-elle interagir ? »*

Elle est spécifiée **ici** et non ailleurs, parce que c'est dans l'entretien
que le risque est maximal : quelqu'un parle seul, à voix haute, souvent âgé,
souvent fatigué, à une machine qui pose des questions.

### 5.1 Le principe, déjà écrit

La §2.6 le dit, et toute la suite en découle :

> **Un membre peut décider de ne plus voir un récit ; il ne peut pas décider
> à la place des autres.**

Trois droits, et ils ne sont pas égaux :

| Droit | Portée |
|---|---|
| Sur **ses propres mots** | **Absolu.** Retirer, corriger, se taire. (Point 6, §2.1 règle 2 amendée) |
| Sur **sa propre écoute** | **Absolu.** Ne plus voir, ne plus être questionné, ne pas figurer au calendrier. (`StoryMute`, §2.6, `calendarOptOut`) |
| Sur **les mots des autres** | **Aucun** — mais pas rien. Voir 5.4. |

**Pourquoi la troisième ligne tient, même quand elle fait mal.** Dans une
famille, la personne la plus capable d'exiger le silence est rarement celle
qui souffre le plus. Un bouton « interdire qu'on parle de ça » sera utilisé
par le membre le plus autoritaire avant de l'être par le plus blessé — c'est
le mécanisme même qui fabrique les secrets de famille, et ce produit existe
en partie contre lui. Le souvenir qu'a Claire du départ de son père est le
souvenir de Claire, même s'il parle de son père.

### 5.2 La réserve personnelle

Une personne déclare un sujet — une entité, ou quelques mots libres. Le
Passeur ne le lui présente plus **jamais**, dans l'entretien comme ailleurs.

**Silencieuse par défaut.** Personne d'autre ne la voit, ni son existence, ni
son objet.

> **Le piège :** si l'application affiche « Jeanne a demandé qu'on ne parle
> pas de X », elle vient d'apprendre à toute la famille que X existe et fait
> mal. **La réserve peut être plus révélatrice que le récit.** C'est la
> personne — jamais le produit — qui décide de la rendre visible.

Réversible à tout moment, par l'intéressée seule. Comme `StoryMute`.

### 5.3 La demande portée à la famille

Si la personne le choisit explicitement, sa demande devient visible — **dans
ses mots à elle**, jamais reformulée — au moment où quelqu'un commence à
écrire sur ce sujet. Puis l'application laisse faire.

**Elle porte la demande. Elle ne l'applique jamais.**

Le jour où une machine impose le respect d'un souhait familial, ce n'est
plus un acte de respect : c'est une règle qu'on contourne. Le rôle du
produit est d'être un messager fidèle, pas un juge.

### 5.4 Le désaccord

Claire écrit quelque chose de vrai et de blessant sur Jeanne. Jeanne n'est ni
l'auteur ni le narrateur : elle ne peut pas le supprimer. Ce qu'elle peut :

1. **Se délier** — ne pas être liée comme entité, ne jamais recevoir ce récit
   en suggestion.
2. **Répondre.** Attacher son propre récit à celui-là. Et c'est la réponse
   constitutionnelle : dans une mémoire familiale, **on répond à une histoire
   par une autre histoire**. C'est la primitive elle-même.
3. **S'y opposer** — et alors :

> **La suspension.** Le récit n'est ni détruit ni publié. Il devient
> invisible à tous **sauf aux deux personnes concernées**, et il attend.
> Sans minuteur. Sans relance. Sans « résolvez ce désaccord ».
>
> Un récit suspendu trente ans est une issue acceptable. Un récit détruit,
> ou publié de force, ne l'est pas.

**⚠ Décision ouverte.** C'est le seul point de ce document qui relève d'un
choix de valeurs et non d'une déduction. Deux autres politiques existent :
« l'auteur garde toujours » (le produit peut servir à exposer quelqu'un) ou
« l'objection efface toujours » (le produit sert à faire taire). Je recommande
la suspension parce qu'elle est la seule des trois qui ne trahisse personne.
**À confirmer avant implémentation.**

### 5.5 La règle générale que j'en tire

> **Un signal comportemental ne peut que RETIRER, jamais ajouter.**

Quelqu'un passe deux fois une question sur la même entité : le Passeur cesse
de la poser. Silencieusement. Sans le nommer, sans l'afficher, sans demander
pourquoi.

Ce n'est pas inférer une émotion — l'amendement 1 vise la déduction d'un
**sentiment** ; ici on obéit à un **comportement**, et toujours dans le sens
de la retenue. La règle est testable : tout usage d'un signal comportemental
doit réduire ce que le produit propose, jamais l'augmenter.

### 5.6 Quatre choses interdites

- **Deviner qu'un sujet est sensible.** Aucun modèle, aucune classification,
  aucune détection. Seule une déclaration humaine compte. (Amendement 1)
- **Demander pourquoi.** Passer une question ne s'explique pas.
- **Parler au nom d'un absent.** « Papa n'aurait pas voulu » n'est pas une
  réserve, c'est quelqu'un qui parle à la place d'un mort. Aucun mécanisme.
- **Compter les silences.** Ni « 3 sujets en réserve », ni indicateur, ni
  statistique. Ce serait un score sur la douleur. (§12)

---

## 6. Le modèle de données

Volontairement minimal. Trois ajouts, aucune table nouvelle sauf une.

```prisma
model TranscriptionDraft {
  // …existant…

  // Celui qui a PARLÉ. Le brouillon lui appartient : il peut le détruire
  // entièrement avant qu'il ne devienne un récit, sans justification.
  // Aujourd'hui seul `validatedById` existe — le relecteur, pas la voix.
  spokenById String? @map("spoken_by_id")

  // La question posée, conservée telle quelle : un texte transcrit sans
  // sa question est une réponse sans énoncé.
  promptText String? @map("prompt_text")
}

model Reserve {
  id       String @id @default(cuid())
  familyId String @map("family_id")
  memberId String @map("member_id")

  // Une entité, ou quelques mots. Jamais interprété, jamais classé.
  entityId String? @map("entity_id")
  sujet    String?

  // 'silencieuse' : personne d'autre ne la voit. Défaut.
  // 'portee'      : visible à l'écriture, dans les mots de l'intéressé.
  portee String @default("silencieuse")

  // Ses mots, s'il a choisi de les adresser à la famille. Jamais reformulés.
  demande String?

  createdAt DateTime @default(now()) @map("created_at")

  @@index([familyId, memberId])
  @@map("reserves")
}
```

Et sur `Story`, pour la suspension — **si la décision 5.4 est confirmée** :

```prisma
  // Suspendu à la demande d'un membre nommé. Ni détruit, ni publié.
  // Visible uniquement par l'auteur et par celui qui s'y oppose.
  suspendedById String?   @map("suspended_by_id")
  suspendedAt   DateTime? @map("suspended_at")
```

`quarantined` existe déjà mais appartient au Conservateur : mélanger les deux
mettrait une décision humaine et une décision algorithmique dans le même
champ, et on ne saurait plus laquelle a agi.

---

## 7. Ce que le mode entretien n'est pas

- **Pas un assistant.** Il ne relance pas, ne reformule pas, ne dit pas
  « intéressant, continuez ». Il pose une question et se tait.
- **Pas une séance.** Ni durée cible, ni nombre de questions, ni « vous avez
  répondu à 7 questions cette semaine ».
- **Pas un test.** Aucune question ne vérifie ce que la personne se rappelle.
  Un produit de mémoire qui évalue la mémoire de quelqu'un est une insulte.
- **Pas une captation.** L'audio n'est jamais envoyé sans que la personne ait
  réécouté et dit « garder ».

---

## 8. Les tests à écrire

| Ce qui est vérifié | Pourquoi |
|---|---|
| Le nom du relecteur est affiché **avant** le premier enregistrement | §4.0 |
| « Passer » est présent à chaque question, et ne demande jamais de raison | §4.2 |
| Détruire un brouillon ne laisse au relecteur aucune trace de son contenu | §3 |
| Le narrateur du récit issu d'un entretien est celui qui a parlé | §2.3 |
| Une réserve silencieuse n'apparaît dans aucune sortie : ni page, ni export, ni livre | §5.2 |
| Le Passeur ne propose jamais une entité sous réserve à son auteur | §5.2 |
| Deux « passer » sur la même entité arrêtent la question, sans rien afficher | §5.5 |
| Aucun écran ne compte les réserves ni les silences | §5.6, §12 |
| Aucune classification automatique de sensibilité nulle part dans le source | §5.6 |
| L'écran d'entretien n'affiche ni compteur, ni progression, ni durée cible | §7 |

---

## 9. Ce qu'il faut décider avant d'écrire une ligne

1. **La politique du désaccord** (§5.4). Suspension sans vainqueur — ma
   recommandation — ou l'une des deux autres.
2. **Qui relit.** Désigné par la famille une fois pour toutes, ou choisi à
   chaque entretien ? Je penche pour *désigné à chaque entretien par celui
   qui le lance*, parce qu'un relecteur permanent devient un dépositaire de
   tous les secrets de la maison sans que personne l'ait décidé.

Le reste de ce document est déductible de la Constitution et n'appelle pas
d'arbitrage.
