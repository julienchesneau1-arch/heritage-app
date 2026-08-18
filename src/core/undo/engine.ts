/**
 * UNDO ENGINE — ce qui EXÉCUTE le défaire. ADR-066.
 *
 * `docs/09 §2.1` posait la scène :
 *
 * > « Jarvis, déplace mon rendez-vous de jeudi à vendredi. » → « Déplacé. »
 * > puis, plus tard : « Annule la dernière action. »
 *
 * `snapshots.ts` ouvre par cette phrase : **« CE MODULE N'ANNULE RIEN. Il
 * capture de quoi annuler. »** Ce fichier est l'autre moitié, et l'invariant
 * S12 — *le rollback reste possible* — était jusqu'ici vrai au sens des
 * DONNÉES et faux au sens de l'ACTION : on savait quoi défaire, rien ne
 * pouvait le faire (`docs/26 §4.10`).
 *
 * CE MOTEUR NE DÉFAIT RIEN LUI-MÊME — ET C'EST TOUT LE SUJET
 * ---------------------------------------------------------------------------
 * Il n'écrit pas en base, ne supprime pas, ne restaure pas. Il **rejoue la
 * capture par le Tool Gateway**, donc par la chaîne complète :
 *
 * ```
 * capture → Policy Gate → outil typé → exécution → vérification → journal
 * ```
 *
 * Un moteur qui supprimerait « directement, puisqu'on sait ce qu'on fait »
 * serait un second chemin d'écriture échappant à la politique, au journal et à
 * la vérification. Ce serait la porte dérobée que tout le dépôt existe pour ne
 * pas avoir.
 *
 * ANNULER PEUT COÛTER PLUS CHER QUE FAIRE
 * ----------------------------------------
 * `memory_add` est `L2`. Son inverse `memory_forget` est `L4` — `docs/03` :
 * *« suppression, données sensibles, irréversible »*. **Annuler une action de
 * niveau 2 exige donc une confirmation de niveau 4**, et c'est correct : ce
 * qu'on défait ici est un souvenir, et l'effacement est définitif.
 *
 * Le moteur ne fabrique aucun consentement. Il transmet le contexte de son
 * appelant tel quel ; si l'humain n'a pas confirmé, le Policy Gate refuse. Un
 * moteur qui poserait `userConfirmed: true` pour « faire passer l'annulation »
 * contournerait la dernière décision humaine de la chaîne.
 *
 * LE DOUBLE DÉFAIRE, FERMÉ LÀ OÙ CE DÉPÔT LE FERME TOUJOURS
 * ---------------------------------------------------------
 * La clé d'annulation est **dérivée de la capture** (`forUndo`), sans aléa.
 * Deux demandes concurrentes portent donc la même clé, et c'est le journal
 * d'intention du Gateway — `ON CONFLICT DO NOTHING`, atomique (ADR-029) — qui
 * garantit un seul effet. Une garde applicative « ai-je déjà annulé ? » aurait
 * la fenêtre que Foundation 3 avait mesurée à 20 effets pour une clé unique.
 *
 * ORDRE : EXÉCUTER, PUIS MARQUER
 * -------------------------------
 * L'inverse — marquer d'abord — paraît plus prudent et ne l'est pas. Si
 * l'exécution échouait ensuite, la capture serait **brûlée** : marquée annulée
 * alors que l'action tient toujours, et plus rien ne permettrait de réessayer.
 *
 * Exécuter d'abord ne risque pas le double effet, puisque la clé déterministe
 * le ferme en amont. Entre « l'annulation reste réessayable » et « l'annulation
 * est perdue », on prend le réessayable.
 */
import { hasAnyEffect } from '../types/domain.js';
import type { Mode, Provenance, VerificationStatus } from '../types/domain.js';
import { err, ok, jarvisError, type Result } from '../types/result.js';
import { forUndo } from '../tools/identity.js';
import type { ToolGateway } from '../tools/gateway.js';
import type { Snapshot, SnapshotStore } from './snapshots.js';

/**
 * Le contexte d'appel, transmis SANS retouche au Policy Gate.
 *
 * `Mode` est IMPORTÉ, pas recopié. La première version de ce fichier en
 * réécrivait les valeurs à la main et en inventait quatre qui n'existent pas :
 * deux registres du même fait, ADR-041, attrapé par le compilateur.
 */
export interface UndoContext {
  readonly mode: Mode;
  readonly cloudEnabled: boolean;
  readonly proactive: boolean;
  readonly userConfirmed: boolean;
}

export interface UndoOutcome {
  readonly snapshotId: string;
  /** L'opération qui a été défaite. */
  readonly undoneOperationId: string;
  /** L'opération d'annulation elle-même — dérivée, donc stable. */
  readonly undoOperationId: string;
  readonly toolId: string;
  readonly resource: { readonly kind: string; readonly id: string };
  readonly status: VerificationStatus;
  readonly detail: string;
}

/**
 * CE QUI SERAIT DÉFAIT — sans rien défaire.
 *
 * On ne confirme pas ce qu'on n'a pas vu (ADR-063). Demander « annuler la
 * dernière action ? » sans dire LAQUELLE transforme la confirmation en
 * formalité : l'utilisateur tape oui sur une phrase, pas sur un acte.
 *
 * `empechement` porte le motif quand la capture existe mais n'est pas
 * rejouable — irréversible par conception, expirée, déjà annulée. Le montrer
 * AVANT vaut mieux qu'un refus après un oui inutile.
 */
export interface UndoPreview {
  readonly snapshotId: string;
  readonly operationId: string;
  readonly resource: { readonly kind: string; readonly id: string };
  readonly inverseToolId: string | null;
  readonly undoKind: string;
  readonly empechement: string | null;
}

export interface UndoEngine {
  /** « Annule la dernière action. » — la formulation de `docs/09 §2.1`. */
  undoLast(context: UndoContext): Promise<Result<UndoOutcome>>;
  /** Ce que `undoLast` défairait. N'exécute RIEN. */
  previewLast(): Promise<Result<UndoPreview | null>>;
  /** Annule une opération nommée. */
  undoOperation(
    operationId: string,
    context: UndoContext,
  ): Promise<Result<UndoOutcome>>;
}

export interface UndoDeps {
  readonly snapshots: SnapshotStore;
  readonly gateway: ToolGateway;
}

/**
 * Pourquoi une capture ne peut pas être rejouée.
 *
 * Chaque refus PORTE SON MOTIF. « Impossible d'annuler » sans raison pousse
 * l'utilisateur à recommencer au hasard ; « cette action est irréversible par
 * conception » lui dit quoi faire de sa journée.
 */
function refus(snapshot: Snapshot): string | null {
  if (snapshot.undoneAt !== null) {
    return `déjà annulée le ${snapshot.undoneAt}`;
  }
  if (snapshot.expired) {
    /* Le verdict vient de la BASE (ADR-064). Le moteur ne compare aucune date :
       une rétention jugée par l'horloge du processus reproduirait ADR-037. */
    return "la capture a expiré — au-delà de la rétention, l'état antérieur n'est plus conservé";
  }
  if (snapshot.undoKind === 'NOT_UNDOABLE') {
    return "cette action est irréversible PAR CONCEPTION, pas par oubli : rien n'a été conservé qui permettrait de la défaire";
  }
  if (snapshot.undoKind === 'STATE_RESTORE') {
    /* HONNÊTETÉ PLUTÔT QUE FAÇADE. La capture existe et contient les valeurs
       antérieures ; ce qui manque est le mécanisme qui les réapplique — il
       faudrait, par type de ressource, un outil de restauration. Aucun n'est
       écrit.

       Simuler la restauration « puisqu'on a les données » exigerait d'écrire en
       base hors du Tool Gateway, c'est-à-dire hors politique et hors journal.
       On refuse en nommant ce qui manque. */
    return "restauration d'état non implémentée — la capture existe, aucun outil de restauration n'est enregistré pour ce type de ressource";
  }
  if (snapshot.inverseToolId === null) {
    return 'capture incomplète : aucun outil inverse nommé';
  }
  return null;
}

/**
 * LA CAPTURE EST-ELLE CONSOMMÉE PAR CE RÉSULTAT ?
 *
 * ⚠ CETTE FONCTION REMPLACE UN `hasAnyEffect` DIRECT, ET LES DEUX RAISONS
 *   VIENNENT D'UN SABOTAGE — pas d'une relecture. En faisant rendre `true` à
 *   `hasAnyEffect`, **les trente-sept tests d'annulation restaient verts.**
 *
 * **1. Ce que la garde protégeait n'était pas éprouvé.** Marquer une capture
 * dont l'annulation a ÉCHOUÉ la brûle : elle devient « annulée » alors que
 * l'action tient toujours, et plus rien ne permet de réessayer. Tout le
 * raisonnement « exécuter puis marquer » repose là-dessus, et rien ne le
 * vérifiait.
 *
 * **2. `hasAnyEffect` seul BLOQUAIT `undoLast`.** Une annulation qui ne trouve
 * rien à défaire rend `NOT_ATTEMPTED` — cas réel : la note a été supprimée par
 * un autre chemin avant qu'on annule sa création. Ce n'est pas un échec, c'est
 * un sans-objet. Or `lastUndoable` rend la capture non annulée la plus récente :
 * une capture qu'on ne marque jamais serait resservie à chaque « annule la
 * dernière action », indéfiniment.
 *
 * D'où trois cas, et non deux :
 *
 * ```text
 * CONFIRMED · PARTIAL   l'annulation a eu lieu        → consommée
 * NOT_ATTEMPTED         il n'y avait rien à défaire   → consommée (sans objet)
 * FAILED · UNKNOWN      l'action peut tenir toujours  → RESTE annulable
 * ```
 *
 * La ligne du bas est la seule qui compte pour la sûreté ; celle du milieu
 * empêche la boucle.
 */
function captureConsommee(status: VerificationStatus): boolean {
  /* `hasAnyEffect` est la fonction CANONIQUE — la recopier ici en comparant des
     littéraux serait un second registre du même fait (ADR-041), et le test
     structurel de `redteam/failure-modes` le refuse d'ailleurs : aucun module
     du noyau ne manipule ce vocabulaire hors du Verification Engine. */
  if (hasAnyEffect(status)) return true;
  return status === 'NOT_ATTEMPTED';
}

export function createUndoEngine(deps: UndoDeps): UndoEngine {
  async function rejouer(
    snapshot: Snapshot,
    context: UndoContext,
  ): Promise<Result<UndoOutcome>> {
    const motif = refus(snapshot);
    if (motif !== null) {
      return err(
        jarvisError('CONFLICT', `Annulation impossible : ${motif}.`, {
          snapshotId: snapshot.id,
          operationId: snapshot.operationId,
          undoKind: snapshot.undoKind,
        }),
      );
    }

    const toolId = snapshot.inverseToolId;
    if (toolId === null) {
      return err(jarvisError('INTERNAL', 'Outil inverse absent après contrôle.'));
    }

    /* PROVENANCE DE L'ENTRÉE INVERSE : `SYSTEM`.
       Elle vient de la capture, écrite par le Gateway lui-même à partir d'une
       exécution vérifiée. Ce n'est ni une saisie humaine — prétendre `USER`
       serait forger une intention — ni une proposition de modèle. */
    const entree = snapshot.inverseInput;
    const provenance: Record<string, Provenance> = {};
    if (typeof entree === 'object' && entree !== null) {
      for (const cle of Object.keys(entree)) provenance[cle] = 'SYSTEM';
    }

    const undoOperationId = forUndo(snapshot.id);

    const resultat = await deps.gateway.invoke({
      toolId,
      input: entree,
      parameterProvenance: provenance,
      operationId: undoOperationId,
      actor: 'USER',
      // Transmis TEL QUEL. Voir l'en-tête : le moteur ne fabrique pas de
      // consentement, et `memory_forget` est L4.
      context,
    });
    if (!resultat.ok) return resultat;

    if (!captureConsommee(resultat.value.status)) {
      return ok({
        snapshotId: snapshot.id,
        undoneOperationId: snapshot.operationId,
        undoOperationId,
        toolId,
        resource: { kind: snapshot.resourceKind, id: snapshot.resourceId },
        status: resultat.value.status,
        detail:
          `L'annulation n'a PAS abouti (${resultat.value.status}) : ` +
          `${resultat.value.verification.detail} — la capture reste annulable.`,
      });
    }

    const marque = await deps.snapshots.markUndone(snapshot.id, undoOperationId);
    if (!marque.ok) {
      /* L'EFFET A EU LIEU, LA COMPTABILITÉ NON. On ne rend pas un succès
         tranquille : l'état est incohérent et l'utilisateur doit l'apprendre.
         Un réessai retombera sur le refus de rejeu du Gateway, qui rendra le
         verdict déjà écrit — donc rien ne sera doublé. */
      return err(
        jarvisError(
          'INTEGRITY',
          `L'annulation a bien été exécutée (${resultat.value.status}), mais la ` +
            "capture n'a pas pu être marquée annulée. Aucun second effet n'est " +
            'possible : la clé d\'annulation est déterministe.',
          { snapshotId: snapshot.id, undoOperationId },
        ),
      );
    }

    return ok({
      snapshotId: snapshot.id,
      undoneOperationId: snapshot.operationId,
      undoOperationId,
      toolId,
      resource: { kind: snapshot.resourceKind, id: snapshot.resourceId },
      status: resultat.value.status,
      detail: resultat.value.verification.detail,
    });
  }

  return {
    async previewLast(): Promise<Result<UndoPreview | null>> {
      const dernier = await deps.snapshots.lastUndoable();
      if (!dernier.ok) return dernier;
      if (dernier.value === null) return ok(null);
      const s = dernier.value;
      return ok({
        snapshotId: s.id,
        operationId: s.operationId,
        resource: { kind: s.resourceKind, id: s.resourceId },
        inverseToolId: s.inverseToolId,
        undoKind: s.undoKind,
        empechement: refus(s),
      });
    },

    async undoLast(context: UndoContext): Promise<Result<UndoOutcome>> {
      const dernier = await deps.snapshots.lastUndoable();
      if (!dernier.ok) return dernier;
      if (dernier.value === null) {
        return err(
          jarvisError(
            'NOT_FOUND',
            "Rien à annuler : aucune action annulable dans la fenêtre de rétention.",
          ),
        );
      }
      return rejouer(dernier.value, context);
    },

    async undoOperation(
      operationId: string,
      context: UndoContext,
    ): Promise<Result<UndoOutcome>> {
      const capture = await deps.snapshots.forOperation(operationId);
      if (!capture.ok) return capture;
      if (capture.value === null) {
        /* AUCUNE CAPTURE N'EST UNE INFORMATION, PAS UN BLANC. Soit l'opération
           n'a jamais existé, soit elle a été menée sans capture — et le second
           cas est un défaut qu'il vaut mieux nommer que masquer derrière un
           « rien à annuler » rassurant. */
        return err(
          jarvisError(
            'NOT_FOUND',
            `Aucune capture pour l'opération ${operationId} : elle n'a jamais ` +
              'existé, ou elle a été exécutée sans capture.',
            { operationId },
          ),
        );
      }
      return rejouer(capture.value, context);
    },
  };
}
