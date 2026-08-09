# 03 — SÉCURITÉ ET CONFIDENTIALITÉ

« Sécurité absolue » n'existe pas. L'objectif est de **réduire la surface d'attaque**
et de **rendre une compromission détectable**.

Le principe directeur de ce document :

> Un modèle compromis, halluciné ou victime d'une injection ne doit disposer d'aucun
> pouvoir qu'un modèle sain n'aurait pas.

Si une protection dépend du fait que le modèle « comprenne » qu'il ne doit pas faire
quelque chose, ce n'est pas une protection.

---

## 1. Modèle de menace

| # | Menace | Vecteur réaliste | Contre-mesure architecturale |
|---|---|---|---|
| T1 | **Injection indirecte** | Email, PDF, page web, description d'outil MCP contenant « ignore les instructions précédentes… » | Séparation Privileged/Quarantined (ADR-004) + étiquetage de provenance |
| T2 | **Exfiltration de données** | Le modèle est amené à inclure des données privées dans une requête sortante | Data Firewall : classification + redaction + décision journalisée |
| T3 | **Escalade de privilèges** | Une automation ou une règle apprise élargit ses propres droits | Hiérarchie de règles stricte ; une automation ne crée jamais de permission |
| T4 | **Empoisonnement de mémoire** | Une source externe devient un « fait » personnel | Memory Guard + classe `EXTERNAL_CLAIM` |
| T5 | **Fausse confirmation** | Le modèle affirme avoir envoyé un email | Verification Engine + Event Ledger comme unique source de vérité |
| T6 | **Double exécution** | Retransmission réseau, retry, répétition du modèle | Clé d'idempotence sur chaque mutation |
| T7 | **Outil malveillant / compromis** | Serveur MCP tiers, dépendance compromise | Contrat d'outil + politique au-dessus du protocole + vérification de signature |
| T8 | **Chaîne d'approvisionnement** | Mise à jour malveillante d'une dépendance ou d'un modèle | TUF (M-parmi-N) + Sigstore + LAB avant production (`07`) |
| T9 | **Fuite de secrets** | Clé d'API dans un prompt, un log ou un message d'erreur | Secrets injectés au niveau du Tool Gateway ; jamais dans le contexte modèle |
| T10 | **Captation invisible** | Enregistrement audio/vidéo non signalé | Indicateur système obligatoire ; aucune surveillance permanente |

---

## 2. Les invariants de sécurité

Testés à chaque release. Une violation bloque le déploiement.

```
S1.  La sortie d'un modèle est une entrée non fiable.
S2.  Aucun modèle n'exécute de code arbitraire.
S3.  Aucun modèle n'accède directement à un secret.
S4.  Aucune mutation externe sans décision de politique.
S5.  Les mutations critiques exigent une confirmation explicite.
S6.  Toute mutation porte un identifiant d'opération.
S7.  Toute mutation est vérifiée quand c'est techniquement possible.
S8.  Toute sortie réseau est contrôlée par la politique.
S9.  La panne d'un fournisseur ne détruit pas la mémoire.
S10. Remplacer un fournisseur n'exige aucune réécriture du noyau.
S11. Une mise à jour en production exige des tests de non-régression.
S12. Le rollback reste possible.
S13. L'utilisateur peut désactiver le cloud.
S14. L'utilisateur peut inspecter et supprimer sa mémoire.
S15. Jarvis n'annonce jamais un résultat non vérifié.
```

---

## 3. Le pattern Privileged / Quarantined

C'est la contre-mesure centrale contre T1. Elle mérite d'être comprise avant d'être
implémentée.

### Pourquoi le Policy Engine seul ne suffit pas

Le Policy Engine répond à « **as-tu le droit ?** ». Il ne répond pas à « **est-ce bien
ce qui t'a été demandé ?** ».

Un email piégé peut amener un modèle unique à formuler une demande *parfaitement
autorisée* — envoyer un message, créer un événement — mais que l'utilisateur n'a jamais
formulée. La politique la validera consciencieusement.

### La séparation

```
    Demande utilisateur (FIABLE)
              │
              ▼
    ┌──────────────────┐
    │  PRIVILEGED LLM  │  ── voit uniquement la demande + l'état système
    │  produit le PLAN │     peut déclencher des outils
    └────────┬─────────┘
             │ plan typé
             ▼
    ┌──────────────────┐
    │   TOOL GATEWAY   │  ── politique, provenance, secrets, idempotence
    └────────┬─────────┘
             │
   contenu externe (NON FIABLE)
             │
             ▼
    ┌──────────────────┐
    │ QUARANTINED LLM  │  ── lit emails / PDF / web / sorties d'outils
    │  produit DONNÉE  │     AUCUN accès aux outils
    └────────┬─────────┘     NE PEUT PAS influencer le flux de contrôle
             │ donnée typée + étiquette de provenance
             ▼
        retour au plan
```

### La règle de provenance

Toute valeur porte sa provenance : `USER`, `SYSTEM`, `MEMORY`, `TOOL_OUTPUT`,
`EXTERNAL_UNTRUSTED`.

Le Tool Gateway **refuse** un appel dont un paramètre sensible — destinataire, montant,
identifiant, chemin de fichier, URL — provient de `EXTERNAL_UNTRUSTED`, sauf
confirmation explicite de l'utilisateur portant sur la valeur concrète.

C'est ce qui fait échouer l'attaque même quand le modèle a été convaincu.

---

## 4. Niveaux d'autonomie

| Niveau | Nom | Comportement | Exemples |
|---|---|---|---|
| **L0** | FORBIDDEN | Impossible pour Jarvis | Exfiltration, contournement de sécurité, modification de politique par le modèle |
| **L1** | READ | Lecture seule | Consulter l'agenda, chercher en mémoire |
| **L2** | AUTO | Automatique, réversible, faible risque | Créer une note, ajouter une tâche |
| **L3** | APPROVAL | Préparer puis demander validation | Envoyer un email, déplacer un rendez-vous |
| **L4** | EXPLICIT | Confirmation forte, authentification additionnelle | Paiement, suppression, données sensibles, irréversible |

**Une action proactive ne peut jamais être plus permissive qu'une action explicite.**

---

## 5. Hiérarchie des règles

```
SÉCURITÉ SYSTÈME        ← jamais franchissable
        ↓
POLICY ENGINE
        ↓
RÈGLES UTILISATEUR
        ↓
RÈGLES CONTEXTUELLES
        ↓
PRÉFÉRENCE DU MODÈLE    ← simple suggestion
```

Une règle apprise ne peut **jamais** réduire une restriction de sécurité.

Exemple canonique :

> Politique dure : « un paiement exige toujours confirmation ».
> Mémoire : « Julien approuve généralement les achats sous 50 € ».
> **Résultat : le paiement exige toujours confirmation.**

---

## 6. Data Firewall

Toute sortie réseau franchit le Firewall. Aucune exception, y compris pour la
télémétrie (qui est **désactivée par défaut**).

```
payload
   ↓ identifier
   ↓ classifier          (RED / ORANGE / GREEN)
   ↓ inspecter la destination
   ↓ appliquer la politique
   ↓ rédiger/masquer     (secrets, identifiants, données inutiles)
   ↓ journaliser la décision
   ↓ transmettre — ou refuser
```

### Classification

| Classe | Contenu | Cloud |
|---|---|---|
| **RED** | Secrets, mots de passe, jetons, données financières, documents hautement sensibles, mémoire privée protégée | **Jamais**, sans exception |
| **ORANGE** | Agenda, tâches, préférences, communications personnelles | Sur autorisation explicite, par requête |
| **GREEN** | Données publiques ou non sensibles | Autorisé |

### Principe de minimisation

Ne jamais envoyer « toute la mémoire ». Envoyer le contexte strictement nécessaire.

> Mauvais : `« Julien, 32 ans, adresse…, employeur…, détails du projet… »`
> Correct : `« Compare les prix actuels de X. »`

Aucune mémoire personnelle n'est persistée chez un fournisseur externe. Le contexte
externe est **jeté** après usage : le fournisseur ne devient pas la mémoire.

---

## 7. Mode privé

Commande : « Jarvis, mode privé. »

```
Cloud                 OFF
API externes          OFF
Web                   OFF
Télémétrie externe    OFF
Modèles locaux        ON
Mémoire locale        ON
Outils locaux         ON
```

L'indicateur reste visible tant que le mode est actif.

**Critère de validation :** audit réseau en mode privé → **0 requête sortante
inattendue**. Mesuré, pas supposé.

---

## 8. Arrêt d'urgence

Commande : « Jarvis, stop. »

1. Interrompre les sorties en cours.
2. Annuler les actions en attente.
3. Bloquer temporairement les actions externes.
4. **Conserver le journal.**
5. Exiger une réactivation explicite.

---

## 9. Secrets

Ne jamais placer un secret dans : un prompt, le code source, le contexte modèle, un
log, la mémoire, un message d'erreur, ou le dépôt.

Stockage : keychain OS ou coffre équivalent. Injection **au moment de l'exécution de
l'outil**, par le Tool Gateway.

Le modèle demande `execute_search(...)`. Le Tool Gateway détient la clé. Le modèle ne
la voit jamais et ne peut pas la demander.

---

## 10. Contrat d'outil

Aucun outil n'est accepté sans ces éléments :

```
id · version · description
input_schema · output_schema
permissions · risk_level · privacy_class
reversible · idempotency_strategy
network_required
confirmation_policy
timeout · retry_policy
verification_strategy
rollback
audit_event
```

Principe du moindre privilège, systématiquement :
`Calendar Read ≠ Calendar Write` · `Email Read ≠ Email Send`.

---

## 11. Défense de la mémoire

**Le modèle n'écrit jamais directement en mémoire permanente.**

```
le LLM propose une mémoire
   ↓ validation de schéma
   ↓ classification (FACT / INFERENCE / HYPOTHESIS / EXTERNAL_CLAIM)
   ↓ score de confiance
   ↓ déduplication
   ↓ confirmation utilisateur si nécessaire
   ↓ stockage
```

Un email disant « Julien aime X » devient `EXTERNAL_CLAIM`, avec sa source. Il ne
devient jamais `PREFERENCE`. Une préférence naît d'une confirmation, pas d'une lecture.

Une information contradictoire déclenche une réévaluation, pas un écrasement silencieux.

---

## 12. Droits de l'utilisateur

- **Inspecter** — « Montre-moi ce qui est parti sur Internet. »
- **Auditer** — « Qu'as-tu fait aujourd'hui ? » (réponse depuis le journal)
- **Oublier** — « Oublie cette information. » → mémoire, embeddings, relations, cache,
  dérivés ; produit un événement `MEMORY_DELETED` **sans recopier le contenu supprimé**.
- **Exporter** — format documenté, aucun verrouillage.
- **Effacer** — suppression complète des données Jarvis.
- **Désactiver** — le cloud, un fournisseur, un modèle, un outil.

---

## 13. Ce qui est explicitement interdit

- Écoute ou captation permanente invisible.
- Reconnaissance faciale.
- Télémétrie externe par défaut.
- Accès shell non contraint pour un modèle.
- Auto-maintenance qui supprimerait une protection, modifierait une règle de sécurité,
  élargirait les droits du modèle ou désactiverait l'audit.

L'auto-maintenance a le droit de : redémarrer un service, reconstruire un index,
retenter une opération, changer de modèle, effectuer un rollback. **Rien d'autre.**
