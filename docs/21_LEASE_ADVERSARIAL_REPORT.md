# 21 — LE BAIL NE MESURE PAS LA VIE

**Foundation 4.1 — épreuve adversariale ciblée.** Résultat : la formulation
centrale d'ADR-032 était fausse, et l'architecture ne prévenait pas le double
effet. Corrigé, mesuré, et une frontière nommée.

---

## 1. Le problème, formulé

ADR-032 affirmait :

> « Ce qui distingue un exécutant mort d'un vivant est le temps. »

C'est faux deux fois.

**Premièrement**, un bail ne mesure pas la vie d'un processus. Il mesure
*depuis combien de temps personne ne l'a renouvelé*. Un processus gelé — pause
du ramasse-miettes, machine virtuelle suspendue, conteneur bridé, appel réseau
bloquant — est vivant et silencieux.

**Deuxièmement**, et c'est le point que je n'avais pas vu : même si le processus
est réellement mort, **sa requête peut encore vivre chez le fournisseur**.

Cinq notions qu'ADR-032 confondait :

```text
PROCESS LIVENESS               le processus tourne-t-il encore ?
LEASE EXPIRATION               le bail a-t-il été renouvelé ?
REQUEST CANCELLATION           le fournisseur a-t-il cessé de traiter ?
EXTERNAL EFFECT                le monde a-t-il changé ?
EXTERNAL EFFECT VERIFICATION   peut-on le CONSTATER, maintenant ?
```

`withTimeout()` côté Jarvis n'établit **aucune** des quatre dernières. Il rend
la main, c'est tout. Le fournisseur, lui, continue.

---

## 2. Le contre-exemple minimal

```text
A envoie sa requête, puis gèle ou meurt
le bail expire — mais la requête vit toujours
B vérifie : le monde est encore VIDE  →  NO_EFFECT
B exécute                             →  EFFET B
la requête de A aboutit enfin         →  EFFET A
                                         ══════════
                                          2 EFFETS
```

Mesuré, avant correction :

```text
B → CONFIRMED replayed=false
EFFETS = 2 : requete-de-B + requete-de-A
```

Et le verdict aggrave le tout : B a annoncé **`CONFIRMED`** — en relisant son
propre effet.

**Aucune observation ne pouvait sauver B.** Au moment où il regarde, il n'y a
rien à voir. Ce n'est pas un défaut de vérification : c'est une limite de
l'observation.

---

## 3. Le défaut qui masquait le premier

La première version de cette épreuve était **verte sur les six scénarios**. Je
ne l'ai pas crue, et j'ai instrumenté :

```text
B → ERR INTERNAL: new row for relation "tool_operations"
    violates check constraint "terminal_states_are_observed"
```

Le rembobinage `UNKNOWN → PLANNED` laissait `observed_at` renseigné. Le chemin
de reprise depuis `UNKNOWN` **n'a donc jamais fonctionné depuis Foundation 3** :
il levait une exception, que `guarded()` transformait en `INTERNAL`.

Mes tests passaient donc **parce que le code plantait avant de pouvoir nuire**.
C'est exactement l'inverse d'une garantie, et c'est la raison pour laquelle un
test vert doit être expliqué avant d'être cru.

Le vrai contre-exemple a dû être construit par le chemin `EXECUTING`, qui, lui,
fonctionnait.

---

## 4. L'invariant définitif

> **L'expiration d'un bail ne constitue jamais une preuve d'absence d'effet
> externe.**
>
> `UNKNOWN` + bail expiré ≠ autorisation de rejeu.

Le bail garde une utilité — libérer une coordination interne, autoriser à
*interroger* — mais il n'autorise plus, à lui seul, une nouvelle exécution
externe.

### `EffectContract`

Le moteur ne demande plus « puis-je réessayer ? », question à laquelle on
répond par optimisme. Il demande « quel contrat d'effet possède cet outil ? ».

| Contrat | `FAILED` possible ? | Rejeu après `UNKNOWN` |
|---|---|---|
| `NO_EXTERNAL_EFFECT` | ✅ | ✅ libre |
| `LOCAL_TRANSACTIONAL` | ✅ le rollback prouve l'absence | ✅ |
| `PROVIDER_IDEMPOTENT` | ❌ | ✅ **avec la même identité** |
| `EXTERNALLY_VERIFIABLE` | ❌ | ❌ peut confirmer, jamais rejouer |
| `UNVERIFIABLE` | ❌ | ❌ `UNKNOWN` définitif |

**Pourquoi `PROVIDER_IDEMPOTENT` est le seul contrat externe rejouable.** Sa
garantie ne dépend pas de notre observation. Même si la requête de A aboutit
dix minutes plus tard, le fournisseur la dédoublonne. C'est la seule
construction qui survit à une requête en vol — parce qu'elle n'essaie pas de la
détecter.

**Pourquoi `EXTERNALLY_VERIFIABLE` ne suffit pas.** Interroger le fournisseur
répond à « existe-t-il un effet **maintenant** ? ». Cela permet `UNKNOWN` →
`CONFIRMED`. Cela ne dit rien de ce qui est en vol.

`mayReplayAfterUnknown()` est une fonction **totale** : ajouter un contrat sans
décider de sa politique de rejeu ne compile pas.

---

## 5. Ce qui est maintenant démontré

`tests/lab/lease-adversarial.test.ts` — six tests.

| Propriété | Résultat |
|---|---|
| Requête en vol + bail expiré → aucune reprise n'exécute | ✅ 1 effet, celui de A |
| 10 reprises simultanées sur une requête en vol | ✅ 1 effet |
| Outil `UNVERIFIABLE` → ne rejoue jamais, `attempts` reste à 1 | ✅ |
| `PROVIDER_IDEMPOTENT` → rejeu autorisé, sans doublon | ✅ 1 effet |
| Fournisseur qui **ment** sur son idempotence | ✅ **2 effets — mesurés** |
| La mise en scène produit réellement un effet tardif (témoin) | ✅ |

Le témoin négatif compte autant que les autres : sans lui, « aucun doublon »
pourrait signifier « rien n'est jamais arrivé ».

### Un piège de test évité

Le scénario `UNVERIFIABLE` échouait d'abord sur mon assertion « le statut reste
`UNKNOWN` sur cinq reprises ». C'était **mon assertion** qui était fausse : une
fois l'effet de A réellement abouti, le constater et dire `CONFIRMED` est
honnête — c'est même le but. La propriété à tester est plus étroite : *aucune
reprise n'exécute*. Assertion corrigée sur `attempts === 1`.

---

## 6. Ce qui reste NON GARANTI

**Le fournisseur qui ment sur son idempotence.** La garantie de
`PROVIDER_IDEMPOTENT` vient d'un tiers. Nous ne pouvons que le croire. Le test
« risque résiduel » met ce cas en scène et **mesure les deux effets** plutôt
que de faire semblant.

**Le multi-machines réel.** Le bail est évalué par la base, donc immunisé à la
dérive d'horloge. Mais l'épreuve tourne sur une machine : la propriété est
argumentée, pas mesurée.

**L'annulation d'une requête en vol.** Aucun mécanisme ne l'offre. Aucune API
grand public non plus. Une requête partie est partie.

**Le repli à nouvelle clé.** Inchangé — le type marqué empêche la faute par
accident, pas la faute délibérée.

---

## 7. La frontière, enfin nommée

```text
┌── JARVIS ──────────────┐
│ politique · mémoire    │
│ vérification · audit   │   ← nos invariants s'appliquent
│ identité d'opération   │
└───────────┬────────────┘
            │  frontière
┌───────────▼────────────┐
│  MONDE EXTÉRIEUR       │   ← nos invariants ne s'appliquent PAS
│  Gmail · Stripe · API  │
└────────────────────────┘
```

Nous ne pouvons pas imposer nos invariants à un fournisseur qui n'en offre
aucun. Ce que l'architecture peut faire — et fait désormais — c'est **détecter
cette frontière et dégrader son autonomie en conséquence** : un effet externe
non idempotent n'est jamais rejoué, et un effet externe non observable n'est
jamais automatique.

L'objectif n'est pas de maximiser le taux d'exécution. C'est de maximiser la
certitude de ce que Jarvis affirme avoir fait.

---

## 8. Ce que ce sprint dit de la méthode

Deux fois de suite, mon erreur n'était pas dans le code mais dans une **phrase**
que j'avais écrite et qui semblait raisonnable :

- Foundation 3 : « le compteur distingue un mort d'un vivant » ;
- Foundation 4 : « le temps distingue un mort d'un vivant ».

Les deux ont produit du code correct au regard de leurs propres tests, et faux
au regard du monde. Les deux ont été corrigées par une mesure, jamais par une
relecture.

Les deux phrases sont **conservées telles quelles** dans les ADR, marquées comme
fausses. Un raisonnement erroné qu'on efface a toutes les chances d'être refait
par le suivant — y compris par moi.
