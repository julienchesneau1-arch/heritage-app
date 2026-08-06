# Ce qu'il reste pour que l'application soit utilisable de bout en bout

Écrit le 5 août 2026. Deux listes : **ce que je fais**, et **ce que vous
seul pouvez faire**. Les deux sont nécessaires ; la seconde est plus courte
et elle bloque la première.

---

## A. Ce que vous devez faire — pour que ce soit en ligne et testable

### A1. Un enregistrement DNS *(5 minutes, bloquant)*

Sur la page Hostinger, dans le DNS de votre domaine :

| Type | Nom | Valeur |
|---|---|---|
| A | `memoire` (ou le sous-domaine de votre choix) | l'IP du VPS |

**Ne touchez pas à l'enregistrement de savore.** La propagation prend de
quelques minutes à une heure.

### A2. Relancer l'installateur *(2 minutes)*

```bash
cd /opt/heritage
git pull
DOMAINE=memoire.<votre-domaine> ./installer-a-cote.sh
```

Il refuse de démarrer si le nom ne résout pas encore — attendez la
propagation plutôt que de forcer. Il obtiendra le certificat, et **ne dira
« https » que s'il l'a réellement obtenu**.

### A3. Les deux tâches planifiées *(2 minutes)*

```bash
crontab -e
```

```cron
# Sauvegarde : base + archives, trente jours sur place.
0 3 * * * cd /opt/heritage && ./sauvegarde.sh >> /var/log/heritage-backup.log 2>&1

# Traitement des transcriptions en attente (voir A4 : inutile sans clé).
*/10 * * * * curl -fsS -X POST -H "x-worker-secret: $(grep TRANSCRIPTION_WORKER_SECRET /opt/heritage/.env | cut -d= -f2)" http://127.0.0.1:8081/api/transcriptions/process >/dev/null
```

Sans la première, une panne de disque emporte cinquante ans de mémoire.
C'est la seule ligne de ce document que je qualifierais d'urgente.

### A4. Une décision : la transcription *(à trancher, non bloquant)*

Deux chemins, et ils ne s'excluent pas.

**Le chemin gratuit — dans le navigateur du relecteur.** Aucune clé, aucun
coût, aucune durée maximale. Le relecteur ouvre le brouillon, clique, son
navigateur télécharge le modèle une fois (~80 Mo) puis transcrit sur sa
machine. **Je n'ai jamais pu le tester** : la bibliothèque et le modèle
viennent de jsDelivr et Hugging Face, tous deux inaccessibles depuis mon
environnement de développement — comme Docker Hub, qui avait causé la
panne du premier déploiement. C'est aujourd'hui **le plus gros inconnu du
produit**, et le premier test que je vous demanderai de faire.

**Le chemin payant — l'API.** Ajoutez `OPENAI_API_KEY=` dans
`/opt/heritage/.env` puis `docker compose up -d`. Compter environ 0,006 $
la minute d'audio. Le cron de A3 traite alors les brouillons tout seul.

Mon conseil : **ne mettez pas de clé tout de suite.** Testez d'abord le
chemin gratuit et dites-moi ce qui se passe. S'il marche, il est meilleur
sur tous les plans — coût, durée, confidentialité.

### A5. Fonder votre famille *(10 minutes)*

`https://<votre-domaine>/commencer`. Le lien personnel rendu à la fin est
**le seul qui autorise à supprimer** : gardez-le.

Puis, sur `/famille`, ajoutez les autres et **distribuez leurs liens
personnels**. Ce n'est pas du confort : tant qu'une seule personne en
détient un, la famille a un point de défaillance unique — c'est aussi le
plan de succession du lien familial.

**Ne lancez pas le seed** : il charge la famille Martin de démonstration.

---

## B. Ce que je fais — pour que rien ne soit à moitié

### B1. Fermer la boucle de l'entretien *(le plus important)*

Aujourd'hui : on enregistre, un brouillon apparaît, le relecteur le
transcrit et le valide. Trois manques :

- **L'écran du relecteur ne dit pas qui a parlé, ni à quelle question.**
  Le modèle porte `spokenById` et `promptText` depuis la migration ; la
  page les ignore. Un texte relu sans son énoncé est une réponse sans
  question.
- **Le narrateur du récit issu d'un entretien** doit être celui qui a
  parlé, jamais le relecteur. La règle §2.3 existe ; l'automatisme non.
- **Le brouillon détruit par la voix** doit disparaître de la liste du
  relecteur sans lui dire ce qui a été retiré.

### B2. Le geste de suspension

La décision est prise et le modèle est en base (`suspendedAt`,
`suspendedForId`), mais **rien à l'écran**. Il manque :

- sur un récit, « demander la suspension » à qui s'estime concerné ;
- pour l'auteur, la demande reçue et le choix — suspendre, ou non ;
- le filtrage : pages, recherche, Passeur, veillée, graphe, livre — et
  **présence dans l'export**, qui est la moitié de la décision.

### B3. Les demandes portées, affichées au bon moment

`demandesPortees()` existe et est testé. Rien ne l'appelle. Une réserve
portée doit s'afficher **au moment où quelqu'un écrit sur le sujet**, dans
les mots de son auteur — et l'application laisse écrire.

### B4. Finir l'habillage

Quatre écrans ont leur traitement (premier jour, Passeur, récit, veillée).
**Onze l'attendent** : le fil, le graphe, l'import, la page Famille, la
reddition de comptes, les brouillons, l'entretien, la liste des récits,
« Raconter », les archives, les traditions. Ils héritent des jetons — ils
sont cohérents, pas composés.

L'entretien mérite son aplat en premier : c'est l'écran le plus contraint
du produit, et le seul qu'on utilisera peut-être debout, à côté de
quelqu'un.

### B5. Les trois vérifications que je n'ai jamais pu faire

- **La transcription locale dans un vrai navigateur** (voir A4). Le seul
  moyen est que vous l'essayiez.
- **Le pilote S3/R2 contre un vrai bucket.** Le code est écrit, les tests
  portent sur le pilote, jamais sur le service distant. Sans lui, les
  photos et enregistrements vivent sur le disque du VPS — ce qui est
  acceptable tant que la sauvegarde de A3 tourne.
- **Un audit d'accessibilité automatisé.** Les contrastes sont désormais
  calculés (`tests/contraste.test.ts`), mais la navigation au clavier,
  l'ordre de tabulation et les rôles ARIA sont vérifiés à la main.

### B6. Ce que je ne ferai pas sans vous le demander

- Toucher à l'audio d'un récit (« Écouter Robert le raconter ») : c'est
  une fonctionnalité nouvelle, pas de l'habillage.
- Étendre les marques aux récits : décision de modèle.
- Réduire les 33 types de structure : j'ai un soupçon, pas une donnée.

---

## C. Dans quel ordre, et pourquoi

| | Quoi | Qui | Pourquoi maintenant |
|---|---|---|---|
| 1 | DNS + certificat | vous | Rien ne se teste tant que ce n'est pas en ligne, et une mémoire ne se sert pas en clair. |
| 2 | Sauvegarde en cron | vous | Une panne de disque avant la première sauvegarde efface tout. |
| 3 | Fermer la boucle de l'entretien | moi | C'est la fonctionnalité qu'on vient de construire ; à moitié, elle ne sert personne. |
| 4 | Essayer la transcription locale | vous | Le plus gros inconnu du produit. |
| 5 | Suspension + demandes portées | moi | La décision est prise, le modèle est là ; sans écran, elle n'existe pas. |
| 6 | Habillage des onze écrans | moi | Cohérent mais inachevé. |
| 7 | Audit d'accessibilité | moi | À faire une fois la forme stabilisée, sinon c'est à refaire. |

---

## D. L'état réel, sans arrondi

**Ce qui marche et que j'ai vérifié** : créer une famille, ses membres,
les deux niveaux de liens et leurs révocations, écrire un récit, ouvrir un
fil, marquer, retirer ses mots, la veillée, le graphe centré, les
traditions, l'import WhatsApp/Messenger/SMS, le calendrier `.ics` avec son
retrait individuel, l'export et la restauration, le livre imprimable, la
reddition de comptes, l'enregistrement d'un entretien, la réserve.

**Ce qui marche mais n'a jamais servi à personne** : tout le reste de cette
liste. Aucune famille réelle n'a utilisé cette application. C'est la seule
phrase de ce document qui vaut plus que les autres.

**Ce qui n'existe pas encore** : la suspension à l'écran, l'affichage des
demandes portées, l'identité de la voix sur l'écran du relecteur.

**Ce que je n'ai pas pu vérifier** : la transcription locale, le stockage
distant, l'accessibilité automatisée.
