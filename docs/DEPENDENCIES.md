# Registre des dépendances

`04 §1` impose qu'une dépendance remplisse sa fiche **avant** d'être ajoutée. Ce
fichier est ce registre. Une dépendance absente d'ici ne doit pas apparaître dans
`package.json`.

Le champ le plus important de chaque fiche est le dernier : **comment on la
remplace**. Une dépendance dont on ne sait pas décrire le remplacement n'est pas
une dépendance, c'est un engagement.

---

## Dépendances d'exécution

### `zod` — 4.4.3

```yaml
raison_d_etre:      Validation à l'exécution sur toutes les frontières du noyau.
pourquoi_pas_natif: TypeScript ne valide rien à l'exécution. ADR-016 impose une
                    validation runtime aux frontières ; l'écrire à la main pour
                    chaque schéma serait plus de code, moins testé, et sans
                    inférence de type.
criticite:          CRITIQUE
licence:            MIT — usage commercial futur : oui
donnees_vues:       Toutes les données franchissant une frontière, en mémoire
                    uniquement. Aucune sortie réseau, aucun accès disque.
acces_reseau:       aucun
maintenance:        Très actif, large adoption, mainteneur principal identifié.
vulnerabilites:     Aucune CVE connue à ce jour.
strategie_maj:      Canal STABLE. Version épinglée, montée après passage des
                    Golden Tests.
fallback:           Aucun automatique. La validation est structurante.
remplacement:       Valibot ou ArkType offrent le même modèle (schéma → type
                    inféré). Le coût est réel mais borné : la surface utilisée
                    se limite à `object`, `enum`, `safeParse` et `infer`. Estimé
                    à 1–2 jours pour l'ensemble du noyau.
```

### `pg` — 8.16.3

```yaml
raison_d_etre:      Pilote PostgreSQL. ADR-001 fait de PostgreSQL l'unique
                    magasin de vérité.
pourquoi_pas_natif: Node n'a pas de client PostgreSQL natif.
criticite:          CRITIQUE
licence:            MIT — usage commercial futur : oui
donnees_vues:       Toute la mémoire personnelle. C'est la dépendance qui voit
                    le plus de données du système.
acces_reseau:       sortant, vers localhost uniquement en configuration par
                    défaut. Aucune connexion distante sans changement explicite
                    de configuration.
maintenance:        Mature, standard de fait depuis plus de dix ans.
vulnerabilites:     Aucune CVE ouverte connue à ce jour.
strategie_maj:      Canal STABLE.
fallback:           Aucun. Sans base, pas de mémoire.
remplacement:       `postgres.js` couvre le même besoin. Notre usage est
                    volontairement confiné à `src/core/db/client.ts` : query,
                    transaction, pool. Estimé à une demi-journée.
```

### `@cedar-policy/cedar-wasm` — 4.12.0

```yaml
raison_d_etre:      Moteur d'évaluation de politique (ADR-005). Répond à « cet
                    acteur a-t-il le droit ? ».
pourquoi_pas_natif: L'autorisation est un domaine où les erreurs subtiles sont
                    coûteuses. Cedar est formellement vérifié ; le réécrire
                    contredirait la règle « assembler avant développer ».
criticite:          IMPORTANTE
                    — pas CRITIQUE : le Gate court-circuite déjà L0, RED+egress
                    et le mode privé avant toute interrogation du moteur. Une
                    panne de Cedar fait échouer l'évaluation, et le refus par
                    défaut s'applique : le système devient inutilisable, jamais
                    permissif.
licence:            Apache 2.0 — usage commercial futur : oui
donnees_vues:       Uniquement le contexte de politique : acteur, action,
                    niveau, classe de confidentialité, mode. Jamais le contenu
                    métier, jamais un secret.
acces_reseau:       aucun (WebAssembly local)
maintenance:        Développé et utilisé par AWS. Communauté plus jeune qu'OPA.
vulnerabilites:     Aucune CVE connue à ce jour.
strategie_maj:      Canal STABLE, avec repassage complet de tests/policy.
fallback:           Refus par défaut. Un moteur indisponible ne dégrade jamais
                    en « autoriser ».
remplacement:       OPA/Rego, prévu par l'ADR-005. L'interface `PolicyEvaluator`
                    est délibérément minimale (une méthode, un verdict) pour que
                    la bascule reste un travail d'adaptateur. Les politiques
                    elles-mêmes seraient à réécrire : compter 2–3 jours.
```

---

## Services externes

Un service n'est pas un paquet : il ne s'installe pas, il se **connecte**. Sa
fiche est donc plus courte sur la maintenance et beaucoup plus longue sur ce
qu'il voit.

### Ollama — runtime de modèle local

```yaml
raison_d_etre:      Comprendre une formulation LIBRE. Les règles `Tier 0`
                    plafonnent à 43 % d'une conversation réelle (ADR-080) ;
                    au-delà, il faut un modèle.
pourquoi_pas_natif: Faire tourner un modèle de langage demande un moteur
                    d'inférence. Aucun n'est écrit ici, et aucun ne le sera :
                    ADR-016 pose des runtimes d'inférence HORS PROCESSUS.
paquet_npm:         AUCUN. L'API est du REST sur HTTP et Node 22 porte `fetch`.
criticite:          NON CRITIQUE, et c'est un invariant. `localModel.enabled`
                    vaut `false` par défaut. I1 et I2 exigent que Jarvis
                    comprenne, mémorise, retrouve et exécute sans fournisseur
                    IA — il comprend moins de formulations, et le DIT.
licence:            Ollama : MIT. Les MODÈLES ont leurs propres licences, à
                    vérifier une par une (`docs/04 §3`). Llama porte des
                    restrictions d'usage commercial ; Mistral et Qwen sont
                    permissifs. Ce choix appartient à Julien.
donnees_vues:       L'énoncé de l'utilisateur et le catalogue d'outils. RIEN
                    d'autre — ni mémoire, ni contenu d'email. Classe maximale
                    déclarée : ORANGE.
acces_reseau:       HTTP vers la BOUCLE LOCALE uniquement, et c'est VÉRIFIÉ.
                    `createOllama` refuse à la construction toute adresse qui
                    n'est pas `localhost` / `127.0.0.1` / `[::1]`.
                    ⚠ Sans cette garde, pointer la configuration ailleurs
                    ferait sortir chaque énoncé de la machine SANS qu'aucune
                    ligne de code ne change, et le fournisseur continuerait de
                    se déclarer « local ».
secrets:            AUCUN. Ollama n'authentifie pas sur la boucle locale — et
                    c'est cohérent : il n'y a pas de tiers à qui prouver son
                    identité.
maintenance:        Projet très actif, API stable depuis 2023.
vulnerabilites:     Aucun code tiers exécuté dans notre processus. Le risque
                    résiduel est qu'Ollama écoute sur `0.0.0.0` — une
                    configuration D'OLLAMA, pas de Jarvis, et hors de notre
                    portée. À signaler dans la documentation d'installation.
strategie_maj:      Aucune à subir : contrat REST distant. Un changement se
                    manifeste par `PROVIDER_TRUST_REVOKED`, jamais par une
                    supposition.
fallback:           `null` → pas de `Tier 1`, retour au `Tier 0` seul. Un refus
                    d'adresse ne fait PAS échouer le démarrage : punir
                    l'utilisateur d'une option corrigeable le laisserait sans
                    assistant du tout.
remplacement:       llama.cpp expose une API compatible OpenAI, MLX tourne
                    nativement sur Apple Silicon (ADR-007 pose le seuil de
                    32 Go). La surface utilisée est minuscule — `/api/chat`,
                    `/api/tags`, `/api/embeddings` — et `ModelProvider` ne
                    mentionne Ollama nulle part. Estimé à 1 jour.
```

---

### Google Calendar API — v3

```yaml
raison_d_etre:      Écrire un rappel LÀ OÙ IL SONNE. L'agenda Google de Julien
                    est déjà synchronisé vers son iPhone ; un événement créé ici
                    déclenche une notification qu'aucun code local ne saurait
                    produire.
pourquoi_pas_natif: Construire un ordonnanceur et un canal de notification
                    iOS serait des semaines de travail pour reproduire ce que le
                    téléphone fait déjà. `CLAUDE.md` règle 4 — assembler avant
                    de développer.
paquet_npm:         AUCUN. L'API est du REST sur HTTPS et Node 22 porte `fetch`.
                    Le paquet officiel `googleapis` apporterait des centaines de
                    dépendances transitives pour quatre requêtes : il ne mérite
                    pas son droit d'exister (`04 §1`).
criticite:          NON CRITIQUE. Jarvis fonctionne entièrement sans — les
                    rappels restent visibles dans le briefing du matin.
licence:            Service, pas logiciel. Conditions Google Cloud Platform.
                    Usage personnel : gratuit dans les quotas courants.
donnees_vues:       Titre, date de début et de fin des événements créés ou lus.
                    Classe maximale déclarée : ORANGE. Une donnée RED ne peut
                    pas l'atteindre — le Policy Gate consulte
                    `maxPrivacyClass` du fournisseur.
                    ⚠ Google voit donc ce que Julien écrit dans son agenda.
                    C'est déjà le cas aujourd'hui : l'intégration n'ajoute
                    aucune exposition, elle en tire parti.
acces_reseau:       HTTPS sortant vers `www.googleapis.com` et
                    `oauth2.googleapis.com`. Aucun autre hôte.
secrets:            Trois, au coffre, JAMAIS dans le dépôt :
                      GOOGLE_OAUTH_CLIENT_ID
                      GOOGLE_OAUTH_CLIENT_SECRET
                      GOOGLE_OAUTH_REFRESH_TOKEN
                    Un test structurel compte les appels à `expose()` : trois,
                    tous dans la construction de la requête de jeton.
maintenance:        API stable depuis 2011, versionnée (`v3`). Google annonce
                    les retraits avec un an de préavis.
vulnerabilites:     Surface propre : aucun code tiers exécuté chez nous.
                    Le risque est la FUITE DE JETON, traitée par le coffre et
                    par l'interdiction de recopier une réponse d'authentification
                    dans un message d'erreur.
strategie_maj:      Aucune mise à jour à subir — c'est un contrat REST distant.
                    Un changement de contrat se manifeste par
                    `PROVIDER_TRUST_REVOKED`, jamais par une supposition.
fallback:           `null`. Sans compte connecté, les outils d'agenda rendent
                    `PROVIDER_UNAVAILABLE` — une réponse, pas une panne. Les
                    rappels continuent d'exister localement et de remonter dans
                    le briefing.
remplacement:       CalDAV est le protocole standard, et Apple, Fastmail,
                    Nextcloud le parlent tous. La surface utilisée ici est
                    minuscule — lister, créer, modifier, relire — et
                    l'interface `CalendarProvider` ne mentionne Google nulle
                    part. Estimé à 2–3 jours pour un adaptateur CalDAV.
                    ⚠ Une propriété serait perdue : l'idempotence par
                    identifiant fourni par le client. CalDAV la permet aussi
                    (l'UID est choisi par le client), donc le coût est réel mais
                    pas structurel.
```

---

## Dépendances de développement

Elles ne s'exécutent jamais en production et ne voient aucune donnée
personnelle. Leur fiche est donc allégée, mais leur licence est vérifiée.

| Paquet | Version | Licence | Rôle | Remplacement |
|---|---|---|---|---|
| `typescript` | 5.9.2 | Apache 2.0 | Compilateur, typage strict | Aucun réaliste — c'est le langage (ADR-016) |
| `vitest` | 3.2.4 | MIT | Lanceur de tests | `node:test` natif ; migration mécanique |
| `eslint` + `typescript-eslint` | 9.36 / 8.44 | MIT / MIT | Application des règles de `06` | Biome ou oxlint |
| `tsx` | 4.20.5 | MIT | Exécution TypeScript pour l'outillage | `node --experimental-strip-types` (Node 22+) |
| `@types/node`, `@types/pg` | — | MIT | Définitions de types | — |
| `@eslint/js` | 9.36 | MIT | Configuration ESLint de base | — |
| `@vitest/coverage-v8` | 3.2.4 | MIT | Mesure de couverture (`pnpm test:coverage`) | `c8`, ou `node --experimental-test-coverage` |

> `@vitest/coverage-v8` a été ajouté pendant la phase d'audit : la question
> « quelle est la couverture ? » ne pouvait pas recevoir de réponse
> reproductible sans lui. Même mainteneur que `vitest`, déjà présent ; aucune
> exécution en production, aucune donnée vue, aucun accès réseau.

---

---

## Phase 5 — la voix (fiches préalables, rien n'est branché)

> ⚠ **CES TROIS FICHES SONT ÉCRITES AVANT TOUTE LIGNE DE CODE**, et c'est le
> sens de `docs/04 §1` : *« toute dépendance doit remplir cette fiche AVANT
> d'être ajoutée »*. Aucune des trois n'est installée, aucune n'est appelée.
>
> Elles sont issues de la comparaison avec `sosoj92/jarvis-assistant-vocal`
> (MIT), qui fait tourner cette pile en production — `CLAUDE.md` règle 4,
> *« assembler avant de développer »*.

### ⚠ CE QUE LA VOIX CHANGE, ET QUI N'EST PAS UNE QUESTION DE DÉPENDANCE

Les trois briques ci-dessous sont permissives, locales et sans réseau. La
décision difficile est ailleurs, et elle doit être prise séparément :

```text
un micro TOUJOURS OUVERT est une capacité nouvelle,
pas une bibliothèque de plus
```

Jusqu'ici, Jarvis ne voit que ce que Julien tape. Après, il entend **tout ce
qui se dit dans la pièce** — y compris ce que disent les gens qui n'ont rien
demandé, et qui ne savent pas qu'un ordinateur écoute.

Le mot d'activation borne ce qui est TRANSCRIT, jamais ce qui est CAPTÉ : la
détection travaille par construction sur un flux continu. C'est une question de
`docs/13` (modèle de menace) et de `docs/03`, pas de `docs/04` — et elle
appartient à Julien, pas à cette fiche.

### `openWakeWord` — détection du mot d'activation

```yaml
raison_d_etre:      « Hey Jarvis » — l'activation de `docs/02` Phase 5. Sans
                    elle, il faut une touche ou une commande pour parler, ce
                    qui annule l'intérêt du mains-libres.
pourquoi_pas_natif: L'alternative naïve — laisser Whisper transcrire en
                    permanence — serait bien pire : elle ferait tourner un
                    modèle lourd 24 h sur 24 ET transcrirait TOUT ce qui se dit
                    dans la pièce. Un détecteur de mot-clé est justement ce qui
                    évite ça : il est minuscule, et il ne produit AUCUN texte.
paquet_npm:         AUCUN. Python + tflite, en PROCESSUS SÉPARÉ (ADR-016 pose
                    les runtimes d'inférence hors processus).
                    ⚠ COÛT RÉEL À NOMMER : cela ajoute un runtime Python à une
                    machine qui n'en avait pas besoin. C'est une dépendance
                    d'environnement, pas seulement de bibliothèque.
criticite:          OPTIONNELLE. Jarvis fonctionne entièrement en texte (I1,
                    I2). La voix est un confort, jamais une fondation.
licence:            Apache 2.0. ✅ usage commercial futur libre.
donnees_vues:       ⚠ LE FLUX MICROPHONE EN CONTINU. C'est la donnée la plus
                    sensible que ce dépôt ait jamais confiée à quoi que ce
                    soit. Classe de fait : RED.
                    Ce qu'il en fait : un score par fenêtre de quelques
                    centaines de millisecondes. Il ne conserve rien, ne
                    transcrit rien, n'écrit rien.
acces_reseau:       AUCUN, une fois les modèles téléchargés. À vérifier par
                    mesure, pas sur parole — le Data Firewall ne voit pas un
                    processus séparé.
secrets:            AUCUN.
maintenance:        Projet actif, communauté restreinte. ⚠ Équipe petite :
                    `docs/04 §4` dit qu'une bibliothèque non maintenue est un
                    risque quelle que soit sa licence. À revoir à chaque revue.
vulnerabilites:     Aucune connue à ce jour. Surface d'attaque réelle : il
                    consomme de l'AUDIO NON FIABLE — c'est-à-dire une entrée
                    hostile possible, au sens de `CLAUDE.md` règle 2. Le
                    processus séparé est la bonne réponse.
strategie_maj:      Épinglée. Une mise à jour de modèle de détection change le
                    taux de faux réveils : c'est un changement de COMPORTEMENT,
                    donc `docs/07 §3`.
fallback:           Activation manuelle — une touche, une commande. Ce qui est
                    perdu est le mains-libres, pas la capacité de parler.
remplacement:       Porcupine (Picovoice) est la référence du domaine, mais sa
                    licence est propriétaire/freemium → ÉCARTÉE par
                    `docs/04 §3`. Sinon : un seuil d'énergie plus une
                    confirmation, nettement moins bon, mais trivial. Estimé à
                    2 jours.
```

### Whisper — transcription locale (le MOTEUR reste à choisir)

```yaml
raison_d_etre:      Transformer la parole en texte, en français, sur la
                    machine. ADR-008 a RATIFIÉ Whisper pour cette raison
                    précise : 99 langues, et l'utilisateur parle français.
pourquoi_pas_natif: L'API de dictée du système transcrit vers ses serveurs
                    selon la configuration, et n'offre aucune garantie
                    vérifiable. `docs/03` exige le contraire.
paquet_npm:         AUCUN. Processus séparé, quel que soit le moteur retenu.
criticite:          OPTIONNELLE. Voir openWakeWord.
licence:            Whisper (modèle) : MIT. ✅
                    `whisper.cpp` : MIT ✅ — `faster-whisper` : MIT ✅
donnees_vues:       ⚠ TOUT CE QUI EST DIT APRÈS L'ACTIVATION. Classe de fait :
                    RED. La transcription est la donnée, pas seulement l'audio.
acces_reseau:       AUCUN après téléchargement du modèle. Même réserve que
                    ci-dessus : à mesurer, pas à croire.
secrets:            AUCUN.
maintenance:        Modèle figé (OpenAI, 2022-2023). Les deux moteurs sont très
                    actifs. Le modèle ne bouge pas : c'est un avantage, pas un
                    abandon.
vulnerabilites:     Aucune connue. Même remarque que ci-dessus sur l'entrée
                    non fiable.
strategie_maj:      Le modèle est épinglé par taille (`base`, `small`…). Changer
                    de taille change la latence ET le taux d'erreur : à mesurer
                    avant, jamais à subir.
fallback:           Saisie texte. C'est le mode NOMINAL du dépôt aujourd'hui.
remplacement:       Les deux moteurs lisent le même modèle : changer d'un à
                    l'autre ne change ni la qualité ni le format. Estimé à
                    1 jour.
```

> ⚠ **ADR-008 A CHOISI UN MOTEUR POUR UN MATÉRIEL QUE JULIEN N'A PAS.**
>
> Elle ratifie *« `whisper.cpp` + Core ML, ou WhisperKit côté Swift »*, et son
> argument est explicitement l'**Apple Silicon** : l'export de l'encodeur vers
> le Neural Engine.
>
> La machine cible est un **MacBook Pro 13" 2019, Intel Core i5** : ni ANE, ni
> accélération Core ML utile. L'argument qui a fondé la décision **ne s'applique
> pas**, et personne ne l'avait remarqué parce que le matériel n'avait jamais
> été nommé.
>
> Ce n'est PAS une raison de changer de moteur sur-le-champ. C'est une raison
> de poser le critère honnêtement :
>
> | | `whisper.cpp` | `faster-whisper` |
> |---|---|---|
> | langage | C++ | Python + CTranslate2 |
> | runtime ajouté | **aucun** | **Python** |
> | choisi par ADR-008 | oui | non |
> | employé par `sosoj92` | non | oui, en production |
>
> **Le seul critère établi sans mesure est architectural** : `whisper.cpp`
> n'ajoute pas de runtime Python. Tout le reste — latence, WER français sur
> CPU Intel — demande un banc, et ce dépôt ne publie pas d'estimation déguisée
> en mesure.
>
> Si openWakeWord est retenu, Python entre de toute façon, et cet unique
> critère tombe. **Les deux décisions sont donc liées, et doivent être prises
> ensemble.**

### `Piper` — synthèse vocale locale

```yaml
raison_d_etre:      Répondre à voix haute. ADR-009 l'a DÉJÀ retenu, avec Kokoro,
                    au terme d'une sélection où la licence était un critère.
pourquoi_pas_natif: La voix système est acceptable et disponible ; elle est
                    retenue comme FALLBACK. Piper donne une voix française
                    stable, hors ligne, identique d'une machine à l'autre.
paquet_npm:         AUCUN. Binaire autonome, processus séparé.
criticite:          OPTIONNELLE. Une réponse affichée reste une réponse.
licence:            MIT. ✅ (XTTS v2 est EXCLU pour licence CPML — ADR-009.)
donnees_vues:       ⚠ LE TEXTE QUE JARVIS PRONONCE, qui peut contenir n'importe
                    quelle donnée personnelle. Classe de fait : RED.
                    ⚠ ET UN EFFET QUE LE DÉPÔT N'A JAMAIS EU : prononcer, c'est
                    DIFFUSER. Une réponse lue à voix haute est entendue par
                    quiconque est dans la pièce. Aucun Policy Gate ne couvre
                    aujourd'hui « qui d'autre écoute ».
acces_reseau:       AUCUN. Modèle de voix local.
secrets:            AUCUN.
maintenance:        Actif, adossé au projet Home Assistant — un utilisateur
                    institutionnel, ce qui vaut mieux qu'une étoile GitHub.
vulnerabilites:     Aucune connue. N'ingère aucune donnée externe : il ne lit
                    que du texte produit par Jarvis.
strategie_maj:      Voix épinglée. Changer de voix change le produit perçu.
fallback:           Affichage texte, déjà le mode nominal du CLI.
remplacement:       Kokoro (Apache 2.0, 82 M, français, qualité supérieure,
                    plus lourd) — le second candidat d'ADR-009, qui laissait
                    l'arbitrage « à mesurer, pas à décréter ». Ou la voix
                    système. Estimé à 1 jour.
```

### Ce que ces trois fiches NE disent pas

**Aucune n'a tourné sur la machine de Julien.** Piper est réputé léger sur CPU ;
Whisper ne l'est pas, et un Intel de 2019 sans accélération est le cas
défavorable. Trois nombres manquent, et aucun ne s'estime :

```text
?  latence de transcription d'une phrase de 5 s
?  taux de faux réveils sur une journée réelle
?  charge CPU d'un micro ouvert en permanence
```

Le premier se mesure en dix minutes le jour où la pile est installée. Les
autres demandent des jours d'usage.

---

## Ce qui a été délibérément écarté

Ces décisions sont aussi importantes que les ajouts : chacune évite une
dépendance qu'il aurait ensuite fallu maintenir.

| Écarté | Au profit de | Raison |
|---|---|---|
| Un ORM (Prisma, Drizzle) | SQL et `pg` | Le schéma est petit et stable. Un ORM ajouterait une couche de génération, un cycle de migration parallèle au nôtre, et masquerait les `GRANT` — précisément ce qui garantit l'immuabilité du journal (ADR-012). |
| Une bibliothèque de migrations | ~150 lignes maison | Nous avons besoin d'un rollback testé dans les deux sens et d'un checksum détectant l'édition d'une migration appliquée. C'est exactement ce que fait `ops/db/migrate.ts`. |
| Un logger (pino, winston) | ~90 lignes maison | La redaction des secrets est le cœur du besoin (03 §9), pas la performance d'écriture. Une redaction déléguée à une configuration tierce est une redaction qu'on ne teste pas. |
| Une base vectorielle dédiée | pgvector dans PostgreSQL | ADR-001. |
| XTTS v2 | Piper, Kokoro | Licence CPML non commerciale (ADR-009, 08/C5). |
| Porcupine (Picovoice) | openWakeWord | Référence du domaine pour le mot d'activation, mais licence propriétaire/freemium → interdite au cœur du produit par `docs/04 §3`. Même raisonnement que XTTS v2 : une licence qui ne pose aucun problème jusqu'au jour où le projet devient autre chose. |
| Transcription permanente | mot d'activation | Laisser Whisper tourner en continu éviterait une dépendance et en coûterait une bien pire : TOUT ce qui se dit dans la pièce deviendrait du texte. Le détecteur de mot-clé existe précisément pour ne rien transcrire. |
| Un framework d'agents | Notre orchestration | 00 §6 : pas de swarm. Ces frameworks supposent tous que le modèle pilote les outils — l'inverse exact d'ADR-004. |
