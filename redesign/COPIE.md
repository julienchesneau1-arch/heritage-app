### src/app/actions.ts
- Endormie par la famille.
- Aucun fichier choisi.
- Fichier trop lourd (max 50 Mo).
- Ce fichier n’est pas du JSON valide.

### src/app/api/calendrier/[memberId]/[token]/heritage.ics/route.ts
- Calendrier introuvable.
- Famille ${family.name} — mémoire

### src/app/api/family/[id]/archives/route.ts
- Membre inconnu dans cette famille.
- Récit inconnu dans cette famille.
- Formulaire illisible.
- Fichier manquant.
- Fichier vide.
- Fichier trop lourd (max ${MAX_UPLOAD_BYTES / 1024 / 1024} Mo).
- Type de fichier non accepté : ${file.type || 

### src/app/api/family/[id]/import-conversation/route.ts
- Identité requise pour écrire dans la mémoire.
- Conversation ${origine} du ${new Date(moment.debut).toLocaleDateString(

### src/app/api/family/[id]/stories/[storyId]/route.ts
- Identité requise.
- La suppression exige une identité vérifiée (lien personnel).
- Seul l’auteur peut supprimer ce récit.

### src/app/api/family/[id]/stories/route.ts
- Auteur inconnu dans cette famille.

### src/app/api/family/[id]/traditions/[traditionId]/route.ts
- Endormie par la famille.

### src/app/api/family/[id]/transcriptions/[draftId]/local/route.ts
- Ce brouillon a déjà été validé.

### src/app/api/transcriptions/process/route.ts
- TRANSCRIPTION_WORKER_SECRET non configuré.
- Aucune clé OpenAI configurée : rien à traiter.

### src/app/archives/page.tsx
- Archives
- Aucune archive. Les photos et les enregistrements se déposent depuis la page d’un récit.
- Non rattachée à un récit.

### src/app/bienvenue/page.tsx
- Héritage
- Cette adresse n’est rattachée à aucune famille.
- L’accès se fait par le lien privé de votre famille, de la forme
- Commencer une mémoire

### src/app/brouillons/[draftId]/page.tsx
- Transcrire sans rien envoyer, sans rien payer
- Retour
- Écouter et relire
- Votre navigateur ne peut pas lire cet enregistrement.
- Retiré automatiquement
- Deux transcriptions comparées
- Souligné : les deux transcriptions ne disent pas la même chose. Ce sont ces passages-là qu’il faut réécouter — le reste est confirmé par deux modèles indépendants.
- Second avis
- Ce moteur ne fournit aucun indicateur de confiance : aucun passage n’est signalé parce qu’aucun ne peut l’être. Tout le texte est à confronter à l’enregistrement.
- Le modèle n’a pas renvoyé de découpage : tout le texte est à vérifier.
- Un titre et un texte sont nécessaires.
- Qui parle sur cet enregistrement ?
- Titre
- Le récit, tel qu’il doit rester
- Corrigez librement. Ce que vous enregistrez ici fait foi ; la proposition brute de la machine est conservée à part, sans jamais être affichée comme un récit.
- C’est juste — enregistrer le récit
- Écarter cette transcription
- L’enregistrement est conservé : c’est lui, l’original.
- La transcription n’a pas encore été faite. L’enregistrement, lui, est conservé.
- La transcription a échoué : ${draft.error}
- Ce brouillon a déjà été traité.
- Autre version : ${token.b ?? 

### src/app/brouillons/page.tsx
- À mettre au propre
- Un enregistrement transcrit par la machine n’est pas un récit. Il attend ici que quelqu’un l’écoute et le relise. Rien n’entre dans la mémoire de la famille sans cette relecture.
- Aucun brouillon en attente.
- En attente de transcription. Le texte apparaîtra ici — l’enregistrement, lui, est déjà conservé.
- Écouter et relire
- Réessayer
- Ce moteur ne dit rien de sa propre confiance : tout est à vérifier.
- Aucun passage signalé par le modèle — la relecture reste nécessaire.

### src/app/commencer/page.tsx
- Commencer une mémoire
- Une famille, et la première personne qui la porte. Le reste s’ajoutera ensuite.
- Il n’y a pas de mot de passe. L’accès se fera par un lien privé, que vous transmettrez vous-même aux vôtres.
- Il manque un nom de famille, un prénom, ou la génération est invalide.
- Nom de la famille
- Nom et prénom
- Génération
- Date de naissance
- Les dates ne servent qu’à une chose : que l’application sache quel jour un anniversaire tombe. Rien n’est envoyé nulle part.
- Créer la famille
- Restaurer une sauvegarde

### src/app/famille/page.tsx
- La mémoire est ouverte. Ajoutez maintenant les vôtres, puis transmettez à chacun son lien personnel.
- Ce membre n’a pas pu être enregistré : nom manquant, ou dates incohérentes.
- Le lien de la famille
- Il donne accès à la mémoire, et permet de se déclarer membre. Il ne permet pas de supprimer. Quiconque le détient entre — ne le publiez nulle part.
- Changer ce lien
- Les membres
- Nom
- Génération
- Naissance
- Décès
- Ne pas faire figurer ces dates au calendrier
- En un mot
- Enregistrer
- Révoquer ce lien
- Retirer de la famille
- Révoquer un lien n’affecte que ce membre : les autres restent connectés. Retirer quelqu’un ne supprime aucun récit — l’auteur devient « Auteur anonymisé ».
- Reprendre une conversation existante
- Des années d’échanges dorment dans un groupe WhatsApp. Vous pouvez en garder ce qui mérite de rester — le fichier est lu sur votre appareil, jamais envoyé.
- Importer une conversation
- Le calendrier de la famille
- N’y figurent que des dates saisies par la famille. Rien n’en est déduit, et la date de création d’un récit n’y entre pas : l’application ne se fabrique pas d’occasions.
- Le texte des récits n’y figure jamais.
- Ajouter un membre
- Nom et prénom
- Ajouter

### src/app/fils/[threadId]/page.tsx
- Voir dans le graphe
- Lire le récit

### src/app/fils/[threadId]/recit/page.tsx
- En faire un récit
- Voici ce que la machine a assemblé à partir de ce que vous vous êtes dit. Rien n’y est ajouté. Relisez, corrigez, complétez — c’est votre texte qui sera gardé, pas le sien.
- Titre
- Le récit
- Type
- Raconté par
- Plusieurs voix
- Garder ce récit
- Ce qui a été dit, mot pour mot
- Ce fil ne disparaîtra pas : il restera attaché au récit comme sa provenance.

### src/app/graphe/page.tsx
- Rien à relier pour l’instant.
- Par où voulez-vous entrer ?
- Changer de point d’entrée
- Aucun récit actif ne mentionne cette entité.
- Bleu : personne · marron : lieu · orange : objet · rouge : récit. Les traits sont des liens déclarés par la famille, jamais déduits.
- Rien n’a encore été dit ici. Une phrase suffit — il n’y a pas de rédaction à faire.
- Dire quelque chose sur ${selected.name}

### src/app/hors-ligne/page.tsx
- Hors ligne
- Cette page n’a pas encore été consultée sur cet appareil, et le réseau ne répond pas.
- Les récits déjà lus ici restent accessibles. Le reste attendra le retour de la connexion.
- Hors ligne — Héritage

### src/app/importer/page.tsx
- La famille se parle déjà quelque part.

### src/app/layout.tsx
- Aller au contenu
- Exporter la mémoire
- Ce que l’application fait de votre mémoire
- La mémoire d’une famille. Une histoire doit pouvoir engendrer une autre histoire.

### src/app/livre/page.tsx
- Pour l’imprimer ou en faire un PDF : Fichier → Imprimer. Cette page est composée pour le papier ; ce rappel n’y figurera pas.
- Ce que la famille s’est raconté
- Ce livre est vide. Il attend une première phrase.
- Ce que ce livre ne dit pas
- Un livre de famille donne toujours l’impression d’être complet. Celui-ci ne l’est pas, et voici où. Les pages qui suivent ont de la place pour écrire.
- Questions restées sans réponse
- Récits dont on ignore la date
- Ces récits ont été notés, mais personne n’a dit quand les faits ont eu lieu. La date de saisie n’est pas la date de l’événement, et elle n’a pas été mise à sa place.
- Personnes qu’aucun récit ne mentionne
- Aucune question n’est restée sans réponse, chaque récit porte sa date, et chaque membre de la famille apparaît quelque part.
- Les récits archivés et mis en quarantaine ne figurent pas ici : ils restent dans l’application, et dans l’export.
- Né du récit précédent
- Date de l’événement non renseignée.

### src/app/page.tsx
- Le Passeur
- Répondre
- En faire un récit
- Raconter la suite
- Lire l’histoire
- Ne plus me montrer
- Voir la tradition
- Rappel temporel

### src/app/qui/page.tsx
- Qui êtes-vous ?
- Cette information reste dans votre navigateur. Elle sert à savoir à qui le Passeur s’adresse.
- Taille du texte
- Ce réglage ne vaut que pour cet appareil.

### src/app/recits/[storyId]/modifier/page.tsx
- Corriger
- Si quelque chose est inexact, la voie ouverte est de poser une question sur le récit.
- Revenir au récit
- Les questions, les réponses et les liens de transmission de ce récit ne bougent pas.
- Un titre et un texte sont nécessaires.
- Titre
- Le récit
- Type de récit
- Ton
- Date de l’événement
- Enregistrer les corrections

### src/app/recits/[storyId]/page.tsx
- Proposer une transcription
- Une machine proposera un texte. Il faudra l’écouter et le relire avant qu’il devienne un récit — elle se trompe, et il lui arrive d’inventer.
- Ajouter une photo ou un enregistrement
- Raconter la suite
- Corriger
- Me remontrer ce récit
- Supprimer définitivement
- Seuls celui qui a raconté et celui qui a noté peuvent corriger ce récit.
- Aucun fichier n’a été choisi.
- Ce fichier dépasse 25 Mo.
- Ce type de fichier n’est pas accepté.
- La suppression demande une identité prouvée. Ouvrez votre lien personnel — celui qui vous a été transmis à vous seul — puis réessayez.
- Seul celui qui a saisi ce récit peut le supprimer.
- Raconté par ${story.narrator.isDeleted ? 
- Auteur anonymisé
- Par ${story.author.isDeleted ? 

### src/app/recits/nouveau/page.tsx
- Raconter
- Le récit n’a pas pu être enregistré : un titre et un texte sont nécessaires.
- Qui raconte ?
- Titre
- Le récit
- Personnes, lieux, objets (facultatif)
- Séparés par des virgules. Le type par défaut est PERSON.
- Type de récit
- Laisser le système classer
- Ton
- Date de l’événement
- Enregistrer le récit
- Robert:PERSON, Montre Omega:OBJECT, Bordeaux:PLACE

### src/app/recits/page.tsx
- Chercher dans les récits
- Filtrer par type de récit
- Tous les types
- Filtrer
- PAGE_SIZE ? (
- Récits plus récents
- Récits plus anciens
- Masquer les récits archivés
- Aucun récit actif ne correspond. ${archivedMatching} récit${archivedMatching > 1 ? 
- Aucun récit ne correspond à cette recherche.
- Aucun récit pour l’instant.
- Auteur anonymisé
- Récits ${(page - 1) * PAGE_SIZE + 1} à ${shown} sur ${total}, du plus récent au plus ancien.
- Pagination des récits

### src/app/restaurer/page.tsx
- Restaurer une sauvegarde
- Déposez un fichier d’export Héritage. Une nouvelle famille sera créée à partir de son contenu.
- Fichier d’export (.json)
- Restaurer

### src/app/traditions/page.tsx
- Traditions
- Aucune tradition enregistrée.
- Nous l’avons faite
- Ajouter une tradition
- Nom
- Description
- Périodicité
- Annuelle
- Mensuelle
- Hebdomadaire
- Jour (MM-JJ)
- Jour de la semaine
- Enregistrer
- Chaque année, ${moisJourEnClair(tradition.monthDay)}
- Chaque ${WEEK_DAYS[tradition.weekDay]}

### src/app/transmission/page.tsx
- Ce que l’application fait de votre mémoire
- Cette application choisit ce qu’elle vous montre, et ce choix exclut le reste. Voici ce qu’elle écarte, ce qu’elle tait, et ce qu’elle n’a jamais remontré.
- Ce que l’algorithme écarte
- Aucune lecture n’a encore été enregistrée. Les deux mesures qui en dépendent sont donc impossibles — ce qui n’est pas la même chose qu’un bon résultat.
- Ce que la forme du produit fait à la parole
- Rappel patrimonial
- Ces récits existent depuis plus de douze mois et n’ont pas été relus dans cet intervalle. Ils sont listés ici, et nulle part ailleurs : rien ne les pousse dans le flux.
- Ce qui ne figure plus ici
- Récits jamais revus depuis 12 mois
- Ils restent lisibles, cherchables et exportables. Un récit récent n’y figure pas : il n’a pas encore eu douze mois pour être oublié.
- Récits sur-exposés
- Rien à mesurer sans impressions enregistrées.
- Au-delà du double de la part moyenne, un récit cesse d’être suggéré.
- Récits mis en sourdine
- Trois refus explicites d’un même membre, pour ce membre seulement. Réversible à tout moment.
- Non mesurable : il faut des lectures enregistrées pour comparer qui raconte et qui est lu.
- Écart entre qui raconte les récits et qui est réellement lu. Mesuré, pas corrigé.
- La voix, pas le clavier
- Part des messages notés par quelqu’un d’autre que celui qui parle. Un fil écrit avantage le clavier rapide ; cette mesure dit de combien.

### src/app/veillee/page.tsx
- La veillée
- Il n’y a pas encore de récit à lire ensemble.
- Raconter le premier
- Personne n’a choisi ces récits pour vous plaire. Chacun est là pour une raison, qui vous sera dite avant de le lire.
- Commencer
- Quelqu’un se souvient-il d’autre chose ? C’est le moment de le dire à voix haute — pas de l’écrire.
- Si un récit naît de cette veillée, il pourra être noté plus tard. L’application n’a pas besoin d’être ouverte pour que la mémoire passe.
- Noter ce qui a été dit
- Refermer
- Ouvrir le récit
- Auteur anonymisé

### src/components/AudioRecorder.tsx
- Cet appareil ne permet pas d’enregistrer depuis le navigateur, ou le micro a été refusé. Le dépôt d’un fichier audio reste possible.
- Arrêter l’enregistrement
- Enregistrement prêt — reste à le déposer.
- Réenregistrer
- Enregistrer une voix

### src/components/ImportConversation.tsx
- Le fichier exporté
- Le fichier
- Comment obtenir ce fichier
- Lecture du fichier…
- À qui est ce téléphone ?
- Une sauvegarde de SMS nomme la personne qui a écrit les messages
- Sans ce nom, la moitié de la conversation resterait sans auteur. L’application ne le devinera pas.
- Nom du propriétaire du téléphone
- Continuer
- Je ne sais pas
- Ce que contient ce fichier
- Vérifiez la plage de dates : si l’année paraît fausse, le fichier a été lu en mois/jour au lieu de jour/mois. Ne poursuivez pas dans ce cas.
- Qui est qui
- Personne de la famille
- Les moments
- Aucun échange d’au moins trois messages entre au moins deux personnes dans ce fichier.
- Chaque moment retenu devient un fil, avec ses messages tels qu’ils ont été écrits. Rien d’autre ne sera enregistré.
- Enregistrement…
- Ils sont là comme n’importe quel fil : on peut y répondre, et en faire un récit.
- Revenir à l’accueil
- Ce fichier ne correspond à aucun format connu. Aucune lecture n’a été tentée : deviner produirait un import silencieusement faux.
- Ce fichier n’a pas pu être lu.
- Aucun message reconnu dans ce fichier ${source.nom}. ${source.commentExporter}
- L’enregistrement a échoué. Rien n’a été ajouté à la mémoire.

### src/components/LocalTranscription.tsx
- Moteur de transcription
- Le calcul a lieu sur cet appareil : rien n’est facturé, la durée n’a pas d’importance, et l’enregistrement n’est envoyé nulle part.
- Lecture de l’enregistrement…
- Repérage des passages parlés…
- Aucune parole détectée dans cet enregistrement.
- Enregistrement du brouillon…
- Le brouillon n’a pas pu être enregistré.
- Terminé. Il reste à écouter et relire.
- La transcription locale a échoué sur cet appareil.
- Demander un second avis
- Transcrire sur cet appareil

### src/components/Nav.tsx
- Héritage
- Famille
- Qui êtes-vous ?
- Aujourd’hui
- Raconter
- Tout le reste

### src/components/fil.tsx
- Retirer mes mots
- En faire un récit
- Qui parle
- Envoyer
- Si vous notez ce que quelqu’un d’autre raconte, choisissez son nom : la mémoire lui appartient, pas au clavier.

### src/components/premier-jour.tsx
- Reprendre une conversation existante

### src/lib/calendar.ts
- Anniversaire de ${member.name}
- Date de naissance enregistrée : ${isoDay(member.birthDate)}.
- Date de décès enregistrée : ${isoDay(member.deathDate)}.
- Tradition : ${tradition.name}
- événement raconté dans ce récit.

### src/lib/errors.ts
- Limite de parcimonie atteinte.
- Action interdite par la Constitution.
- Histoire en quarantaine.
- Aucun trigger détecté.
- Ressource introuvable.
- Données invalides.
- Trop de requêtes.
- Accès refusé.

### src/lib/honnetete.ts
- Aucun ${options.sujet} enregistré : il n’y a pas un taux nul, il n’y a pas de taux.

### src/lib/import/messenger.ts
- Ce fichier n’est pas un JSON lisible.

### src/lib/import/sms.ts
- String.fromCodePoint(parseInt(code, 16))) .replace(/&lt;/g, '
- Le nom du propriétaire du téléphone n’a pas été donné : les messages envoyés depuis cet appareil resteront sans auteur nommé.
- Depuis cet appareil
- Sur Android, avec l’application gratuite « SMS Backup & Restore » : Sauvegarder → seulement les Messages → enregistrer en XML. Choisissez si possible la conversation concernée plutôt que tout le téléphone.

### src/lib/livre.ts
- Raconté par ${recit.narrateur.nom}, noté par ${auteur}
- Raconté et noté par ${auteur}

### src/lib/local-transcription.ts
- Environ 80 Mo à télécharger une fois. Convient à un enregistrement court et net.
- Environ 250 Mo à télécharger une fois. Plus lent, plus fidèle aux voix hésitantes.

### src/lib/questions.ts
- C’était quand ?
- Et après, qu’est-ce qui s’est passé ?

### src/lib/secrets.ts
- FAMILY_TOKEN_SECRET absent ou laissé à sa valeur de développement. 
- Cette clé signe tous les accès familiaux : sans elle, les cookies de 
- FAMILY_TOKEN_SECRET fait ${configured.length} caractères ; il en faut au moins ${MIN_SECRET_LENGTH}.
- DATABASE_URL absent : le serveur ne peut joindre aucune mémoire.

### src/lib/sections.ts
- Trois récits à lire à voix haute quand la famille est réunie.
- Tout ce qui a été gardé, du plus récent au plus ancien.
- À mettre au propre
- Les enregistrements transcrits, à relire avant de les garder.
- Les photos, les documents, les enregistrements.
- Ce qui revient chaque année, et qu’on ne veut pas perdre.
- Les personnes, les lieux, les objets — et ce qui se dit de chacun.
- Tout ce qui a été gardé, composé pour le papier — avec ce qui manque.
- Ici, la famille ${famille} se raconte.
- Quelqu’un dit une chose. Quelqu’un d’autre ajoute la sienne. Quand il y en a assez, cela devient un récit qui reste.
- Rien à rédiger : personne n’écrit de mémoires ici. Une phrase suffit, et elle peut être dite à voix haute.
- Dites une première chose
- La famille se parle peut-être déjà ailleurs — dans un groupe WhatsApp, où tout défile et où personne ne retrouve rien.

### src/lib/storage.ts
- Clé de stockage invalide
- Sur un hébergement éphémère, elles seront perdues au redéploiement.

### src/lib/transcription-consensus.ts
- Les deux transcriptions coïncident mot pour mot. Une écoute reste recommandée.

### src/lib/transcription-doubt.ts
- Phrase que le modèle produit sur les silences — jamais prononcée
- Le modèle était peu sûr de lui sur ce passage
- Texte anormalement répétitif — le modèle a pu boucler
- Le modèle estime qu’il n’y avait probablement pas de parole ici
- Identique au segment précédent

### src/lib/validation.ts
- La date de décès ne peut précéder la naissance.
- Format attendu : MM-JJ
- Une tradition annuelle exige monthDay (MM-JJ).
- Une tradition hebdomadaire exige weekDay (0-6).

### src/lib/whatsapp.ts
- Les messages sont chiffrés de bout en bout.
- Lucas a rejoint le groupe
- Lucas joined the group
- Claire a changé le sujet
- Claire changed the subject
- Ce message a été supprimé
- Le code de sécurité a changé
- WhatsApp n’indique pas le fuseau horaire : les heures sont celles du téléphone qui a exporté. Les dates restent justes.
- Dans WhatsApp : ouvrez la discussion de famille, puis « Exporter la discussion », puis « Sans les médias ». Vous obtenez un fichier .txt.

### src/services/import.service.ts
- Fichier illisible.
- Ce fichier n’est pas un export Héritage.
- Export sans famille.
- Export sans aucun membre.
- Membre sans nom

### src/services/llm-operator.service.ts
- Classe ce texte familial dans UNE SEULE catégorie parmi : ${STRUCTURE_TYPES.join(
- Voici ce que des membres d

### src/services/metrics.service.ts
- Aucun récit n’en a encore engendré un autre : il n’y a pas de délai à mesurer.

### src/services/passeur.service.ts
- « ${story.title} » raconte un fait sans en donner la raison. Quelqu
- Ce récit dit : « ${fragment} » — sans dire pourquoi.
- « ${story.title} » n
- Aucune lecture enregistrée depuis la création de ce récit.
- « ${story.title} » a été raconté il y a ${years} ans. Qu
- Le temps a passé depuis la création de cette histoire (${years} ans).
- à propos de ${thread.entity.name}
- « ${question.body} »

### src/services/thread.service.ts
- Je m’en souviens
- Je ne savais pas
- Fil introuvable dans cette famille.
- Membre anonymisé

### src/services/tradition.service.ts
- L’application a cessé de la proposer après ${SLEEP_AFTER_MISSED_YEARS} ans sans occasion notée.

### src/services/transcription.service.ts
- Enregistrement introuvable.
- Enregistrement trop long pour être transcrit (max 25 Mo).
- Fichier audio introuvable dans le stockage.
- Erreur inconnue.
- Aucune clé OpenAI configurée.

### src/services/trigger-model.service.ts
- Cette tradition familiale est associée au ${monthDay}.
- Date de naissance enregistrée : ${isoDay(member.birthDate)}.
- Il y a ${yearsSince} ${plural(yearsSince, 
- Date de décès enregistrée : ${isoDay(member.deathDate)}.
- Il y a ${years} ${plural(years, 
- Date de création de l
- La mémoire de la famille ${family?.name ?? 
- Aucun événement temporel aujourd

### src/services/veillee.service.ts
- Personne ne l
- Il relie ${liens} personnes, lieux ou objets de la famille — comme d

### src/workers/transcribe.worker.ts
- Promise
- Chargement du moteur…
- Préparation du moteur (${device})…
- Téléchargement du moteur (une seule fois)…
- Transcription en cours…
- Transcription locale impossible.
