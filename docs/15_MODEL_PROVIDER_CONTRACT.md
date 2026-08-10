# 15 — CONTRAT DE FOURNISSEUR DE MODÈLE

**Foundation 2.2 — spécification. Non implémenté.**

Référence : mandat Foundation 2.2 §3, ADR-016, `docs/11 §2`.

---

## 1. La propriété visée

> **Le contrat d'interface appartient à Jarvis. Les modèles sont des
> fournisseurs interchangeables.**

Si demain OpenAI double ses prix, Anthropic devient indisponible, un modèle
local devient meilleur, ou un nouveau modèle libre sort — **on change
l'implémentation, pas Jarvis**.

L'audit `docs/11 §2` a établi que cette propriété est aujourd'hui `UNVERIFIED` :
13 interfaces, **zéro implémentation**. Rien n'a jamais été remplacé, donc rien
ne prouve que ce soit possible.

Ce document définit ce qui doit être vrai pour que ce ne soit plus une
supposition.

---

## 2. Un catalogue de capacités, pas un catalogue de modèles

Le piège nommé par le mandat, et il est réel :

> Je ne veux surtout pas « 17 modèles + 42 routes + benchmark permanent ».

Le noyau ne connaît donc jamais un modèle. Il connaît des **capacités** :

```text
FAST_LOCAL          classification, extraction, intention — quelques ms
LOCAL_REASONING     raisonnement court, résumé — local
CLOUD_REASONING     raisonnement long, documents volumineux
VISION_LOCAL        lecture d'image sur l'appareil
VISION_CLOUD        analyse d'image distante
VOICE_REALTIME      transcription et synthèse à faible latence
EMBEDDING_LOCAL     vecteurs pour la voie sémantique
```

Sept capacités, pas dix-sept modèles. Un fournisseur **déclare** celles qu'il
sert ; le routeur choisit une capacité, jamais un nom de produit.

**Conséquence directe :** aucune chaîne `'gpt-4'`, `'claude-…'` ou `'llama…'`
ne doit apparaître hors de `src/providers/`. C'est déjà vérifié
mécaniquement pour les paquets (`contracts/provider-isolation`) ; la même règle
doit s'étendre aux identifiants de modèles.

---

## 3. L'interface

```ts
interface ModelProvider {
  readonly id: string;                       // « ollama-qwen3 », jamais dans le noyau
  readonly capabilities: readonly Capability[];

  /** Coût et latence ANNONCÉS, pour le routeur. Jamais une promesse. */
  readonly profile: {
    readonly costPerMTokenEur: number;       // 0 pour un modèle local
    readonly typicalLatencyMs: number;
    readonly runsLocally: boolean;           // détermine l'éligibilité (docs/14)
  };

  health(): Promise<Result<ProviderHealth>>;

  classify(input: ClassifyRequest): Promise<Result<Classification>>;
  extract(input: ExtractRequest): Promise<Result<Extraction>>;
  reason(input: ReasonRequest): Promise<Result<Reasoning>>;
  summarize(input: SummarizeRequest): Promise<Result<Summary>>;
}
```

Quatre verbes, et le choix de les séparer n'est pas cosmétique :

| Verbe | Pourquoi il est distinct |
|---|---|
| `classify` | sortie **fermée** — une valeur parmi N. Validable exactement. |
| `extract` | sortie **structurée** — schéma connu. Validable par Zod. |
| `summarize` | sortie **ouverte mais bornée** par la source. Vérifiable par recoupement. |
| `reason` | sortie **ouverte**. La moins vérifiable, donc la plus surveillée. |

Un `chat()` générique aurait été plus simple à écrire et **impossible à
gouverner** : le Policy Gate ne saurait pas quoi durcir, et le Verification
Engine n'aurait rien à recouper.

---

## 4. Quatre règles non négociables

### R1 — La sortie d'un fournisseur est `MODEL_OUTPUT`

Jamais `SYSTEM`, jamais `USER`. C'est ADR-024, et c'est déjà appliqué :
`provenanceOf('MODEL_INFERRED') === 'MODEL_OUTPUT'`, membre des provenances non
fiables. L'adaptateur ne peut pas en décider autrement — la provenance est
posée par le noyau, pas déclarée par le fournisseur.

### R2 — Le fournisseur ne voit que le contexte minimal nécessaire

Il ne reçoit **jamais** l'ensemble de la mémoire. Il reçoit ce que la requête
exige, classé et filtré selon `docs/14`. Une donnée `SENSITIVE` n'atteint aucun
fournisseur non local, quel que soit son coût ou sa disponibilité.

### R3 — Aucun fournisseur ne choisit son propre niveau d'autorisation

Il peut **signaler** qu'une requête dépasse sa capacité. Il ne peut pas décider
d'escalader. La décision appartient au routeur, qui applique la classification,
puis la politique, puis le budget — dans cet ordre (`docs/14 §4`).

### R4 — Un fournisseur indisponible ne dégrade jamais la confidentialité

> Un modèle non autorisé n'existe pas comme repli.

Le comportement correct est une phrase, pas une escalade :

> « Le moteur local est indisponible. Je n'envoie pas ce document à un service
> externe. »

---

## 5. Ce que le contrat exige de tout adaptateur

| Obligation | Pourquoi |
|---|---|
| Valider **toute** sortie par Zod avant de la rendre | une réponse de modèle est une entrée non fiable (S1) |
| Rendre un `Result` typé, jamais lever | `06` — les erreurs sont des valeurs |
| Ne jamais écrire de secret dans un log | S3 |
| Déclarer honnêtement `runsLocally` | c'est la clé d'éligibilité de `docs/14` |
| Résister à une réponse vide, tronquée, ou en double | `docs/17` |

La quatrième mérite une garde structurelle. Un adaptateur qui mentirait sur
`runsLocally` contournerait toute la classification — même famille de défaut
que `attemptVerification` (ADR-027), et même réponse : **le déclarer, puis le
vérifier, plutôt que de faire confiance.**

Vérification proposée : à l'enregistrement, un adaptateur `runsLocally: true`
dont l'implémentation importe un module réseau est refusé. Mécaniquement
faisable — c'est la même analyse d'imports que
`contracts/provider-isolation`.

---

## 6. Ce que ce contrat ne résout pas

- **La qualité.** Deux fournisseurs conformes peuvent produire des sorties de
  valeur très différente. Le contrat garantit la substituabilité **technique**,
  pas l'équivalence. C'est l'objet du banc `ops/bench`.
- **La latence.** `typicalLatencyMs` est déclaré, donc invérifiable a priori.
- **Le comportement sous injection.** Un fournisseur peut céder à une injection
  et rendre une sortie hostile. C'est prévu : sa sortie est `MODEL_OUTPUT`,
  donc non fiable par construction (M2 dans `docs/13`).

---

## 7. Tests exigés avant de considérer ce contrat acquis

1. **Deux adaptateurs, un seul noyau** : la même suite passe avec le
   fournisseur A puis avec le fournisseur B, sans qu'une ligne de `src/core/`
   change. C'est le seul test qui prouve réellement la substituabilité ;
2. aucun identifiant de modèle hors de `src/providers/` — extension du test
   d'isolation existant ;
3. une sortie de fournisseur invalide (JSON tronqué, champ manquant) produit un
   `Result` d'erreur, jamais une exception ;
4. une donnée `SENSITIVE` n'atteint aucun fournisseur `runsLocally: false` ;
5. tous les fournisseurs autorisés indisponibles → **refus**, jamais escalade ;
6. la sortie d'un fournisseur porte `MODEL_OUTPUT` et ne peut pas alimenter un
   paramètre sensible sans confirmation — **déjà vérifié**
   (`redteam/fail-closed`).

Le test 1 est le seul qui compte vraiment. Tant qu'il n'existe pas,
l'indépendance aux modèles reste `UNVERIFIED` — et doit être écrite comme
telle.
