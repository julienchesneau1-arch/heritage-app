# 26 — REGISTRE DES ZONES D'OMBRE

**Balayage systématique.** Objectif : qu'il ne reste **aucune incertitude non
énumérée**.

Il faut dire tout de suite ce que ce document ne prétend pas être. Certaines
incertitudes sont **irréductibles** — aucune mesure, aucun code, aucun budget
ne les fera disparaître. Prétendre les supprimer serait le mensonge le plus
coûteux du dépôt.

> Une zone d'ombre **nommée et bornée** n'est plus une zone d'ombre.
> C'est une limite connue. Le danger n'est pas l'inconnu — c'est **l'inconnu
> qu'on ignore être inconnu**.

Trois classes, et une seule est acceptable en silence :

| Classe | Sens |
|---|---|
| **SUPPRIMÉE** | mesurée, corrigée, gardée par un invariant |
| **IRRÉDUCTIBLE** | démontrée impossible à lever ; doit rester écrite |
| **DIFFÉRÉE** | levable, non levée ; avec sa condition de réouverture |

---

## 1. Méthode

Quatre balayages, dans cet ordre :

1. **Couverture** — quel code n'est jamais exécuté ?
2. **Motif récurrent** — le même défaut a frappé quatre fois ; où frappe-t-il
   une cinquième ?
3. **Affirmations non mesurées** — quels « NON TESTABLE » sont des
   suppositions déguisées ?
4. **Énumération** — tout le reste, classé.

---

## 2. SUPPRIMÉES — mesurées et fermées pendant ce balayage

### 2.1 Les échéances persistées étaient frappées par l'horloge du processus

**Trouvé par le balayage §2 (motif récurrent).** Ce n'est pas le motif
d'ADR-036 — c'est son **voisin**, et il est resté invisible pour cette raison :

```text
ADR-036   l'observateur RECALCULE une échéance qu'il n'a pas fixée
ici       l'échéance est bien fixée UNE fois — mais par l'horloge du
          PROCESSUS, puis comparée à celle de LA BASE
```

`docs/23 §4` avait établi I14 : *le verdict de bail est indépendant de
l'horloge du processus*. **Elle ne valait que pour le bail.** Deux autres
tables portaient des échéances, et personne n'avait regardé.

**Mesuré, avant correction :**

| Table | TTL déclaré | Avec une dérive applicative de +1 an | Conséquence |
|---|---|---|---|
| `action_snapshots` | 7 jours | **371 jours** | rétention d'un état antérieur `ORANGE` (`docs/14`) |
| `memory_candidates` | 30 jours | **394 jours** | proposition jamais périmée |

Et en dérive **inverse**, l'instantané naissait **déjà expiré** : l'annulation
devenait silencieusement impossible — le genre de défaut qu'on ne découvre
qu'au moment où on en a besoin.

**Corrigé** (ADR-037) : `clock_timestamp() + ($n || ' days')::interval`.
**Gardé** par I19. **Contrôlé négativement** : le détecteur voit le défaut
exact et ignore `Date.now()` là où il mesure une durée.

### 2.2 « Deux machines » était classé NON TESTABLE — à tort

`docs/24` et `docs/25` l'affirmaient. C'était une **supposition**, pas une
mesure : `pg_createcluster` est disponible et la place disque ne manque pas.

Mais monter une seconde instance n'aurait **rien prouvé de plus**, et c'est le
vrai résultat. « Deux machines » se décompose :

| Différence | État |
|---|---|
| pool de connexions distinct | déjà couvert (`multiprocess.test.ts`) |
| mémoire distincte | déjà couvert |
| ordonnancement distinct | déjà couvert |
| **horloges divergentes** | **c'était la seule qui manquait** |

Fermée : quatre processus, décalés de **+1 an / −1 an / +6 mois / 0**, en
concurrence sur la même clé. `external_effect_count ≤ 1`, `attempts ≤ 1`,
aucune erreur inattendue.

> Deux ans de divergence entre les hôtes ne déplacent aucune décision de
> sûreté — parce qu'aucune n'est prise par l'horloge d'un appelant.

### 2.3 Un test d'intégrité laissait la chaîne ROMPUE pour toute la suite

**Trouvé en ajoutant un fichier de test, pas en cherchant.** Le défaut était
latent depuis toujours, masqué par l'ordre d'exécution.

`ledger-chain.test.ts` corrompt **délibérément** le journal — triggers
désactivés, ligne réécrite — pour prouver que le chaînage par hash détecte
l'altération quand les deux premières barrières tombent. C'est un bon test.
Deux de ses cas ne remettaient pourtant pas l'état :

| Cas | Ce qui restait après |
|---|---|
| modification de contenu | `status = 'FAILED'` sur un maillon — chaîne rompue |
| **suppression de maillon** | **le maillon manquant, définitivement** |

Le second se « réparait » incidemment parce que le test suivant, dans le même
fichier, remettait le statut du premier. **Une dépendance d'ordre entre deux
`it()` n'est pas un mécanisme** — c'est une coïncidence qu'on remarque le jour
où elle cesse.

Et le journal est **partagé par toute la suite** : quatre fichiers y appellent
`verifyChain()`, plus `system_status` qui le fait en production.

**Mesuré :** `intent/flow.test.ts` — « la chaîne d'audit reste intacte après
une session complète » — **vert seul, rouge en suite complète**. Ajouter
`web-search.test.ts` a suffi à déplacer l'ordonnancement et à révéler le
défaut.

> L'assertion avait raison. La tentation était de l'affaiblir — elle est la
> seule vérification d'intégrité de bout en bout du dépôt.

**Corrigé** sur les deux fronts :

- le maillon supprimé est **sauvegardé puis réinséré** (`CREATE TABLE … AS
  SELECT *`, pour ne pas énumérer des colonnes qui se périmeraient à la
  prochaine migration — ce qui est exactement arrivé aux champs d'égression) ;
  le statut altéré est restauré dans son propre `finally` ;
- la fenêtre de corruption est protégée par `withLedgerExclusive`, un verrou
  consultatif **côté tests uniquement** : on ne peut pas vérifier globalement
  l'intégrité d'un objet pendant qu'on le corrompt volontairement ailleurs.

**Sabotage :** retirer la réinsertion, puis la restauration du statut — chaque
retrait fait rougir le test concerné. Les deux sabotages reproduisent l'état
antérieur du dépôt.

### 2.4 Un scénario CRITIQUE compté couvert par collision de chaîne

**Trouvé en contestant ma propre recommandation, pas en cherchant un défaut.**

Avant d'écrire le Model Router, j'ai vérifié que « référencé » voulait dire
quelque chose. Mesure sur les trente scénarios de `docs/05` : **16 cités dans du
code**, **11 en commentaire seul**.

Première conclusion, et elle était **fausse** : les commentaires ne sont pas un
défaut. `A3`, `A5`, `A10`, `B6` sont attachés à des fichiers entièrement
consacrés à leur propriété — la citation en tête est une forme légitime.

En resserrant sur un rattachement non ambigu (`05/C2`, `**C2**`, titre de test),
**un seul scénario tombe** : `C2` — **Arrêt d'urgence**, marqué `CRITIQUE`. Le
seul « C2 » du dépôt vivait dans « matrice adversariale **ligne C2** », la ligne
d'un tout autre tableau. Aucune capacité d'arrêt d'urgence n'existait.

> Un identifiant de deux caractères est trop court pour valoir preuve.

Et le premier filtre strict était **trop strict** : il perdait `B3`, cité dans
« scénarios 05/B1, B2, B3, B10 » où seul B1 porte le préfixe. Un filtre qui
resserre trop invente des trous et fait perdre confiance dans les vrais.

**Corrigé** : reconnaissance rattachée (ADR-057), et **C2 écrit** plutôt que
déclaré bloqué — l'arrêt d'urgence ne dépend d'aucun fournisseur, donc rien ne
justifiait de le différer.

**Le chiffre publié n'a pas bougé** — 27/30 avant, 27/30 après. Sa vérité, si.

### 2.5 Quatre gardes de sécurité qu'aucun test n'éprouvait

**Trouvé en transformant une anecdote en hypothèse.** ADR-057 s'était terminée
sur un sabotage qui n'avait rien fait rougir. Plutôt que de corriger et passer,
on en a fait une question : *combien d'autres ?*

Méthode : prendre les branches non couvertes des modules de sécurité, et
**saboter chacune**. Pas viser un pourcentage — viser une réponse.

```text
ledger.ts    validation à la frontière retirée   → 89 tests verts
vault.ts     inspection rendant le secret NU     → 72 tests verts
halt.ts      levée sans note acceptée            → 16 tests verts
event.ts     empreinte sans repli                → 89 tests verts
```

`Secret[inspect.custom]` est la plus grave : c'est la garde anti-fuite de la
Phase 0, celle que Node appelle pour `console.log(secret)`. `toString()` et
`toJSON()` étaient éprouvés — la concaténation et la sérialisation. **Pas
l'affichage**, qui est le plus fréquent des trois.

Et la validation du journal contredisait ADR-016, qui en fait une obligation.

**Corrigé** : `tests/security/refus-eprouves.test.ts`, 13 tests. Chaque
sabotage rejoué fait rougir exactement le test visé.

**Restent NON testées, et déclarées :** deux gardes sur états impossibles
(`INSERT … RETURNING` sans ligne, arrêt inscrit sans identifiant). Les tester
demanderait de fabriquer un monde qui n'existe pas ; les supprimer
transformerait un refus nommé en plantage plus loin. On les garde et on dit
pourquoi (ADR-059).

### 2.6 Un test qui ne passait que 23 heures sur 24

**Trouvé par accident, pendant le balayage ci-dessus.**

`reminders.test.ts` plaçait un rappel « dans une heure » et attendait de le voir
dans le briefing. Or le briefing borne à `date_trunc('day', clock_timestamp())
+ 1 day`. **Entre 23 h et minuit UTC, « dans une heure » tombe demain.**

Le produit avait raison : un rappel de demain n'est pas dans le briefing
d'aujourd'hui. C'est le TEST qui supposait que « dans une heure » restait
aujourd'hui.

> Il aurait été classé « flaky » par quiconque l'aurait croisé une fois — et
> c'est exactement ainsi qu'un défaut d'horloge survit.

**Corrigé** par la doctrine du dépôt (ADR-036/037) : la fenêtre est calculée par
la BASE, jamais devinée par le processus. Le test demande à la base où finit la
journée et place le rappel à l'intérieur.

Vérification la plus forte possible : le correctif a été validé **à 23 h 12
UTC**, dans la fenêtre précise où le test échouait.

### 2.6-bis Le statut était juste, la phrase pouvait mentir

**Suite directe de §4.2.** Après avoir sorti le consentement du shell, même
question posée à la couche d'affichage : *que décide-t-elle d'autre ?*

```text
case 'UNKNOWN' → return "C'est fait."   → 752 tests VERTS
```

La règle 3 de `CLAUDE.md` — « jamais de succès non vérifié » — rompue au
dernier pouce, dans le fichier qu'aucun test ne référençait.

**Et la passerelle web disait autre chose que le CLI.** `ui.ts` portait sa
propre table, écrite à la main, qui connaissait **quatre statuts sur sept**.
`PARTIAL`, `NOT_ATTEMPTED` et `PROVIDER_CONTRACT_VIOLATION` tombaient sur un
repli : l'identifiant brut affiché à l'utilisateur, et le marqueur `·` — celui
de `NOT_ATTEMPTED` dans le CLI. **Le signal le plus fort du système portait le
symbole du plus bénin.**

**Corrigé** (ADR-062) : `headline()` extraite comme source unique, le web
dérive ses tables de l'**énumération**. Seize tests, six sabotages rattrapés.

### 2.6-ter L'utilisateur confirmait une valeur tronquée en silence

**Trouvé en systématisant la méthode** : plutôt que de deviner le prochain
fichier, la question a été posée à la surface entière — *quels exports de
`src/apps/` ne sont cités par aucun test ?* Neuf. Dont `confirmationPrompt`.

Deux défauts, et le second était **actif** :

| | |
|---|---|
| liste **noire** (`key !== 'tool'`) dans DEUX consommateurs | un paramètre nommé `tool` aurait écrasé la métadonnée puis disparu du tri — confirmé sans être vu. Latent |
| `.slice(0, 200)` **silencieux** | `web_search.query` accepte 256 caractères : cinquante-six disparaissaient de ce qu'on confirme. **Comportement du jour** |

**Corrigé** (ADR-063) : un module partagé, liste **blanche** par préfixe,
troncature dite **dans le texte** — un drapeau supposerait que chacun des trois
affichages pense à le lire.

Quatre sabotages ; seul le dernier, qui reproduit l'**état d'origine exact**,
fait rougir le test qui encode la trouvaille. *Un sabotage partiel donne une
conclusion partielle.*

### 2.6-quater Un test rouge une fois sur deux — et c'est l'assertion qui avait tort

**Trouvé par la porte de sortie d'ADR-074, sur un test qui n'a rien à voir
avec elle.** `tests/lab/lease-semantics.test.ts` affirmait, sur vingt reprises
simultanées d'un bail expiré :

```text
lease_generation === 4 + vainqueurs      « autant de générations que de vainqueurs »
```

Mesurée cinq fois de suite : **trois rouges, deux verts**. Le réflexe naturel —
« c'est de la concurrence, c'est flaky » — aurait enterré une **dixième
occurrence du motif de §2** : *une affirmation que le mécanisme censé l'établir
n'établit pas.*

L'entrelacement qui la casse est réel et parfaitement licite :

```text
A lit la génération 4, la PREND par compare-and-swap  → 5, bail à A
C lit 5 (A n'a pas encore statué), la PREND           → 6, bail à C
A tente d'écrire son verdict sous le bail 5           → REFUSÉ, périmé
C écrit le sien sous le bail 6                        → vainqueur
```

Deux générations, **un** vainqueur. Le système fait exactement ce qu'ADR-035
promet : `writeAuthoritative` refuse l'écriture d'un exécutant périmé. **La
mesure disait la vérité ; l'assertion se figurait qu'une prise de bail menait
toujours à un verdict.**

La loi exacte : une génération est consommée par chaque **prise réussie**, et
toute prise finit *vainqueur* ou *périmée*. Les refusés d'`OPERATION_IN_FLIGHT`
n'ont jamais pris le bail.

```text
lease_generation === 4 + vainqueurs + périmés
```

Plus **forte** que l'ancienne, pas plus permissive : elle compte les deux issues
au lieu d'en ignorer une. Sabotage : en retirant l'incrément de génération de
`claimForRecovery`, le test rend `expected 4 to be 24`. Huit exécutions
consécutives au vert après correctif.

> Un test intermittent est pire qu'un test absent : il apprend à lire le rouge
> comme du bruit. Et la fois où il dit vrai est indiscernable des autres.

---

### 2.6-quinquies Deux gardes de test qui ne gardaient rien, trouvés par sabotage

Les deux vivaient dans `tests/voice/tour.test.ts`, écrit le jour même. Ils
n'auraient jamais été trouvés en relisant — seulement en cassant exprès ce
qu'ils protègent.

**`\b` ne marche pas en français — ET LE DÉPÔT LE SAVAIT DÉJÀ.** Le détecteur
« aucun accusé de réception ne contient de participe passé d'action » employait
`/\b(fait|envoy[ée]|…)\b/`.

> ⚠ **Correction d'ADR-074, qui présentait ceci comme une découverte.** Le piège
> est documenté depuis longtemps dans `src/core/intent/engine.ts`, à la règle
> `memory_search_decision` : *« en JavaScript, `\b` se fonde sur `\w`,
> c'est-à-dire l'ASCII. "décidé" se termine par un accent […] Piège
> systématique dès qu'on écrit des règles en français. »*
>
> Je suis retombé dedans **trois fichiers plus loin**, dans le même dépôt, sur
> la même langue. Ce n'est donc pas un défaut de connaissance : c'est un défaut
> de CIRCULATION de la connaissance. Une leçon écrite dans un commentaire ne
> protège que le fichier qui la porte — seul un mécanisme voyage.
En JavaScript `\b` est défini sur l'**ASCII** : « é » n'en fait pas partie, donc
après lui il n'existe **aucune frontière de mot**, et `envoyé\b` ne peut pas
matcher « envoyé » en fin de phrase. Le garde-fou laissait passer précisément les
mots qu'il devait attraper. Remplacé par une recherche de sous-chaîne — grossière,
sans trou, sur un ensemble clos de trois phrases.

**Deux chaînes différentes, une seule phrase à l'oreille.** Le test « aucun accusé
ne partage de phrase avec la table des verdicts » comparait des chaînes exactes.
En y injectant « c'est fait », il est resté **vert** : `headline` rend
« C'est fait. » — une majuscule et un point d'écart. À l'écrit deux chaînes ; à
l'oral **la même phrase**, et la propriété défendue est justement qu'un auditeur
ne puisse pas les confondre. La comparaison se fait désormais sur ce qui
s'entend.

> Un test qui protège de l'ORAL doit comparer ce qui s'entend. Comparer ce qui
> s'écrit, c'est mesurer une autre propriété que celle qu'on annonce.

---

### 2.8 Le scanner de secrets ne lisait PAS l'arbre de travail — il l'annonçait

**Trouvé en branchant Google (ADR-078), sur l'outil censé garder ce branchement.**

Le scan annonçait, à chaque exécution :

```text
✓ Aucun secret détecté (arbre de travail et historique).
```

Il lisait `git show HEAD:<fichier>` — c'est-à-dire le **dernier commit** — et
sautait en silence tout fichier pas encore commité (`catch { continue }`).
**L'arbre de travail n'a jamais été lu.**

Mesuré par sabotage : un jeton de rafraîchissement Google déposé dans `src/`,
puis `git add`, puis `pnpm secrets:scan` → *« aucun secret détecté »*. Deux fois,
non suivi puis suivi.

**La conséquence est exactement là où l'on se sert de cet outil : AVANT de
commiter.** En CI le code est déjà commité, donc la garde y fonctionne — c'est
précisément ce qui la rendait invisible. En local, celui qui vérifie avant
d'engager son travail obtenait un feu vert sur du rouge.

Correctif : lecture depuis le disque. Le repli sur l'historique demeure pour les
fichiers supprimés.

### 2.8-bis Le même commit ouvrait une porte que le scanner ne voyait pas

`Clé Google` couvrait `AIza…` — une clé d'API. L'adaptateur introduit trois
secrets d'un genre **différent** :

```text
GOCSPX-…   secret client, PERMANENT
1//…       jeton de rafraîchissement, PERMANENT
ya29.…     jeton d'accès, éphémère mais suffisant pour tout lire
```

Aucun motif ne les reconnaissait. Les deux premiers ne s'éteignent pas d'eux-mêmes.

> Brancher un service sans étendre le scanner, c'est ajouter une porte et ne pas
> déplacer la caméra.

Trois motifs ajoutés, avec contrôle négatif : `https://1//example`,
`GOCSPX-court` et `ya29 est un identifiant` ne doivent PAS mordre — un motif
trop large se paie en bruit, et le bruit se paie en exceptions, c'est-à-dire en
trous.

---

### 2.7 Deux fichiers à 0 % de couverture — faux positif

`src/core/policy/evaluator.ts` et `src/providers/contract.ts` : **types purs**,
zéro code émis. Vérifié, pas supposé.

---

### 2.11 Une justification de silence qui nommait un mécanisme inexistant

**Trouvé en préparant l'installation d'un modèle chez l'utilisateur.**

`runtime.ts` justifiait le silence du démarrage : *« pas invisible :
`system_status` interroge la santé des fournisseurs, et `createOllama` explique
pourquoi il a refusé »*. **Les deux moitiés étaient fausses** — trois contrôles,
aucun sur un fournisseur ; et la raison du refus jetée par `return null`.

Écrite dans ADR-082, la veille. **Treizième occurrence du motif**, et la pire
place possible : le commentaire décrivait si bien le mécanisme que personne
n'est allé vérifier qu'il existait.

**Conséquence, imminente et concrète** : un Ollama éteint, un nom de modèle mal
tapé, une URL erronée produisaient exactement le comportement d'une absence de
modèle. Jarvis comprend moins bien, `/diagnostic` dit « tout va bien », et
l'utilisateur conclut que le modèle n'apporte rien.

**Corrigé** (ADR-086) : trois états déclarés au lieu d'un `null`
(`DESACTIVE` / `REFUSE` avec sa raison / `CONFIGURE`), un quatrième contrôle
dans `system_status` qui **sonde** au lieu de mémoriser, et la ligne manquante
dans `/diagnostic`.

**Et le banc mesurait sans modèle** — `buildRuntime(appDb())` laisse
`localModel` indéfini. §2.10 une seconde fois, sur l'autre moitié de la
configuration. Il déclare désormais ce avec quoi il a mesuré, et **refuse de
produire un chiffre** si un modèle demandé ne répond pas.

**Sabotages** : 6 rouges / 1 rouge / et la reproduction exacte du scénario
utilisateur, où la garde a produit le message qui dit quoi faire.

> **La leçon n'est pas « relire ses commentaires ».** C'est :
> **une justification de silence est une dette de preuve.** Écrire « c'est
> silencieux ici parce que c'est visible ailleurs » oblige à ce qu'*ailleurs*
> soit un test, jamais une phrase.

---

### 2.10 Le banc mesurait `REFERENCE 0/8` sans jamais ouvrir de session

**Trouvé en cherchant pourquoi ADR-084 ne pouvait pas faire bouger le chiffre.**

`REFERENCE 0/8` est cité par quatre ADR et par §4.13. Le banc qui le produit
appelait `assistant.say(phrase)` **sans `sessionId`** — alors que le CLI et la
passerelle web en passent un. Sans session, l'Assistant répond à tout référent
« je n'ai pas de conversation en cours », avant même de chercher.

**Et le banc expliquait son résultat par une phrase périmée** : *« l'Assistant
est SANS ÉTAT entre deux phrases »*. Vraie à l'écriture, **fausse depuis
ADR-073**. Elle a cessé de l'être sans que le chiffre bouge — un commentaire ne
casse aucun test.

**Corrigé** (ADR-085) : session ouverte, tours enregistrés comme dans le CLI.

**Re-mesuré — et le chiffre n'a pas bougé d'une unité.** 13/30, `REFERENCE`
0/8.

> C'est le résultat, pas un non-événement. Le 0/8 était **surdéterminé** : deux
> causes suffisantes agissaient ensemble. On sait maintenant qu'il mesure le
> produit et non le banc — ce que tout le monde supposait sans l'avoir montré.

**Et la cause réelle est plus en amont qu'écrit en §4.13** : les huit tours
ressortent `UNSUPPORTED`. Aucune règle ne reconnaît la formulation, donc aucun
référent n'est PRODUIT. Ce n'est pas la reconnaissance d'ENTITÉS qui manque en
premier — c'est la reconnaissance de l'ÉNONCÉ.

**Gardé** par un test de configuration, et c'est le point : corriger le banc
n'ayant rien changé au chiffre, **aucun test existant ne pouvait voir la
différence**. On garde donc la configuration, pas le résultat. Sabotage → 1
rouge.

> **Douzième occurrence du motif, et la plus retorse.** L'affirmation n'était
> pas fausse — elle était juste pour une raison qui avait cessé d'exister. Un
> chiffre juste peut reposer sur une explication morte, et le chiffre ne le dira
> jamais, puisqu'il ne change pas.

---

### 2.9 Le paquet de contexte filtrait UN canal sur TROIS — et la porte le certifiait

**Trouvé en relisant `packet.ts` pour un autre chantier** (ADR-083). Pas par un
balayage : par la question « combien de canaux entrent, combien sont filtrés ? »

`buildContextPacket` compose ce qui part vers un modèle. Son en-tête annonce
« 1. filtrage de confidentialité ← sécurité d'abord », et l'étape existe.

```text
memories   filtrées par privacyClass       ← la seule protégée
entities   passaient telles quelles
turns      passaient tels quels
```

**Et la cause n'est pas une décision.** Les colonnes existent en base :

| Table | Colonne | Depuis |
|---|---|---|
| `entities` | `privacy_class`, `RED` admis | migration 0001 |
| `session_turns` | `provenance`, `EXTERNAL_UNTRUSTED` admis | migration 0003 |

Les **lecteurs** les jetaient — `EntityRef` et `ConversationTurn` ne les
portaient pas, leurs `SELECT` ne les demandaient pas.

> Un filtre ne peut pas trier sur ce qu'on ne lui donne pas. Il rend « rien à
> écarter », ce qui se lit exactement comme un succès.

**La moitié la plus coûteuse : `G1.4` certifiait la propriété.** Son libellé
dit *« une donnée RED n'entre jamais dans un paquet destiné au cloud »*. Elle
appelait le module avec `entities: []` et `turns: []` — elle n'a jamais rien
mis dans les deux canaux non protégés.

**Onzième occurrence du motif** — *une affirmation que le mécanisme censé
l'établir n'établit pas* — et la **troisième dans de l'outillage de sécurité**,
après le scanner de secrets (§2.8) et la garde de frontières de mot.

**Corrigé** (ADR-083) : les lecteurs rendent les colonnes ; la lecture échoue
**fermé** (`provenanceLue` → `EXTERNAL_UNTRUSTED`, `privacyClassLue` → `RED`)
plutôt qu'un `as` sur une frontière ; les entités se filtrent par classe, les
tours par **provenance** — un tour non fiable n'est pas *sensible*, il est
*hostile*, donc écarté **même vers un modèle local**.

**Gardé** par 14 tests, dont l'aller-retour réel en base — un double en mémoire
aurait rendu la provenance qu'on lui aurait demandée, et c'est précisément le
contrat TypeScript qui était satisfait pendant que le SQL ne l'était pas.

**Sabotages** : 3 / 3 / 2 / 1 rouges. Et la porte elle-même éprouvée contre le
défaut qu'elle avait laissé passer → `G1.4 … ÉCHEC`.

> **Ce qui borne la portée, et qu'il faut dire :** `packet.ts` n'a aucun
> appelant de production (§4.1). Le défaut était **latent**, rien n'a fuité.
> Mais la garantie était fausse *maintenant*, et l'aurait été encore le jour du
> branchement, sans que rien ne le signale.

---

## 3. Ce que le balayage a trouvé sur MOI, et pas sur le code

Honnêteté sur la méthode, parce qu'elle change la conclusion.

J'ai construit un invariant `I20 — aucun module orphelin`, l'ai branché, et il
a signalé `quarantine/processor.ts` et `observability/logger.ts`.

**Le dépôt le savait déjà.** `tests/redteam/wiring.test.ts` fait une analyse
d'**atteignabilité transitive depuis les points d'entrée** — strictement plus
forte qu'un contrôle d'importation — et maintient un inventaire **figé et
justifié** de **cinq** modules orphelins. Le mien n'en voyait que deux.

I20 a été **retiré**. La leçon vaut d'être écrite :

> Une zone d'ombre *pour moi* n'est pas une zone d'ombre *pour le dépôt*.
> Avant d'ajouter une garde, vérifier qu'il n'en existe pas déjà une — sinon
> on ajoute une garantie plus faible qui donne l'illusion d'en ajouter une.

---

## 4. DIFFÉRÉES — levables, non levées, avec leur condition

### 4.1 Trois modules de logique hors circuit

Inventoriés et figés par `wiring.test.ts`. Ils sont **implémentés et testés,
jamais atteints par le produit**.

| Module | Ce qui manque | Condition de réouverture |
|---|---|---|
| ~~`quarantine/processor.ts`~~ | **LEVÉE (ADR-055)** — `web_search` est la première ingestion du dépôt, et le Tool Gateway appelle `sealExternal` | — |
| ~~`context/resolver.ts`~~ | **LEVÉE (ADR-073)** — l'Assistant résout les référents avant d'invoquer un outil, et DEMANDE dès que la lecture est ambiguë | — |
| `context/packet.ts` | l'assemblage du paquet de contexte n'a aucun appelant — résoudre une référence et composer un contexte sont deux choses, et une seule est faite | un consommateur du paquet |
| `observability/logger.ts` | aucun appelant | exigences de log de `03 §9` non satisfaites |
| `cost/gate.ts` | aucun fournisseur cloud à facturer | dès le premier fournisseur payant branché |
| ~~`intent/tier1.ts`~~ | **LEVÉE (ADR-082)** — `createOllama` implémente `ModelProvider` sur la boucle locale ; le `Tier 1` se construit dès que la configuration l'active | — |
| ~~`tools/outcome.ts`~~ | **LEVÉE (ADR-065)** — `memory_forget` projette son statut sur la ligne mémoire ET chaque dérivé hors cascade ; une mémoire vit à plusieurs endroits, donc l'oubli est multi-cibles | — |

**Ce compteur a une histoire, et elle vaut d'être lue :**

```text
5   état initial
6   + cost/gate.ts (ADR-040) — écrit avant d'avoir un appelant, délibérément
7   + privacy/classify.ts (F1) — classification branchée à rien, délibérément
6   − privacy/classify.ts (F2) — le Policy Gate l'appelle
5   − quarantine/processor.ts (ADR-055) — web_search ingère, le Gateway scelle
4   − tools/outcome.ts (ADR-065) — memory_forget projette sur plusieurs cibles
3   − context/resolver.ts (ADR-073) — l'Assistant résout « ça » avant d'agir
4   + intent/tier1.ts (ADR-081) — l'enveloppe de sûreté écrite AVANT le modèle
3   − intent/tier1.ts (ADR-082) — createOllama existe, le Tier 1 se construit
```

> **La dernière ligne monte, et c'est assumé.** Ce compteur n'est pas une note
> à minimiser : il mesure l'écart entre ce qui est écrit et ce qui sert. Le
> `Tier 1` y entre pour la même raison délibérée que le CostGate — l'enveloppe
> de sûreté s'écrit **à froid**, avant la capacité qu'elle encadre. Clouer
> `userConfirms` à `false` et marquer chaque paramètre `MODEL_OUTPUT` est
> beaucoup plus facile maintenant qu'après, quand un modèle tournera enfin et
> qu'on aura hâte de le voir répondre.
>
> Le faire baisser en branchant un modèle qui n'existe pas serait le tricher.
>
> **Il est redescendu à l'ADR suivante, pour la raison annoncée.** Un
> aller-retour d'une seule étape : c'est ce qu'on attend d'une dette DATÉE, par
> opposition à celle qu'on découvre.

> **Le titre a dit « Cinq » pendant toute la période où il valait six.**
> `wiring.test.ts` l'affirmait pourtant (`toHaveLength(6)`) ; ce document non.
> Le test avait raison contre le registre — c'est l'ordre qu'on veut, mais
> l'écart aurait dû être rattrapé le jour même. Il est revenu à cinq pour une
> raison entièrement différente de celle qui l'y avait mis, puis à **quatre**
> quand le droit à l'oubli a donné au modèle d'effet par cible le premier
> appelant qu'il attendait depuis Foundation 4.

**Conséquence à énoncer sans détour :** `PARTIAL` est spécifié (`docs/19`),
implémenté et testé — et **aucune opération réelle ne peut aujourd'hui le
produire**.

La deuxième moitié de cette phrase disait : « La séparation
Privileged/Quarantined (ADR-004), défense principale contre T1, est hors circuit
faute d'ingestion externe. » **Ce n'est plus vrai depuis ADR-055.** Elle est
appelée par le Tool Gateway sur toute sortie déclarée `EXTERNAL_UNTRUSTED`, et
`web_search` en produit. Ce qui reste vrai : **un seul outil l'emprunte**, et
la protection ne vaut donc que pour ce qu'il rapporte.

Ce n'est pas un défaut : c'est une capacité **déclarée non disponible**. Elle
serait un défaut le jour où quelqu'un croirait qu'elle protège.

### 4.2 Le CLI n'est exercé par aucun test — et il portait une décision de SÛRETÉ

`src/apps/cli/main.ts` — **0 % de couverture, 240 lignes**. C'est la surface
produit réelle. Aucun test ne la traverse.

> ⚠ **CE PARAGRAPHE SE RASSURAIT À TORT, ET LA CORRECTION EST LA SIXIÈME DE
> CETTE FAMILLE.** Il disait : « le CLI n'exécute aucune action en propre […]
> le risque porte sur l'**ergonomie et le rendu**, pas sur la sûreté. »

**Faux.** Le CLI lisait le consentement de l'utilisateur sur une action `L3` /
`L4` — deux prédicats et une chaîne de `if` au milieu du rendu. C'est la
DERNIÈRE décision de la chaîne, et la seule qu'aucun Policy Gate ne rattrape :
le Gate a déjà rendu son verdict, il a dit « demande à l'humain ».

Mesuré :

```text
isNegative → return false     → 744 tests verts
ancrage ^…$ retiré            → « oui mais non » lu comme un OUI
```

Le premier est bénin — le défaut fermé rattrape. **Le second exécute une action
`L4` que personne n'a confirmée.**

**Corrigé** (ADR-061) : la décision est sortie du shell. `readConfirmation`
rend `CONFIRM` / `REFUSE` / `UNCLEAR` — trois issues parce que `PRD §135` dit
que *le doute n'est pas une confirmation*, et qu'un booléen forcerait à ranger
« peut-être » d'un côté. Huit tests, deux sabotages qui rougissent.

**Puis le RENDU, attrapé par le balayage lui-même.** ADR-063 a corrigé le
*pipeline* de ce qui est confirmé — préfixe de transport, liste blanche,
troncature qui se dit. `confirmationPrompt`, qui met ces valeurs à l'écran, est
resté sans test : le balayage « quels exports de `src/apps/` ne sont cités par
aucun test ? » l'a redonné mot pour mot au tour suivant.

C'est le seul résultat de ce registre où la méthode a trouvé **sa propre
application incomplète**, et c'est ce qui la distingue d'une relecture : une
relecture ne trouve que ce qu'on avait déjà vu. Cinq tests couvrent désormais
l'invite ; trois sabotages la font rougir de trois façons distinctes —
valeurs masquées, question muette sur ce qu'elle attend, invite vide.

**Ce qui reste vrai :** la BOUCLE du CLI — affichage, lecture d'entrée,
commandes — n'est toujours traversée par aucun test. Mais ce n'est plus « de
l'ergonomie » par défaut : c'est ce qui reste **après** avoir sorti la seule
décision de sûreté qui s'y trouvait, et après avoir éprouvé l'écran sur lequel
elle se joue.

**Condition :** à couvrir avant toute promesse de disponibilité produit.

### 4.2 bis L'audit du jour était incomplet — et j'avais écrit qu'il ne l'était pas

> ⚠ **CETTE ENTRÉE CORRIGE UNE AFFIRMATION DE CE REGISTRE, ÉCRITE PAR MOI.**
> À l'itération précédente, j'ai conclu le balayage « quels exports de
> `src/apps/` ne sont cités par aucun test ? » ainsi : *« les huit restants ne
> portent aucune décision de sûreté — des constantes, du balisage statique. »*
>
> À la question suivante, j'ai **relancé le balayage** plutôt que de citer ma
> propre conclusion. `src/apps/reports.ts` est apparu, avec trois exports que
> la première passe n'avait pas listés. L'affirmation était fausse.

**Une conclusion qu'on recopie est une mesure qui a cessé d'en être une.** C'est
la septième occurrence de la famille recensée en §2 — un chiffre ou une
affirmation en prose que plus rien ne relie au réel — et la première dont
l'auteur soit le registre lui-même.

`auditReport` répond à « qu'as-tu fait aujourd'hui ? » (`docs/05 §A9`). Il
lisait `recent(200)` puis filtrait sur `new Date().toISOString().slice(0, 10)` :

| Défaut | Conséquence |
|---|---|
| Borne du jour calculée par le **processus** | ADR-036/037 disent l'inverse : une horloge qui dérive montre le mauvais jour |
| Plafond **silencieux** à 200 événements | au-delà, la réponse en omettait **sans le dire** |

Le second est le plus grave, et pas pour la donnée perdue : un audit est la
contrepartie de l'autonomie. **Un audit incomplet qui se présente comme complet
ne coûte pas une information — il rassure.**

**Et il existait déjà une bonne réponse.** L'outil `audit_query` borne par
`date_trunc('day', clock_timestamp())` depuis son écriture. Deux registres du
même fait (ADR-041), avec une aggravation que la formule n'avait pas prévue :
le registre JUSTE était celui que personne n'affichait, le registre FAUX était
la surface produit. *Un doublon n'est pas symétrique : celui qu'on voit gagne,
quel que soit celui qui a raison.*

**Corrigé** (ADR-064) : `Ledger.dayTally()` agrège en SQL — borne, regroupement
et total. La troncature n'est pas signalée, elle est rendue **impossible**.
Quatre tests, trois sabotages qui rougissent chacun un test distinct.

**Ce que le dépôt m'a appris en écrivant le test :** la première version
antidatait un événement avec le rôle applicatif. L'`UPDATE` a été **refusé** —
la barrière d'immuabilité du journal a fait son travail sur mon propre test.

**Et les deux voisins portaient la même famille.** Cette fois je les ai
regardés plutôt que de les déclarer inoffensifs :

| | Défaut | Gravité |
|---|---|---|
| `diagnosticReport` | `pending(1000).length` — un **compte** plafonné à mille | un compte ne se plafonne jamais |
| `inboxReport` | vingt candidats affichés sur N, sans dire N | tronquer une **liste** est légitime ; ne pas le dire ne l'est pas |

`MemoryInbox.pendingCount()` compte en SQL, avec **le prédicat de `pending`
mot pour mot** — deux définitions de « en attente » finiraient par diverger, et
la liste montrerait alors des candidats que le compte ignore.

Le reste va **jusqu'à l'œil** : CLI et passerelle web disent tous deux
« … et N autre(s) ». C'est la leçon d'ADR-063, où le pipeline avait été réparé
et l'affichage oublié.

### 4.2 ter Ce que le balayage « export non cité » ne dit PAS

Le balayage qui a trouvé §4.2 bis mesure **« ce nom apparaît-il dans un
test ? »**. C'est un bon *chercheur* et un mauvais *verdict*, et il faut le dire
avant que quelqu'un lise sa liste comme un inventaire de lacunes.

Étendu à `src/core` et `src/tools`, il rend une cinquantaine de noms. La
plupart sont du bruit : un outil est éprouvé par son `id` (`web_search`), jamais
par le nom de sa constante ; un schéma Zod est consommé par inférence.

**Éprouvé plutôt que supposé.** `leavesMachine` — prédicat du Data Firewall,
appelé par `briefing.ts` et `calendar.ts`, cité par aucun test — a été saboté
(`return false` : plus rien ne sort jamais de la machine) :

```text
3 tests rouges, dans 2 fichiers
  « une sortie REFUSÉE ne compte pas comme une sortie »
  « un fournisseur LOCAL ne déclare AUCUNE égression »
  « §6.4 — un agenda CLOUD est refusé, MÊME cloud activé »
```

Il est donc **couvert par ses appelants**, sans porter son nom nulle part.

> Un export non nommé par un test n'est pas un export non éprouvé. La
> différence se tranche par sabotage, pas par lecture de la liste.

Ce qui reste vraiment sans filet, après cette distinction : les **orphelins
déclarés** (§4.1) — du code qu'aucun appelant de production n'atteint. Non
testés *et* non appelés, ils ne sont pas une lacune de couverture mais une
question d'existence.

### 4.2 quater M'auditer moi-même : trois gardes qui ne gardaient rien

**HUITIÈME occurrence de la famille de §2, et la plus instructive : les trois
défauts sont de moi, écrits trois commits plus tôt.**

Plutôt que d'ajouter le cinquième outil inverse, j'ai appliqué à
`memory_forget`, à l'Undo Engine et aux trois outils inverses le traitement
adverse réservé jusque-là au code ancien. Dans cette session, c'est la mesure
qui a trouvé — jamais la relecture ; il n'y avait aucune raison que mon propre
code fasse exception.

| Garde | Sabotage | Ce qui rougissait |
|---|---|---|
| `erased()` porte `POSITIVE_ABSENCE` | rendre `POSITIVE_PRESENCE` | **rien — 818 tests verts** |
| `previewLast()` n'exécute rien | y faire marquer la capture | **rien — seul un grep sur le texte du CLI le « citait »** |
| `hasAnyEffect` empêche de brûler une capture | rendre `true` | **rien — 37 tests d'annulation verts** |

**Les trois portaient un commentaire qui décrivait correctement la protection.
Dans les trois cas, la protection n'existait pas.**

> Une garde qu'aucun sabotage ne fait rougir n'est pas une garde : c'est un
> commentaire avec une syntaxe exécutable.

**Et le troisième en cachait un quatrième.** En cherchant pourquoi rien ne
rougissait, il est apparu que `hasAnyEffect` seul **bloquait `undoLast`** : une
annulation sans objet rend `NOT_ATTEMPTED`, la capture n'était jamais marquée,
et `lastUndoable` l'aurait resservie indéfiniment. D'où `captureConsommee` et
trois cas au lieu de deux (ADR-068).

### 4.2 quinquies La surface PARLÉE — 6 outils sur 22, et personne ne comptait

**Trouvé en répondant à une question de Julien** : *« sommes-nous proches d'un
ChatGPT vocal ? »* La réponse demandait un chiffre que **rien dans le dépôt ne
produisait**.

`docs/28` compte les outils **écrits** : 22, tous éprouvés, tous conformes. Mais
un outil qu'aucune phrase ne déclenche n'existe pas pour l'utilisateur. Le
comptage manquant :

```text
ÉCRITS                      22
ATTEIGNABLES PAR UNE PHRASE  6     memory_add, memory_search, note_create,
                                   task_create, task_list, entity_create
```

**Seize outils sur vingt-deux sont hors d'atteinte de la parole.** Le calendrier,
la recherche web, le briefing, la recherche de fichiers, la complétion de tâche :
écrits, testés, invisibles. Cinq autres ne s'atteignent que par une commande
`/slash`, ce qui n'est pas de la parole.

**Comment le chiffre est prouvé**, et pourquoi il n'est pas « un grep de plus »
(cf. §4.2 ter) — la dissymétrie est assumée :

| | Moyen | Pourquoi il est valide |
|---|---|---|
| **Inatteignable** | absence du `toolId` dans la source du moteur | le moteur ne peut émettre qu'un littéral qu'il nomme — ni concaténation ni table indirecte. Une **impossibilité**, pas une présomption |
| **Atteignable** | une PHRASE qui le produit | figurer dans la source ne suffit pas : une règle peut être masquée par une autre placée avant |

Un seul des deux moyens aurait menti.

**Le cas le plus instructif : « rappelle-moi » ne crée pas un rappel.**
`reminder_create` existe et dit honnêtement que rien ne sonne (ADR-048). Mais la
seule phrase française qui devrait l'atteindre est capturée par la règle des
TÂCHES, placée avant. L'utilisateur obtient une tâche là où il demandait un
rappel — **une action différente de celle demandée**, exactement le motif qui
avait justifié de restreindre `memory_search`.

**Ce que cela change sur la comparaison avec un assistant généraliste.**
L'écart n'est PAS l'audio, et c'était l'intuition à corriger : c'est la
**compréhension**. Un ChatGPT vocal atteint 100 % de ses capacités par la parole
parce qu'un modèle fait la traduction. Jarvis en atteint 27 %, parce que
`Tier 0` est une liste de règles écrites à la main.

> Une capacité qu'aucune phrase ne déclenche est une capacité que le dépôt
> possède et que l'utilisateur n'a pas.

**PARTIELLEMENT LEVÉE DANS LE MÊME COMMIT — ADR-075.** Quatre règles ont été
écrites, et la surface parlée passe de **6 à 10 sur 22**. Le comptage a surtout
révélé un défaut plus grave que l'absence, traité ci-dessous.

Les douze restants ne sont plus « sans chemin utilisateur » — ils sont hors
d'atteinte pour des raisons NOMMÉES, dont aucune ne se règle en écrivant une
règle de plus :

```text
un IDENTIFIANT qu'une phrase ne porte pas    7 outils
une DATE qu'un Tier 0 ne sait pas résoudre   3 outils
hors surface conversationnelle               2 outils
```

Les dates sont bloquées par un **invariant**, pas par de la paresse : une règle
qui calculerait « demain » en JavaScript violerait ADR-036/037.

**Ce qui reste ouvert** : un `Tier 1` local, seul capable de traduire une phrase
libre en appel d'outil. C'est le chantier qu'ADR-017 chiffre.

Mesuré par `tests/intent/surface-parlee.test.ts`, dont la liste est **figée** :
elle bouge dès qu'une règle est ajoutée.

---

### 4.2 septies Le `\b` accentué mord pour la QUATRIÈME fois — le motif est ailleurs

En JavaScript, `\b` se fonde sur `\w`, c'est-à-dire l'ASCII. Aucune frontière de
mot n'existe donc au contact d'un caractère accentué, et `\bà` ou `envoyé\b` ne
matchent jamais.

**Le dépôt le sait depuis longtemps** : la règle `memory_search_decision` le
documente en toutes lettres — *« piège systématique dès qu'on écrit des règles
en français »*.

```text
ADR-074   détecteur de participes passés     `envoyé\b`   → laissait tout passer
ADR-075   (correction : ce n'était pas neuf, c'était déjà écrit)
ADR-077   extraction de l'heure              `\b[àa]`      → « à » restait
```

Trois occurrences, dans trois fichiers, sur trois mois. La quatrième si l'on
compte celle d'origine. **Ce n'est pas un défaut de connaissance, c'est un défaut
de circulation** — et le remède écrit à chaque fois (un commentaire de plus)
est exactement celui qui ne marche pas.

> Une leçon écrite dans un commentaire ne protège que le fichier qui la porte.
> Seul un mécanisme voyage.

**Condition de fermeture** : une règle de lint interdisant `\b` dans les motifs
d'un fichier qui contient des lettres accentuées, ou un utilitaire de frontière
de mot conscient de l'Unicode que les motifs français devraient employer. Tant
que le remède reste de la prose, la cinquième occurrence est certaine.

---

> ### ✅ FERMÉE — ADR-079, et la cinquième occurrence était DÉJÀ LÀ
>
> La prédiction ci-dessus était juste, et elle l'était au passé : la cinquième
> occurrence existait déjà quand ces lignes ont été écrites, dans
> `TEMPORAL_QUALIFIER`. **Défaut vivant :**
>
> ```text
> « rappelle-moi à 14h d'appeler Paul »
>   →  une TÂCHE intitulée « à 14h d'appeler Paul », sans échéance, « c'est fait »
> ```
>
> Mot pour mot le défaut HIGH-5 que cette garde avait été écrite pour fermer.
> Elle ne partait pas, parce que `\b[àa]` ne matche jamais « à ».
>
> `tests/architecture/frontieres-de-mot.test.ts` est le mécanisme annoncé. Il a
> trouvé **neuf** occurrences, dont une seconde que je n'avais pas vue :
> `/\b(allume|[ée]teins|…)\b/` ne reconnaissait pas « éteins ».
>
> Sept des neuf « marchaient » par accident — leurs branches finissent en ASCII.
> Toutes réécrites avec des frontières Unicode : elles marchent désormais pour de
> vrai, là où elles marchaient par endroits.
>
> **Limite déclarée** : le détecteur ne voit que les littéraux. Une regex
> construite par `new RegExp(\`…\`)` lui échappe — il y en a dans
> `expression.ts`, sûres parce qu'appliquées à du texte désaccentué, mais rien
> ne le vérifie.

---

### 4.2 nonies M'auditer trouve ce que relire ne trouve pas — quatre défauts

**Demandé par Julien : *« challenge-toi »*.** Un audit adversarial de mes propres
ADR-074 à ADR-078, écrites vite, a rendu quatre défauts — deux vivants.

| | Défaut | Comment il a été trouvé |
|---|---|---|
| 1 | `idEvenement` non injectif : toute entrée dégénérée → `'jarvis'` | en **essayant** des entrées dégénérées |
| 2 | minutes capturées puis jetées : « 8h30 » → 8 h 00 | en **essayant** une heure avec minutes |
| 3 | heure illisible avalée : « 8h75 » → 9 h 00, titre « 8h75 » | en **corrigeant** le n° 2 |
| 4 | HIGH-5 revenu, garde inerte : « à 14h » → tâche sans échéance | en **suivant** le n° 3 jusqu'au bout |

Aucun n'aurait été trouvé en relisant. Le premier demande d'essayer des entrées
qu'on n'écrit pas spontanément ; le deuxième est une **capture inutilisée**, qui
ne saute pas aux yeux ; les deux derniers ne se voient qu'en tirant sur le fil du
précédent.

> Un défaut n'est pas caché parce qu'il est subtil. Il est caché parce que rien
> ne le REGARDE. Aucun test ne portait de minutes ; le champ existait.

---



---

### 4.2 octies Un sabotage « non détecté » qui n'avait jamais été appliqué

En éprouvant ADR-077, un sabotage a semblé passer inaperçu. J'ai commencé à
écrire que le test était faible, avec une explication plausible — l'heure de la
journée.

**Vérification : la substitution n'avait jamais été appliquée.** Le motif ne
correspondait pas au texte réel, et le fichier était intact. Le sabotage
« passait » parce qu'il n'existait pas.

L'explication était bonne — le test comparait bien des instants et n'aurait rien
vu passé 9 h — mais elle était **supposée, pas mesurée**, et elle aurait pu être
fausse.

> Un sabotage qui « passe » est d'abord un sabotage à vérifier, pas un test à
> accuser. Vérifier que la modification a bien eu lieu coûte une ligne ;
> conclure sans le faire coûte une croyance.

---

### 4.2 sexies Jarvis NIAIT quatre capacités qu'il possédait — **LEVÉE** (ADR-075)

Trouvé en construisant le comptage ci-dessus, et plus grave que lui.

Le moteur répondait *« cette capacité n'est pas encore construite »* pour
`web_search` (ADR-055), `file_search` (ADR-046), les trois outils d'agenda
(ADR-043/044/045) et `note_delete` / `memory_forget` (ADR-065/067).

**Aucun effet n'était annoncé à tort.** `S15` restait donc intact — et c'est
exactement pourquoi rien ne l'a vu pendant vingt commits. Le coût est le même :

> Une capacité niée est aussi absente qu'une capacité manquante : l'utilisateur
> cesse de la demander.

**La cause** est celle d'ADR-041, transposée des données aux capacités : la
liste « ce que je sais faire » vivait à **six endroits**, et les six avaient
divergé. Les cinq messages en dérivent désormais ; chaque règle porte sa
formulation canonique.

**Ce qui rend la levée durable** : chaque capacité déclarée absente nomme
maintenant l'outil qui la servirait, et un test exige que cet outil n'existe
pas. Le jour où quelqu'un l'écrit, la CI rougit.

> La prose ne rougit jamais. Une déclaration nommée, si.

---

### 4.3 Couverture globale — 83,89 % des lignes

> ⚠ **MESURE DATÉE, ET C'EST UN CHOIX ASSUMÉ.** Contrairement aux autres
> chiffres du dépôt, celui-ci ne peut pas être lié mécaniquement (ADR-058) :
> le vérifier exige d'exécuter la suite entière sous instrumentation, ce
> qu'aucun test ne peut faire sur lui-même. Il est donc traité comme les
> rapports `docs/09` et `docs/11` — **un constat à une date**, à remesurer par
> `pnpm test:coverage`, jamais à recopier.
>
> Relevé après ADR-057 (arrêt d'urgence). Le précédent disait 83,28 %, celui
> d'avant 80,97 %.

| | Taux | Fraction |
|---|---|---|
| Lignes · instructions | **83,89 %** | 5397 / 6433 |
| Branches | **79,11 %** | 1034 / 1307 |
| Fonctions | **91,54 %** | 249 / 272 |

Zones sous 80 %, hors points d'entrée :

| Fichier | Lignes | Ce que ça signifie |
|---|---|---|
| `providers/contract.ts` · `policy/evaluator.ts` | 0 % | **types purs** — il n'y a rien à exécuter (§2.7) |
| `tools/outcome.ts` | 55 % | orphelin déclaré (§4.1) |
| `tools/identity.ts` | 65 % | `sameOperation` / `isSameOperation` jamais appelés en production |
| `apps/runtime.ts` | 62 % | assemblage ; le CLI et la passerelle ne sont pas traversés (§4.2) |
| `tools/files.ts` | 74 % | chemins de refus de `readWithinRoot` |
| `config/load.ts` | 75 % | chemins d'erreur de configuration |
| `providers/policy/cedar.ts` | 75 % | chemins d'échec du chargeur |
| `tools/reminders.ts` | 77 % | branches d'échéance non exercées |

**Le taux de BRANCHES reste le seul qui mérite de l'inquiétude** : 79,11 %
contre 91,54 % de fonctions. L'écart dit ce qu'on attend de lui — les fonctions
sont appelées, mais leurs **chemins de refus** le sont moins que leurs chemins
nominaux. Or dans ce dépôt, le chemin de refus *est* la fonctionnalité.

`safety/halt.ts` en est l'illustration fraîche : 92,77 % de lignes mais
**70,37 % de branches**. Un sabotage y a d'ailleurs montré qu'un chemin d'erreur
non couvert n'était pas seulement non mesuré — il était **non éprouvé**
(ADR-057).

### 4.4 Couches 04 à 08 du banc — non construites

`docs/22 §6` en définit huit. État réel :

| Couche | État |
|---|---|
| 01 Clock | **faite** (`docs/23`) |
| 02 Lease | **faite** (`docs/25`) |
| 03 Fencing | **faite** (`docs/24`) |
| 04 Request lifecycle | **non construite** |
| 05 Provider reality — les deux mondes | **non construite** |
| 06 Observation | partielle |
| 07 Verdict | partielle |
| 08 Recovery | couverte par les crash tests |

`lab_provider_requests` — le second monde — n'existe pas. `docs/22 §14`
l'ordonne en position 2 avec la mention *« sans lui, rien d'autre n'est
démontrable »*. **C'est la plus grande zone d'ombre différée du dépôt**, et
elle bloque : fournisseur byzantin, `PROVIDER_CONTRACT_VIOLATION`, chaîne de
provenance `intentId → effectId`, invariants I11 à I13.

> **LEVÉE — voir `docs/27`.** Le second monde existe, les couches 04-05 sont
> faites, `PROVIDER_CONTRACT_VIOLATION` et I11 aussi. Ce paragraphe reste
> écrit tel qu'il l'était : un registre qu'on réécrit cesse d'être un registre.
> Ce qui a pris sa place — **I12** (aucune action nouvelle après violation) et
> **I13** (chaîne de provenance complète) — est nommé en `docs/27 §8`.

### 4.5 ~~`egress` est un booléen là où il y a DEUX questions~~ — **LEVÉE**

> **LEVÉE à l'étape F2 du Data Firewall — ADR-051.** Le paragraphe reste écrit
> tel qu'il l'était : un registre qu'on réécrit cesse d'être un registre.
>
> `networkRequired` est désormais **dérivé du fournisseur branché**
> (`privacy/egress.ts`), au seul moment où l'information existe. Un CalDAV
> local ne déclare plus d'égression ; un agenda cloud si.
>
> **Ce qui l'a rendue urgente :** F2 applique « niveau ≥ SENSITIVE + egress →
> DENY ». L'agenda est `SENSITIVE`, et les quatre outils sortants du dépôt
> manipulent tous de l'agenda — **tous devenaient définitivement refusés, y
> compris sur un fournisseur purement local.** Le défaut de modélisation
> cessait d'être une gêne théorique pour devenir un blocage complet.
>
> **Le test qui la portait avait annoncé sa propre fin** — « il DATE le constat
> et échouera le jour où le Data Firewall le rendra faux » — et il a échoué. Il
> est retourné en preuve de la fermeture.
>
> ⚠ **CE QUE LA LEVÉE COÛTE, ET IL FAUT LE DIRE.** `capabilities.local` est une
> DÉCLARATION du fournisseur. Un adaptateur qui mentirait — `local: true` en
> pointant vers Internet — échapperait au Gate. Avant, `networkRequired: true`
> était inconditionnel et ce chemin n'existait pas.
>
> Ce n'est pas un troc gratuit, c'est un troc **assumé** : l'alternative rendait
> la capacité inutilisable. Voir la nouvelle entrée **§4.9**.

#### Le constat d'origine, conservé

### 4.5-bis `egress` était un booléen là où il y a DEUX questions

**Trouvé en écrivant `calendar_read`, pas en relisant le modèle.**

Le premier outil sortant du dépôt a rendu mesurable ce qui n'était jusque-là
qu'une élégance de schéma : `egress` est dérivé de `networkRequired`
(`gateway.ts:801`), puis confronté à un interrupteur nommé `cloudEnabled`.
Deux questions distinctes sont écrasées sur un seul bit.

| Question | Champ qui la porte |
|---|---|
| l'appel quitte-t-il le **processus** ? | `ToolDefinition.networkRequired` |
| la destination est-elle hors de la **machine** ? | *(personne)* |

Un CalDAV sur `127.0.0.1` sort du processus sans sortir de la machine. Le
modèle ne sait pas l'exprimer, et les deux issues sont mauvaises :

- `networkRequired: false` ferait sortir un agenda **cloud** sans que le Gate
  le voie ;
- `networkRequired: true` — le choix retenu, fail-closed — oblige l'utilisateur
  à laisser `cloudEnabled` armé pour un usage quotidien. **Un interrupteur de
  sûreté qu'il faut désarmer pour se servir de la machine cesse d'être un
  interrupteur de sûreté.**

Mesuré : `tests/tools/calendar-read.test.ts`, dernier test — un fournisseur
dont `capabilities.local === true` est refusé sans `cloudEnabled`, autorisé
avec.

**Ce n'est pas réparable dans un outil.** `ProviderCapabilities.local` porte
déjà la réponse ; ce qui manque est le composant qui croise le contrat de
l'outil et les capacités du fournisseur — le **Data Firewall** de `docs/02`
Phase 4, dont la mission est littéralement « classification, redaction,
**décision d'égression** ».

**Conséquence sur l'ordre des chantiers.** Tout agenda cloud exige que ce
composant existe D'ABORD. Aujourd'hui, la règle censée protéger l'agenda
(`docs/14` : agenda = `SENSITIVE`, cloud interdit) **n'est pas en vigueur dans
le code** — `DataLevel` n'est pas implémenté, `PrivacyClass` en est encore à
trois valeurs, et la politique dure ne refuse que `RED + egress`. Un outil
d'agenda déclare `ORANGE` et passe. Ouvrir le cloud avant le Data Firewall
reviendrait donc à lui donner pour première mission de rattraper un trou déjà
ouvert.

**Condition de levée :** `DataLevel` implémenté et Data Firewall branché. Le
dernier test de `calendar-read.test.ts` échouera ce jour-là — c'est ce qu'on
demande à une zone d'ombre : se signaler quand elle disparaît.

### 4.6 `CalendarProvider` ne peut pas vérifier une tentative

**Trouvé en écrivant `calendar_create`, contre la prescription de `docs/16`.**

`docs/16 §3` prescrit pour cet outil :

```text
| futur calendar.create | EXTERNE | READ_BACK | BY_RESOURCE | clé d'opération |
```

L'interface déclarée ne peut pas l'honorer :

```ts
createEvent(event, operationId): Promise<Result<CalendarEvent>>
verifyEvent(id):                 Promise<Result<CalendarEvent | null>>
```

`verifyEvent` exige **l'identifiant de l'événement** — précisément ce qu'on n'a
pas si le processus est mort avant de l'avoir enregistré. La question à laquelle
une vérification de tentative doit répondre est *« as-tu déjà traité l'opération
8f2a… ? »*, et `CalendarProvider` ne sait pas l'entendre.

D'où `attemptVerification: 'NONE'`. Déclarer `BY_OPERATION_KEY` exigerait un
`verifyAttempt` qu'on ne pourrait pas écrire honnêtement — c'est exactement
l'**illusion de fiabilité** que le validateur de contrat existe pour empêcher
(`contract.ts:397`).

**Conséquence assumée :** après un `UNKNOWN`, on ne rejoue pas et on demande.
C'est la conduite prescrite par ADR-027, et elle est correcte ; simplement, elle
sera demandée plus souvent qu'elle ne devrait.

**Divergence document ↔ document, à trancher.** La règle de `docs/16 §3` —
*« aucun outil `effect: EXTERNAL` ne peut être enregistré avec
`attemptVerification: NONE` »* — n'est **pas** celle que le code applique, et ce
n'est pas un oubli : **ADR-030 l'a explicitement remplacée.**

> *« Interdire aurait exclu des familles entières d'outils légitimes — un webhook
> chez un tiers sans API de consultation reste utile. On n'interdit donc pas
> l'OUTIL : on interdit l'ILLUSION DE FIABILITÉ. »*

Le code interdit désormais : effet externe + `UNVERIFIABLE` + autonomie L1/L2.
`docs/16 §3` est donc **périmé sur ce point** et devrait renvoyer à ADR-030.

**Condition de levée :** un `findByOperationId` sur `CalendarProvider`, à ajouter
le jour où un adaptateur réel est écrit — et à ne pas ajouter avant, faute de
savoir si un CalDAV donné sait y répondre.

### 4.7 La fenêtre entre lecture et écriture, chez un fournisseur

**Trouvée en transposant ADR-042 hors de PostgreSQL.**

`task_complete` fusionne mutation et capture dans une seule instruction
(`UPDATE … FROM tasks AS prior`) : aucune fenêtre où l'état changerait entre les
deux. Chez un fournisseur distant, cette fusion **n'existe pas** — il n'y a ni
transaction commune, ni comparaison-et-échange.

ADR-045 déplace l'obligation plutôt que de fermer la fenêtre : le fournisseur
rend `previous`, l'état qu'il a lui-même remplacé. C'est strictement mieux qu'une
lecture préalable de notre part — mais **ce n'est pas une atomicité**, et la
différence doit être écrite.

**Ce qui reste ouvert :**

| Résidu | Ce qui le couvre aujourd'hui |
|---|---|
| le fournisseur peut mentir sur `previous` | vérifié : un identifiant qui ne correspond pas ⇒ `INTEGRITY`, refus |
| son `previous` peut être périmé de quelques millisecondes | **rien** — irréductible sans mise à jour conditionnelle |
| deux modifications concurrentes peuvent s'écraser | **rien** — c'est le même manque |

Le mécanisme qui fermerait les deux dernières lignes existe et porte un nom :
**la mise à jour conditionnelle** (`If-Match` sur un ETag, que CalDAV expose).
Elle n'est pas ajoutée à `CalendarProvider` aujourd'hui, et c'est délibéré —
ajouter un champ qu'aucun adaptateur ne remplit serait spéculatif au sens de
`docs/04`, et donnerait l'illusion d'une garantie.

**Condition de levée :** au premier adaptateur réel, mesurer si le fournisseur
expose un jeton de version. S'il l'expose, `updateEvent` doit le prendre et le
renvoyer, et cette entrée disparaît. S'il ne l'expose pas, elle devient
**irréductible pour ce fournisseur** et doit remonter en §5.

---

> ### ⚠ LEVÉE À MOITIÉ — ADR-078, et la moitié qui manque est nommée
>
> Le premier adaptateur réel existe : `src/providers/google/calendar.ts`.
> Google **expose des etags**, et `updateEvent` les prend et les renvoie en
> `If-Match`. Le mécanisme qui manquait est donc écrit :
>
> ```text
> lire l'événement        → etag "v7"
> PATCH avec If-Match v7  → 412 si quelqu'un a modifié entre-temps
>                         → rien n'est écrit, et Jarvis le DIT
> ```
>
> Les deux lignes « **rien** » du tableau ci-dessus sont couvertes : une
> modification concurrente ne s'écrase plus, elle échoue.
>
> **CE QUI N'EST PAS LEVÉ, ET LA DISTINCTION EST TOUT LE SUJET.** La condition
> disait *« MESURER si le fournisseur expose un jeton de version »*. Je ne l'ai
> pas mesuré : **je l'ai lu dans la documentation de Google.** Aucun compte
> n'est connecté, donc aucun appel réel n'a jamais été fait — les tests jouent
> contre un transport simulé, qui rend les etags parce que je lui ai dit d'en
> rendre.
>
> Conclure la levée ici serait exactement le motif que §2 recense : *une
> affirmation que le mécanisme censé l'établir n'établit pas.* Un transport que
> j'ai écrit ne prouve rien sur Google.
>
> **Reste donc à mesurer, au premier appel réel :** que Google rende bien un
> etag sur `events.get`, et qu'il réponde bien `412` sur un `If-Match` périmé.
> Deux appels suffiront.

### 4.8 La composition d'outils n'est pas éprouvée

**Mesuré avant d'écrire `briefing_generate` :** aucun outil du dépôt n'invoque le
Tool Gateway.

```bash
grep -rn "gateway\.\|invoke(" src/tools/*.ts   # → aucun appel
```

Un outil qui en appellerait un autre créerait une opération **imbriquée** dans
une opération : second bail, second identifiant, seconde entrée au journal, et
un verdict qui dépendrait de trois sous-verdicts. Rien de tout cela n'est
interdit par le code — et rien n'est éprouvé non plus.

`briefing_generate` **évite** la question : il lit les sources directement, et un
test structurel interdit à son fichier de contenir `gateway` ou `.invoke(`.
C'est un contournement assumé, pas une solution.

**Ce qui reste ouvert, et qu'il faudra trancher un jour :**

| Question | État |
|---|---|
| un bail imbriqué se comporte-t-il correctement ? | inconnu |
| le journal doit-il montrer une ou N opérations ? | non décidé |
| le verdict composite se déduit-il des sous-verdicts ? | non spécifié |
| une sous-opération refusée annule-t-elle la parente ? | non spécifié |

**Condition de levée :** un chantier de composition, avec son banc — pas un effet
de bord du prochain outil qui en aurait besoin. Le test structurel de
`briefing.test.ts` sera le premier à retirer, et sciemment.

### 4.9 `capabilities.local` est CRU, pas vérifié

**Créée par la levée de §4.5, et c'est la moitié qu'il ne faut pas oublier.**

Depuis ADR-051, la décision d'égression repose sur ce que le fournisseur déclare
de lui-même :

```ts
export function leavesMachine(provider: Provider | null): boolean {
  if (provider === null) return false;
  return !provider.capabilities.local;   // ← une DÉCLARATION
}
```

Un adaptateur qui annoncerait `local: true` en pointant vers Internet
échapperait au Policy Gate. Aucun mécanisme ne le contredit aujourd'hui.

**Pourquoi c'est accepté :** l'alternative — `networkRequired: true`
inconditionnel — rendait tout outil manipulant de l'agenda **définitivement
refusé**, y compris sur un CalDAV local. Une protection qui interdit l'usage
normal n'est pas conservée par les utilisateurs, elle est désactivée.

**Ce qui le borne déjà :** aucun adaptateur n'existe. Le seul fournisseur du
dépôt est une doublure de test, dont le `local` est fixé par le test lui-même.

**Condition de levée — et le mécanisme existe déjà.** `isPrivateAddress`
(`src/apps/server/auth.ts`) reconnaît `127.*`, `10.*`, `192.168.*`,
`172.16-31.*`, lien-local et ULA IPv6. Au premier adaptateur réel,
`capabilities.local` doit être **corroboré** par l'adresse effective du
fournisseur, pas cru sur parole. C'est la même discipline que
`PROVIDER_CONTRACT_VIOLATION` : un fournisseur qui ment sur lui-même est un
problème de SOURCE, et il se constate.

### 4.10 S12 — le défaire EXISTE, pour quatre outils inverses sur cinq

**Trouvée en rendant `docs/03` mécanique (ADR-054).** L'invariant S12 dit « le
rollback reste possible ». Mesure :

| | |
|---|---|
| `src/core/undo/` | **un seul fichier** — `snapshots.ts`, la capture |
| Outils inverses déclarés | `task_cancel` · `note_delete` · `memory_forget` · `calendar_delete` · `reminder_cancel` |
| Outils inverses **écrits** | **quatre** — `memory_forget` (ADR-065), `note_delete` · `task_cancel` · `reminder_cancel` (ADR-067) |
| Moteur qui rejoue une capture | **`src/core/undo/engine.ts`** (ADR-066) — rejoue par le Tool Gateway, jamais en écrivant lui-même |

L'invariant est donc vrai au sens des **données** — on sait quoi défaire, et
`ADR-019` garantit 7 jours de rétention — et faux au sens de l'**action** :
rien ne peut défaire.

**Pourquoi ce n'est pas classé « fait » :** parce que l'écart est exactement du
type que `docs/12` proscrit. « Le rollback est possible » lu par un humain
signifie « je peux revenir en arrière », pas « la donnée nécessaire est
conservée quelque part ».

**LEVÉE PARTIELLE — ADR-065.** `memory_forget` est écrit et éprouvé de bout en
bout : suppression réelle, dérivés en cascade, événement `MEMORY_DELETED`,
et l'interdit de `§C3` vérifié dans le journal **et** dans les instantanés.

Il a fallu commencer par lui, et pas par commodité : `docs/05 §C3` est
`CRITIQUE` quand les quatre autres sont du confort.

> ⚠ **ET IL A RÉVÉLÉ UN DÉFAUT DE VOCABULAIRE DU VERIFICATION ENGINE.**
> Tous les outils du dépôt réussissaient en faisant APPARAÎTRE quelque chose.
> `confirmed()` codait donc `POSITIVE_PRESENCE` en dur, et la seule fabrique
> rendant `POSITIVE_ABSENCE` était `failed()`. **Un outil dont le succès est
> une absence ne pouvait pas annoncer son succès honnêtement.**

**LE MOTEUR EXISTE DÉSORMAIS — ADR-066.** `undoLast` / `undoOperation` rejouent
une capture `INVERSE_OPERATION` **par le Tool Gateway**, donc par la politique,
l'outil typé, la vérification et le journal. La boucle complète est éprouvée sur
`memory_add → memory_forget`, jusqu'à la commande `/annule` du CLI.

Et la propriété qui compte : **annuler peut coûter plus cher que faire.**
`memory_add` est `L2`, son inverse `L4` — le moteur ne fabrique aucun
consentement, il transmet celui de son appelant.

**Ce qui reste, et qui reste chiffré :**

| | |
|---|---|
| Outil inverse non écrit | **`calendar_delete`** — le seul dont l'effet est EXTERNE. Sa vérification ne peut pas s'appuyer sur PostgreSQL : la fenêtre d'observation ne se ferme pas de la même façon, `PROBABLE` y devient un verdict possible. Il mérite sa propre passe |
| `STATE_RESTORE` | **refusé en nommant ce qui manque** — réappliquer les valeurs antérieures exigerait un outil de restauration par type de ressource ; aucun n'existe. `task_cancel` et `reminder_cancel` capturent pourtant l'état antérieur : ne pas le faire rendrait la restauration DÉFINITIVEMENT impossible le jour où l'outil existera |

Le refus est délibéré : restaurer « directement, puisqu'on a les données »
serait un second chemin d'écriture hors politique et hors journal.

**Condition de levée complète :** un outil de restauration d'état, et `calendar_delete`. La réserve reste chiffrée dans
`invariants-contract.test.ts` — et elle a survécu au passage de S12 de « tracé »
à « nommé », ce qui est précisément le piège qu'ADR-066 a fermé.

### 4.11 ~~S13~~ — LEVÉE : l'interrupteur cloud existe (ADR-069)

> ⚠ **CETTE ZONE EST LEVÉE — ADR-069.** Elle disait : *« le motif CostGate une
> deuxième fois : tenu par ABSENCE, pas par mécanisme. »* `cloud.enabled` est
> désormais lu par le runtime et transmis à l'Assistant ; le défaut de
> `config/default.json` reste `false`.
>
> **Et elle contenait une erreur de cadrage, de moi.** J'avais classé S13
> « bloqué sur une décision utilisateur ». Seule la moitié l'était : « quel
> fournisseur cloud » est un choix produit, « l'interrupteur fonctionne-t-il »
> est un défaut. Les confondre a retardé la correction de plusieurs sprints.

Ce qui suit décrit l'état AVANT correction, conservé parce que le raisonnement
reste vrai du CostGate — même motif, même endroit, une troisième fois.

**Le motif « CostGate » une deuxième fois : tenu par ABSENCE, pas par mécanisme.**

`config/default.json` expose `cloud.enabled`. Le runtime écrit
`cloudEnabled: false` en littéral, et l'Assistant aussi. **La clé de
configuration n'a aucun effet** — c'est `wiring.test.ts` qui le démontre, pas
qui le corrige.

Le résultat va dans le bon sens aujourd'hui. Le piège est ailleurs : une clé
exposée laisse croire qu'un interrupteur existe. Or l'invariant S13 ne dit pas
« le cloud est éteint », il dit **« l'utilisateur peut désactiver le cloud »** —
ce qui suppose qu'il puisse aussi l'activer, donc que la clé pilote quelque
chose.

**Ce qui le borne :** aucun fournisseur cloud n'existe. L'interrupteur n'aurait
aujourd'hui rien à commander, et le brancher avant serait un interrupteur qui
ment dans l'autre sens.

**Condition de levée :** au premier fournisseur cloud branché, `cloud.enabled`
doit piloter `cloudEnabled` — au même moment que le branchement du CostGate
(§4.1), et pour la même raison.

### 4.12 ~~Le Context Engine~~ — LEVÉE : Jarvis résout « ça », et demande sinon

> ⚠ **MOITIÉ LEVÉE — ADR-071.** Ce qui suit disait : *« il n'a RIEN à
> résoudre »*. `entity_create` peuple `entities` sur demande explicite de
> l'utilisateur — **zéro modèle, zéro euro** — et `resolveAnaphora` rend
> maintenant `RESOLVED` là où il rendait invariablement `NOT_FOUND`.
>
> C'est la condition de révision que l'ADR d'origine s'était écrite, et elle
> s'est réalisée par le chemin qu'elle avait prévu.
>
> **SECONDE MOITIÉ LEVÉE — ADR-072.** La boucle renseigne désormais
> `mentionedEntityIds` : CLI et passerelle web enregistrent ce que l'échange a
> touché, sans aucune inférence — l'outil DÉCLARE la ressource.
>
> **TROISIÈME ET DERNIÈRE MOITIÉ LEVÉE — ADR-073.** Une règle `Tier 0` atteint
> `entity_create` (« enregistre X comme document »), et l'Assistant résout les
> référents avant d'invoquer un outil.
>
> **A2 EST LEVÉ.** Éprouvé de bout en bout dans
> `tests/golden/a2-referent.test.ts` — par du texte, jamais par un appel direct.
>
> ⚠ **ET LA PROPRIÉTÉ QU'ON A REFUSÉ DE VENDRE.** Rendre `propose()` asynchrone
> était la voie courte. Elle aurait fait dépendre la COMPRÉHENSION d'une
> entrée-sortie : `propose(text)` reste une fonction pure du texte,
> déterministe, éprouvable sans base. La résolution vit dans l'Assistant, qui
> était déjà asynchrone.
>
> **Ce qui reste** : `packet.ts` — composer un paquet de contexte est autre
> chose que résoudre une référence, et une seule des deux est faite.
>
> Trois motifs successifs, tous tombés pour de bon, chacun remplacé par un plus
> précis. Aucun n'a été effacé pour faire tomber un compteur.

Le diagnostic d'origine, conservé parce qu'il reste exact sur la seconde moitié :

**Ce registre décrivait mal sa propre zone d'ombre**, et la description
importait plus qu'il n'y paraît : elle désignait un chantier de câblage là où
il y a un chantier de capacité.

Ce que disait §4.1 : « la boucle réelle ne résout pas les entités », condition
de réouverture « `QUICKSTART` promet la levée d'ambiguïté — dette visible ».
**Les deux moitiés étaient fausses.**

`QUICKSTART` ne promet rien — il déclare l'absence, mot pour mot :

> ⚠ La désambiguïsation entre deux homonymes (« quel Jean ? ») n'existe **pas
> encore** : le Context Engine est écrit et testé, mais pas branché.

Et « pas branché » n'est pas la cause. Mesuré :

```text
resolveAnaphora  lit session_turns.mentioned_entity_ids
                 → AUCUN appelant du produit ne le renseigne
                   (`http.ts:141`, `cli/main.ts:271` : les deux l'omettent)
resolveMention   lit entities / entity_aliases
                 → AUCUN `INSERT` hors des tests
```

Brancher le résolveur aujourd'hui le ferait répondre `NOT_FOUND` à chaque
appel. On aurait retiré deux orphelins du compteur **sans rien rendre possible**
— la pire façon de payer une dette : celle qui change le tableau de bord et pas
le produit.

**La vraie condition de réouverture** : une capacité de **reconnaissance
d'entités** dans du texte libre. Elle demande un modèle, or l'Intent Engine est
**Tier 0 par conception** (règles, aucun modèle). C'est donc un chantier de
Phase 5+ ou d'un Tier 1, pas un oubli de câblage.

**Conséquence assumée sur le chiffre :** `docs/28` marquait la Phase 1 à 100 %.
Un livrable de cette phase — « Context Engine : résolution ; détection
d'ambiguïté » — n'est pas atteignable par l'utilisateur. L'étendue
fonctionnelle mesure *ce que Jarvis sait faire* : la phase redescend à 90 %.

**Et la porte de sortie mérite d'être lue avec ça en tête.** `docs/02` coche
« Face à trois « Pierre » connus, **Jarvis** demande ». Or `ops/gates/phase1.ts`
appelle `createEntityResolver` **directement** : la porte éprouve le MODULE, et
son propre libellé le dit honnêtement (« le résolveur »). C'est la case du
document qui promet le produit.

> Une porte qui éprouve un module ne franchit pas une phase dont le livrable
> est un comportement. Les deux ne se confondent que si on lit vite.

---

### 4.13 La fluidité conversationnelle — 43 %, et le verrou est la RECONNAISSANCE

**Mesuré, pas estimé** (ADR-080). Trente tours d'une conversation réaliste :

```text
TOTAL             13/30    43 %   aboutissent
REFERENCE          0/8      0 %   ← le chiffre décisif
ERREURS TECHNIQUES 0/30            les 17 refus sont FORMULÉS
```

Plus d'un quart d'une vraie conversation désigne une chose **sans la renommer**.
C'est ce qui distingue une conversation d'une suite d'ordres, et Jarvis n'en
traite aucun cas.

**La cause n'est pas celle qu'on croit.** `resolveAnaphora` existe et fonctionne
(ADR-073). Il tourne à vide faute de MATIÈRE : il lit `mentioned_entity_ids`, et
rien n'évoque d'entité dans un fil ordinaire — seul `entity_create` en crée, sur
demande explicite.

> C'est la **reconnaissance** d'entités qui manque, pas la résolution. La
> première demande un modèle ; la seconde est exacte, locale et gratuite.

⚠ **CE DIAGNOSTIC EST TROP ÉTROIT — corrigé ADR-085, après re-mesure.**

Il dit « le résolveur tourne à vide faute de MATIÈRE ». Mesuré : **il n'est
jamais appelé.** Les huit tours ressortent `UNSUPPORTED` — aucune règle `Tier 0`
ne reconnaît la formulation, donc aucun référent n'est jamais PRODUIT.

```text
écrit      reconnaissance d'ENTITÉS  →  « il », « le carreleur »
mesuré     reconnaissance de l'ÉNONCÉ →  « Marque la première comme faite »
                                          n'atteint aucune règle
```

« Marque la première comme faite » n'échoue pas faute d'entité : il échoue faute
de règle. La distinction change la conclusion — il ne suffira pas de peupler
`entities`, il faut qu'un modèle comprenne la phrase (ADR-082, ADR-084).

**Et un second verrou apparaît derrière le premier**, invisible tant que rien ne
reconnaît : `resolveAnaphora` ne résout que vers des **entités**. Or trois des
huit tours désignent une ressource que Jarvis vient de toucher — une note, une
tâche, un rappel. L'identifiant est connu **exactement** au moment de l'action,
et l'Assistant le jette :

```ts
// assistant.ts — ADR-072
mentionedEntityIds: touchee.kind === 'entity' ? [touchee.id] : []
```

Ces trois-là ne demandent **aucune** reconnaissance d'entité, seulement de
cesser de jeter ce que l'outil déclare. C'est le chantier qui suit
immédiatement l'installation d'un modèle.

**Condition de levée** : un `Tier 1` local capable de reconnaître les entités
d'un énoncé libre — le chantier qu'ADR-017 chiffre. Écrire des règles `Tier 0`
pour les référents ne marcherait pas : « il » ne se résout pas par la forme de la
phrase, mais par ce qui a été dit avant.

> ⚠ **LEVÉE PARTIELLE — ADR-084, et la partie qui reste est nommée.**
>
> Le `Tier 1` peut désormais MARQUER un paramètre comme renvoi
> (`ANAPHORA` / `TEMPORAL`) sans jamais le résoudre. Deux moitiés très
> inégales :
>
> | | État |
> |---|---|
> | **`TEMPORAL`** | **complet**. « faudrait que je pense au café jeudi » écrit un rappel daté par PostgreSQL (ADR-077). Aucune reconnaissance d'entité n'est nécessaire |
> | **`ANAPHORA`** | **un non-sens devient une question**. « annule-la » ne produit plus `title: "la"` mais « À quoi fais-tu référence ? » |
>
> **Le verrou décrit ci-dessus est INTACT.** `resolveAnaphora` lit
> `mentioned_entity_ids`, que seul un outil touchant une ENTITÉ renseigne — une
> tâche, une note, un rappel n'en sont pas. La reconnaissance d'entités reste
> le chantier, exactement comme écrit.
>
> **Et la voie courte a été refusée**, ce qui est le vrai contenu d'ADR-084 :
> donner l'historique de conversation au modèle aurait atteint `REFERENCE` plus
> vite. Un historique contient les tours `JARVIS`, et `speaker: 'JARVIS'` ne
> veut pas dire *produit par Jarvis* — un email lu à voix haute y figure. C'eût
> été T1 par la grande porte. Demander au modèle de **pointer du doigt** coûte
> zéro token d'historique.
>
> **Le chiffre, lui, n'a pas bougé** — et ne peut pas avoir bougé : aucun modèle
> n'a tourné. Les 43 % restent la dernière mesure réelle. Un quatrième inconnu
> s'ajoute même aux trois d'ADR-082 : *un 8B pose-t-il la marque de renvoi, ou
> l'ignore-t-il ?* C'est pourquoi `referents` est **optionnel**, et pourquoi un
> test fige le comportement sans marque.

⚠ **Le piège du chiffre** : on peut le faire monter en ajoutant des règles pour
les phrases exactes du scénario. Il grimperait sans que rien ne s'améliore. Les
trente tours sont un **échantillon**, pas une cible.

---

### 4.15 Le banc de scénarios recopie la boucle du CLI au lieu de l'appeler

**Ouverte par ADR-085**, sciemment, en corrigeant §2.10.

Le banc doit enregistrer les tours comme le fait le produit. Il le fait en
**recopiant** douze lignes de `cli/main.ts` — donc deux registres du même fait,
ce qu'ADR-041 proscrit : *« deux registres du même fait finissent par diverger,
et le jour où ils divergent aucun ne fait autorité »*.

C'est exactement le défaut qui vient d'être corrigé, sous une autre forme : le
jour où le CLI changera sa façon d'enregistrer, le banc mesurera de nouveau un
produit qui n'existe pas.

**Pourquoi c'est accepté malgré tout** : l'alternative — extraire la boucle du
CLI en fonction partagée — est un chantier qui touche le point d'entrée du
produit. Le faire dans la même passe que la correction d'une mesure aurait mêlé
deux risques. Recopier douze lignes vaut mieux que continuer à mesurer sans
session.

**Condition de levée** : une fonction `tourComplet(runtime, sessionId, texte)`
partagée par le CLI, la passerelle web et le banc. Les trois l'appellent, aucun
ne la recopie.

**Ce qui la borne en attendant** : le banc vérifie que la session contient
autant de tours que d'actions abouties. Une divergence de COMPTE serait vue.
Une divergence de CONTENU ne le serait pas.

---

### 4.14 Le texte libre d'une conversation n'est pas classé

**Ouverte par ADR-083**, en corrigeant §2.9 — c'est la moitié que la correction
ne pouvait pas emporter.

Le paquet de contexte filtre désormais ses trois canaux. Mais il filtre des
**enveloppes**, pas des contenus :

| Ce qui entre | Filtré sur | Reste exposé |
|---|---|---|
| mémoires | `privacyClass` de la ligne | — |
| entités | `privacy_class` de la ligne | — |
| tours | `provenance` de la ligne | **le contenu du tour** |
| `query` | rien | **tout** |

Si Julien dicte son IBAN, ou parle d'un diagnostic, le paquet ne le sait pas.
Les tours sont du texte libre, et `session_turns` ne porte **aucune catégorie
de donnée**.

**Pourquoi ce n'est pas corrigé sur place.** Classer du texte libre exigerait
de deviner à partir des mots — exactement ce que `privacy/classify` refuse par
principe :

> Le niveau se déduit de la CATÉGORIE, que la base impose à l'écriture.

Une heuristique lexicale se tromperait dans les deux sens, et le sens dangereux
est **silencieux** : elle laisserait passer ce qu'elle ne reconnaît pas, tout en
donnant l'impression qu'un classement a eu lieu. C'est le défaut de §2.9 sous
une autre forme — une protection qui rend « rien à écarter ».

**Condition de levée** : une colonne `data_category` sur `session_turns`,
renseignée **à l'écriture** par l'appelant, qui seul sait ce qu'il insère.
`appendTurn` est le seul écrivain : le chantier est borné.

**Ce qui la maintient visible** : un test la fige explicitement
(`packet.test.ts`, *« le contenu d'un tour fiable N'EST PAS classé — limite
déclarée »*). Il vérifie qu'un IBAN traverse le paquet, et **rougira le jour où
la catégorie existera** — c'est-à-dire au moment exact où cette section doit
être relue.

> C'est la forme qu'on veut pour une dette : un test qui échoue quand on la
> rembourse, plutôt qu'un paragraphe qu'on oublie d'effacer.

---

## 5. IRRÉDUCTIBLES — et elles le resteront

Aucune ne se lèvera par plus de code. Les écrire est la seule chose à faire.

| | Pourquoi c'est impossible |
|---|---|
| **Savoir si un processus est vivant** | « gelé » et « mort » sont indiscernables de l'extérieur. Mesuré `docs/21`, reconfirmé `docs/25 §4.3`. |
| **Savoir si un exécutant périmé a produit un effet** | le cloisonnement protège l'état interne, jamais le monde. Mesuré : l'effet de A existe pendant que son écriture est refusée. |
| **Annuler une requête déjà partie** | rien dans la pile ne l'offre. Ni `withTimeout`, ni le bail, ni le cloisonnement. |
| **Déduire l'absence d'effet d'une absence d'observation** | au moment où on regarde, il n'y a rien À VOIR. Ce n'est pas un défaut de vérification, c'est une limite de l'observation (`docs/21 §2`). |
| **Vérifier qu'un fournisseur dit vrai** | une réponse est une OBSERVATION, jamais une preuve. Croire un `500` est la faute symétrique de croire un `200`. |
| **Garantir qu'une garantie de tiers tient** | `PROVIDER_IDEMPOTENT` repose sur la parole du fournisseur. Le banc peut mettre en scène un menteur ; il ne peut pas le rendre honnête. |

Une seule règle en découle, et elle est déjà dans `CLAUDE.md` :

> Une fonctionnalité ne peut jamais être plus autonome que la qualité de la
> preuve disponible sur son effet.

---

## 6. NON TESTABLE ICI — et ce qui en reste vraiment

Après le §2.2, la liste a beaucoup rétréci. Ce qui subsiste :

| | Pourquoi, précisément |
|---|---|
| Partition réseau **réelle** entre application et base | une seule machine. Ce qui est mesurable — base injoignable — l'est (`docs/25 §4.5`), et la propriété tenue est « Jarvis ne tente rien ». |
| Dérive d'horloge entre **deux serveurs PostgreSQL** | sans objet : ADR pose une source de vérité unique. Deux serveurs seraient deux Jarvis, pas un Jarvis distribué. |
| Comportement d'un **fournisseur réel** | par construction du gel fonctionnel : aucun SaaS, aucun appel sortant, 0 €. |

La deuxième ligne est un changement de statut, pas un aveu : elle passe de
« non testable » à **« sans objet »**, ce qui n'est pas la même chose.

---

## 7. Ce que ce balayage ne garantit pas

La phrase la plus importante du document.

**Ce registre est exhaustif sur ce que je sais chercher.** Les quatre défauts
majeurs de ce dépôt ont tous été trouvés par la **mesure**, jamais par la
relecture — et le cinquième, corrigé au §2.1, l'a été en cherchant le voisin
d'un motif connu.

Un sixième existe probablement, et il ne ressemblera à aucun des cinq
précédents. La seule défense connue reste celle qui a fonctionné cinq fois :

```text
MESURER · CHERCHER LE CONTRE-EXEMPLE · SABOTER SES PROPRES GARDES
```

Et la règle méthodologique qui l'accompagne, qui n'a pas bougé :

> Ne jamais considérer « tests verts » comme synonyme de « système sûr ».
