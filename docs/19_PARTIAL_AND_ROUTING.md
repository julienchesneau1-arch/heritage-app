# 19 — SUCCÈS PARTIEL ET ROUTAGE CONSCIENT DU RISQUE

**Foundation 3 — spécification. Non implémenté.**

Deux normes écrites **avant** le premier outil qui en aurait besoin. C'est le
seul moment où elles coûtent peu.

---

## 1. Pourquoi `PARTIAL` ne peut pas attendre

`docs/17 §3` le classait bloquant pour Foundation 4. Le banc a montré pourquoi,
et le résultat est plus net qu'attendu :

> Aucun des quatre statuts existants ne peut décrire trois envois réussis sur
> cinq. Chacun est faux, et pour une raison différente.

| Statut | Ce qu'il affirmerait | Pourquoi c'est faux |
|---|---|---|
| `CONFIRMED` | les cinq ont reçu | deux n'ont rien reçu |
| `PROBABLE` | les cinq, sans preuve | faux **et** non vérifié |
| `UNKNOWN` | je ne sais pas | on sait, pour trois d'entre eux |
| `FAILED` | personne n'a reçu | trois ont reçu |

Ce n'est pas un mauvais choix parmi des valeurs existantes : c'est une valeur
manquante. `tests/lab/partial.test.ts` le vérifie de façon **exhaustive sur
l'énumération**, donc le test rougira si un cinquième statut apparaît.

Et la conséquence pratique est immédiate :

- dire `FAILED` ferait rejouer l'envoi **aux cinq** ;
- dire `CONFIRMED` laisserait deux personnes sans message, en silence.

---

## 2. La sémantique proposée

### 2.1 `PARTIAL` seul ne suffit pas

Le mandat le dit, et c'est le point décisif :

> Sinon Jarvis dira « l'envoi a partiellement réussi » sans savoir précisément
> ce qui s'est passé.

Un statut agrégé sans détail est **moins utile qu'un `UNKNOWN` honnête** : il
donne l'illusion d'une information exploitable. `PARTIAL` n'a de sens qu'assorti
d'un résultat par sous-cible.

### 2.2 Forme

```ts
/** Une cible d'une opération multi-cibles. Jamais un doublon. */
interface TargetOutcome {
  readonly target: string;             // opaque au noyau : email, IBAN, id…
  readonly status: VerificationStatus; // le MÊME vocabulaire, par cible
  readonly proof?: string;
  readonly unknownReason?: UnknownReason;
}

interface PartialOutcome {
  readonly status: 'PARTIAL';
  readonly targets: readonly TargetOutcome[];
}
```

Trois propriétés, et elles sont ce qui rend la valeur utilisable :

**Le vocabulaire par cible est celui de l'opération.** `CONFIRMED`, `PROBABLE`,
`UNKNOWN`, `FAILED` — pas un second vocabulaire. Une cible peut être `UNKNOWN`
pour les six mêmes raisons qu'une opération entière.

**`PARTIAL` est dérivé, jamais déclaré.** Il se calcule :

```text
toutes CONFIRMED           → CONFIRMED   (et non PARTIAL)
toutes FAILED              → FAILED
aucune information         → UNKNOWN
mélange                    → PARTIAL
```

Un outil ne peut donc pas se dire `PARTIAL` pour éviter de trancher. C'est la
même discipline que `confirmed()`, seule fabrique de `CONFIRMED`.

**`mayClaimSuccess('PARTIAL')` vaut `false`.** Jarvis ne dit jamais « c'est
fait » d'un envoi partiel. Il dit qui a reçu et qui n'a pas reçu.

### 2.3 Ce que devient la reprise

C'est ici que la spécification gagne son coût. La clé d'opération ne suffit
plus : la reprise doit être **par cible**.

```text
reprise d'une opération PARTIAL
   ↓
pour chaque cible :
   CONFIRMED  → ne rien faire            ← jamais resservir
   FAILED     → exécutable               ← affirmation positive d'absence
   UNKNOWN    → vérifier, jamais rejouer ← règle inchangée
```

Aujourd'hui, `lab/partial` mesure ce que coûte l'absence de ce mécanisme : le
journal d'intention refuse toute reprise, ce qui protège les trois servis et
condamne les deux autres. **La protection fonctionne au prix d'une perte
silencieuse.**

### 2.4 L'inégalité fondamentale, corrigée

```text
AVANT   external_effect_count ≤ 1
APRÈS   external_effect_count(clé, cible) ≤ 1
```

`docs/17` et `docs/12` portent l'ancienne formulation. Elle était fausse dès
qu'un outil aurait plusieurs cibles — c'est-à-dire dès le premier outil d'email.

### 2.5 Ce que la mise en œuvre exigera

| Élément | Changement |
|---|---|
| `VerificationStatus` | ajout de `PARTIAL` — cinquième valeur |
| `tool_operations` | une table fille `tool_operation_targets` |
| `mayClaimSuccess` | `PARTIAL` → `false` |
| Contrat d'outil | déclarer si l'outil est multi-cibles |
| Reprise | par cible, plus par opération |

**Le point de non-retour :** ajouter `PARTIAL` après le premier outil
multi-cibles impose une migration de données ET une relecture de tout code qui
fait un `switch` sur `VerificationStatus`. Avant, c'est une valeur de plus.

---

## 3. Routage conscient du risque

### 3.1 L'ordre

Ratifié en `docs/12 §7`, étendu ici avec l'étape que le banc a rendue
nécessaire :

```text
                 REQUÊTE
                    ↓
            CLASSIFICATION          docs/14 — quelle donnée
                    ↓
              POLITIQUE             docs/13 — quels traitements permis
                    ↓
          ANALYSE DE RISQUE         ← NOUVEAU : quel effet, réversible ?
                    ↓
        CAPACITÉS AUTORISÉES        docs/15 — quels fournisseurs éligibles
                    ↓
             ROUTEUR                le moins coûteux PARMI les éligibles
                    ↓
            TOOL GATEWAY
                    ↓
            VÉRIFICATION
                    ↓
              RÉSULTAT
```

Jamais l'inverse. Le coût ne décide ni de la confidentialité, ni du risque.

### 3.2 La règle de repli, et pourquoi elle dépend de l'effet

Le banc a mesuré les deux faces.

**Ce qui est garanti** (`lab/provider-fallback`) : un repli qui conserve la clé
d'opération ne produit jamais de second effet, quel que soit le fournisseur qui
se présente. Le journal d'intention voit l'état `UNKNOWN` et refuse.

**Ce qui ne l'est pas** : un repli avec une **nouvelle clé** produit deux
effets. Mesuré, reproductible, et impossible à corriger dans le noyau — le
Gateway ne voit pas les intentions, seulement des clés.

D'où l'invariant que Foundation 4 doit rendre structurel :

> **INV-R1 — Un repli conserve la clé d'opération. Sinon ce n'est pas un repli,
> c'est une seconde action.**

Et la règle qui en découle, différenciée par type d'effet :

| Type d'opération | `effect` | Après un `UNKNOWN` du fournisseur A |
|---|---|---|
| Réponse textuelle, résumé, classification | *aucun effet* | repli sur B **autorisé** — rejouer ne coûte que des jetons |
| Écriture locale | `LOCAL_TRANSACTIONAL` | repli autorisé : le rollback garantit l'absence d'effet |
| Envoi, publication, paiement | `EXTERNAL` | **`UNKNOWN` → STOP.** Jamais de repli automatique |

C'est `FAIL CLOSED` appliqué au routage. Et c'est le champ `effect` (ADR-028)
qui porte la décision — pas une liste de noms d'outils, qui divergerait.

### 3.3 La règle qu'il ne faut pas oublier d'écrire

> **INV-R2 — Un changement de fournisseur ne constitue jamais une preuve que le
> fournisseur précédent n'a pas exécuté l'action.**

Elle paraît évidente écrite ainsi. Elle ne l'est pas dans le code : « A a
échoué, j'essaie B » est la formulation naturelle, et elle est fausse dès que
« A a échoué » signifie en réalité « A n'a pas répondu ».

### 3.4 Métriques que le routeur doit lire

Mesurées par `tests/lab/metrics.ts`, déjà en état de marche :

```text
p50 / p95 latence · taux de succès ANNONCÉ · taux VÉRIFIÉ
taux d'UNKNOWN · taux de repli · coût · niveau de confidentialité
       ↓
coût par tâche RÉELLEMENT accomplie
```

Deux règles de calcul, sans lesquelles le tableau ment :

- **seul `CONFIRMED` compte au dénominateur** — ni `PROBABLE`, ni `PARTIAL` ;
- **le taux d'`UNKNOWN` se lit avant le coût** : chaque incertitude consomme une
  décision humaine, poste bien plus cher que le jeton.

---

## 4. Tests exigés avant de considérer ces normes acquises

**Pour `PARTIAL`**

1. trois cibles sur cinq → `PARTIAL`, avec cinq `TargetOutcome` renseignés ;
2. `mayClaimSuccess('PARTIAL')` vaut `false` — exhaustif sur l'énumération ;
3. une reprise ne resert **aucune** cible `CONFIRMED` ;
4. une reprise sert les cibles `FAILED`, et elles seules ;
5. une cible `UNKNOWN` n'est jamais resservie automatiquement ;
6. `external_effect_count(clé, cible) ≤ 1` sous 100 appels concurrents ;
7. un outil ne peut pas déclarer `PARTIAL` lui-même — il est dérivé.

**Pour le routage**

8. un repli conserve la clé d'opération — vérifié **structurellement**, par
   analyse du code du routeur, pas par un cas de test ;
9. une opération `effect: EXTERNAL` en `UNKNOWN` ne déclenche aucun repli ;
10. tous les fournisseurs autorisés indisponibles → refus, jamais escalade
    (reconduit de `docs/14 §6`, test 4) ;
11. le routeur lit `verificationRate`, jamais `successRate`, pour arbitrer.

Le test 8 est le seul qui protège réellement contre le double effet : les
autres vérifient des comportements, celui-là verrouille une propriété.
