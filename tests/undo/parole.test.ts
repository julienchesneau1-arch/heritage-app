/**
 * « ANNULE LA DERNIÈRE ACTION » — depuis N'IMPORTE QUELLE surface — ADR-105.
 *
 * `docs/26 §4.20` posait le constat :
 *
 * ```text
 * CLI        « annule la dernière action »   →  marchait
 * say()      la même phrase                   →  « capacité absente »
 * téléphone  aucun bouton, aucune route       →  rien
 * ```
 *
 * L'Undo Engine existait depuis ADR-066 et il était branché — **à une seule
 * surface**. C'est la forme exacte du défaut qu'ADR-104 venait de réparer sur
 * l'arrêt d'urgence, sur un autre mécanisme.
 *
 * ⚠ LA PROPRIÉTÉ CENTRALE DE CE FICHIER n'est pas « ça marche depuis le
 * téléphone ». C'est : **ce qui est défait est l'opération qu'on a MONTRÉE**,
 * jamais « la dernière » telle qu'elle sera au moment du oui.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { estUneDemandeDAnnulation } from '../../src/core/undo/parole.js';
import { createAssistant, type AssistantDeps } from '../../src/core/assistant.js';
import { createIntentEngine } from '../../src/core/intent/engine.js';
import { ok, err, jarvisError, type Result } from '../../src/core/types/result.js';
import { sansCommentaires } from '../helpers/source.js';
import { arretDouble } from '../helpers/arret.js';
import { apercuDeNote, undoDouble } from '../helpers/undo.js';
import { modePriveDouble } from '../helpers/mode-prive.js';
import type {
  UndoEngine,
  UndoOutcome,
  UndoPreview,
} from '../../src/core/undo/engine.js';
import type { DemandeEnAttente, FileDeConfirmations } from '../../src/core/confirmation/file.js';
import type { GatewayResult, ToolCall, ToolGateway } from '../../src/core/tools/gateway.js';

/* ====================================================================== *
 * 1. LA RECONNAISSANCE — et ce qu'elle REFUSE d'avaler
 * ====================================================================== */

describe('les phrases qui demandent d’annuler', () => {
  const OUI = [
    'annule',
    'Annule.',
    'annule ça',
    'annule la dernière action',
    'Annule la dernière action.',
    'Annule ce que tu viens de faire',
    'annule tout ce que tu viens de faire',
    'défais ça',
    'reviens en arrière',
  ];

  it.each(OUI)('« %s » demande une annulation', (phrase) => {
    expect(estUneDemandeDAnnulation(phrase)).toBe(true);
  });

  /* ⚠ LA MOITIÉ QUI PORTE LE RISQUE.

     Une garde trop large défferait **la dernière action** au lieu de la chose
     nommée. L'utilisateur verrait disparaître autre chose que ce qu'il a
     demandé — une action réelle, juste pas la bonne, ce qui est le pire des
     défauts possibles ici. */
  const NON = [
    'annule la tâche du plombier',
    'annule le rappel de la réunion',
    'annule mon rendez-vous de jeudi',
    'supprime la note du carreleur',
    'oublie ce que je t’ai dit sur le compteur',
    'annule tout ce qui concerne le chantier',
    'note : annule la dernière action',
    'retiens que j’ai annulé la commande',
  ];

  it.each(NON)('⚠ « %s » n’en est PAS une', (phrase) => {
    expect(estUneDemandeDAnnulation(phrase)).toBe(false);
  });

  it('la fonction est PURE — aucune entrée-sortie', () => {
    const src = readFileSync('src/core/undo/parole.ts', 'utf8');
    for (const interdit of ['await ', 'Promise', 'db.', 'query(']) {
      expect(src, `« ${interdit} » n’a rien à faire ici`).not.toContain(interdit);
    }
  });
});

/* ====================================================================== *
 * LES DOUBLES
 * ====================================================================== */

function passerelleMuette(calls: ToolCall[]): ToolGateway {
  return {
    register: () => ok(undefined),
    list: () => [],
    restoreTrust: () => Promise.resolve(ok(undefined)),
    invoke: (call: ToolCall): Promise<Result<GatewayResult>> => {
      calls.push(call);
      return Promise.resolve(err(jarvisError('INTERNAL', 'aucun outil attendu ici')));
    },
  } as unknown as ToolGateway;
}

function fileEspionne(recues: DemandeEnAttente[]): FileDeConfirmations {
  return {
    mettreEnFile: (demande) => {
      recues.push(demande);
      return Promise.resolve(
        ok({ ...demande, id: 'file-1', minutesRestantes: 30 }),
      );
    },
    enAttente: () => Promise.resolve(ok([])),
    confirmer: () => Promise.resolve(err(jarvisError('NOT_FOUND', 'x'))),
    refuser: () => Promise.resolve(ok(false)),
  };
}

function assistantAvec(
  undo: UndoEngine,
  extra: { file?: FileDeConfirmations; calls?: ToolCall[] } = {},
) {
  const deps: AssistantDeps = {
    arret: arretDouble(),
    undo,
    modePrive: modePriveDouble(),
    // ADR-107 — sans mémoire d'affichage, un ordinal DEMANDE. C'est le défaut.
    affichage: null,
    intent: createIntentEngine(),
    gateway: passerelleMuette(extra.calls ?? []),
    setGuardConfirmed: () => undefined,
    cloudEnabled: false,
    resolver: {
      resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
    },
    designation: {
      resoudre: () => Promise.resolve(ok({ kind: 'INTROUVABLE' as const, mention: 'x' })),
    },
    file: extra.file ?? null,
    temps: {
      resoudre: () => Promise.resolve(ok({ iso: '2026-09-19T09:00:00Z', humain: 'j' })),
      resoudreFenetre: () =>
        Promise.resolve(
          ok({ debutIso: '2026-09-19T00:00:00Z', finIso: '2026-09-20T00:00:00Z', humain: 'j' }),
        ),
    },
    tier1: null,
  };
  return createAssistant(deps);
}

const REUSSITE: Result<UndoOutcome> = ok({
  snapshotId: 'snap-1',
  undoneOperationId: 'op-1',
  undoOperationId: 'undo-snap-1',
  toolId: 'note_delete',
  resource: { kind: 'note', id: 'note-1' },
  status: 'CONFIRMED',
  detail: 'Effacement vérifié : note note-1 absente',
});

/* ====================================================================== *
 * 2. LE CHEMIN — la phrase atteint le moteur, quelle que soit la surface
 * ====================================================================== */

describe('la phrase atteint l’Undo Engine', () => {
  it('⚠ elle n’invoque AUCUN outil directement', async () => {
    /* L'Assistant ne choisit pas l'outil inverse : il ne le CONNAÎT pas.
       Seule la capture sait lequel c'est. Si un `toolId` apparaissait ici, le
       moteur d'intention devrait deviner l'inverse de chaque outil — un
       second registre de ce que l'Undo Engine possède déjà (ADR-041). */
    const calls: ToolCall[] = [];
    const undo = undoDouble({ apercu: apercuDeNote(), resultat: REUSSITE });
    const r = await assistantAvec(undo, { calls }).say('annule', { surface: 'LOCALE' });

    expect(r.kind).toBe('ANNULE');
    expect(calls, 'aucun appel d’outil ne part de l’Assistant').toEqual([]);
    expect(undo.vises).toEqual(['op-1']);
  });

  it('« rien à annuler » est une RÉPONSE, pas une erreur', async () => {
    const r = await assistantAvec(undoDouble({ apercu: null })).say('annule', {
      surface: 'LOCALE',
    });
    expect(r.kind).toBe('CLARIFY');
    if (r.kind !== 'CLARIFY') return;
    expect(r.question).toContain('rien à annuler');
  });

  it('⚠ un EMPÊCHEMENT se dit AVANT la question', async () => {
    /* Demander un accord pour une action qu'on sait refusée fait perdre du
       temps ET use la confirmation : quelqu'un dont les « oui » ne produisent
       rien finit par les donner sans lire.

       Le cas réel aujourd'hui : `task_complete` capture un `STATE_RESTORE`, et
       aucun outil de restauration n'est enregistré. Jarvis le NOMME. */
    const bloque: UndoPreview = {
      ...apercuDeNote(),
      empechement: 'restauration d’état non implémentée',
    };
    const r = await assistantAvec(undoDouble({ apercu: bloque })).say('annule', {
      surface: 'LOCALE',
    });
    expect(r.kind).toBe('UNSUPPORTED');
    if (r.kind !== 'UNSUPPORTED') return;
    expect(r.missing).toContain('restauration');
  });
});

/* ====================================================================== *
 * 3. ⚠ LA PROPRIÉTÉ CENTRALE — on défait CE QU'ON A MONTRÉ
 * ====================================================================== */

describe('⚠ la confirmation vise l’opération NOMMÉE, jamais « la dernière »', () => {
  it('la question porte l’identité de l’opération visée', async () => {
    const undo = undoDouble({
      apercu: apercuDeNote('op-montree'),
      resultat: err(jarvisError('CONFIRMATION_REQUIRED', 'Niveau L4')),
    });
    const r = await assistantAvec(undo).say('annule', { surface: 'LOCALE' });
    expect(r.kind).toBe('CONFIRM');
    if (r.kind !== 'CONFIRM') return;
    expect(String(r.operationId)).toBe('op-montree');
  });

  it('⚠ et la question NOMME la chose, pas un identifiant d’opération', () => {
    /* ADR-063 : on ne confirme pas ce qu'on n'a pas vu. La première rédaction
       affichait « annuler : c639cf86-65fe-4e5f-… » — un oui donné sur une
       chaîne hexadécimale n'est pas un consentement, c'est un réflexe.

       Mesuré en UTILISANT Jarvis, pas en le relisant. */
    const undo = undoDouble({
      apercu: apercuDeNote('op-montree'),
      resultat: err(jarvisError('CONFIRMATION_REQUIRED', 'Niveau L4')),
    });
    return assistantAvec(undo)
      .say('annule', { surface: 'LOCALE' })
      .then((r) => {
        expect(r.kind).toBe('CONFIRM');
        if (r.kind !== 'CONFIRM') return;
        const dit = Object.values(r.values).join(' ');
        expect(dit, 'la ressource doit être nommée').toContain('note');
        expect(dit, 'l’outil inverse doit être nommé').toContain('note_delete');
      });
  });

  it('⚠⚠ LE MONDE BOUGE ENTRE LA QUESTION ET LE OUI — et on défait quand même la BONNE', async () => {
    /* LE TEST QUI PORTE TOUTE L'ADR.

       Entre « annuler la note du carreleur ? » et « oui », une autre action
       peut avoir eu lieu — c'est même le cas NORMAL quand la demande vient du
       téléphone et que le oui est donné devant le Mac, plus tard.

       Si la confirmation relisait `previewLast()`, elle défferait ce qui est
       devenu « la dernière ». L'utilisateur aurait dit oui à une chose et en
       aurait perdu une autre. */
    let apercuCourant = apercuDeNote('op-ancienne');
    const vises: string[] = [];
    const mouvant: UndoEngine = {
      previewLast: () => Promise.resolve(ok(apercuCourant)),
      undoLast: () => Promise.resolve(REUSSITE),
      undoOperation: (id) => {
        vises.push(id);
        return Promise.resolve(REUSSITE);
      },
    };

    const assistant = assistantAvec(mouvant);
    // Le monde change après la question.
    apercuCourant = apercuDeNote('op-toute-fraiche');

    await assistant.say('annule', {
      surface: 'LOCALE',
      confirm: true,
      operationId: 'op-ancienne' as never,
    });

    expect(vises, 'on défait ce qui a été MONTRÉ').toEqual(['op-ancienne']);
    expect(vises, 'jamais ce qui est devenu « la dernière »').not.toContain(
      'op-toute-fraiche',
    );
  });

  it('CONTRÔLE — sans identité fournie, on retombe bien sur la dernière', async () => {
    /* Sans lui, l'assertion ci-dessus serait vraie dans un système où
       `previewLast` ne sert jamais à rien. */
    const undo = undoDouble({ apercu: apercuDeNote('op-derniere'), resultat: REUSSITE });
    await assistantAvec(undo).say('annule', { surface: 'LOCALE' });
    expect(undo.vises).toEqual(['op-derniere']);
  });
});

/* ====================================================================== *
 * 4. LE TÉLÉPHONE — mise en file, et rendue à son PROPRIÉTAIRE
 * ====================================================================== */

describe('⚠ depuis le téléphone : préparée, jamais exécutée', () => {
  const REFUS_DISTANT = err(
    jarvisError('POLICY_DENIED', 'Surface distante : confirmation impossible.', {
      motif: 'SURFACE_DISTANTE',
    }),
  );

  it('une annulation demandée à distance part EN FILE, avec son genre', async () => {
    const recues: DemandeEnAttente[] = [];
    const undo = undoDouble({
      apercu: apercuDeNote('op-distante'),
      resultat: REFUS_DISTANT,
    });
    const r = await assistantAvec(undo, { file: fileEspionne(recues) }).say('annule', {
      surface: 'DISTANTE',
    });

    expect(r.kind).toBe('EN_ATTENTE');
    expect(recues).toHaveLength(1);
    expect(recues[0]?.genre, 'le genre dit à QUI rendre l’intention').toBe('ANNULATION');
    expect(recues[0]?.operationId, 'l’opération À DÉFAIRE, nommée').toBe('op-distante');
    expect(recues[0]?.resume, 'le résumé doit être lisible').toContain('note');
  });

  it('⚠ on ne DEVINE pas le refus : c’est le Policy Gate qui tranche', async () => {
    /* Anticiper « distante donc en file » porterait une seconde décision de
       politique dans l'Assistant. Le jour où elle divergerait de Cedar, aucune
       des deux ne ferait autorité (ADR-041).

       Preuve : la MÊME surface distante, avec un moteur qui réussit, exécute. */
    const recues: DemandeEnAttente[] = [];
    const undo = undoDouble({ apercu: apercuDeNote(), resultat: REUSSITE });
    const r = await assistantAvec(undo, { file: fileEspionne(recues) }).say('annule', {
      surface: 'DISTANTE',
    });
    expect(r.kind).toBe('ANNULE');
    expect(recues, 'rien ne doit partir en file quand rien n’est refusé').toEqual([]);
  });

  it('⚠ un refus SANS motif réparable reste un refus — pas une file', async () => {
    /* La condition d'ADR-099, préservée : sans elle, il suffirait de demander
       depuis le téléphone pour obtenir « à confirmer plus tard » ce qui est
       interdit tout court. */
    const recues: DemandeEnAttente[] = [];
    const undo = undoDouble({
      apercu: apercuDeNote(),
      resultat: err(jarvisError('POLICY_DENIED', 'Interdit par politique.')),
    });
    const r = await assistantAvec(undo, { file: fileEspionne(recues) }).say('annule', {
      surface: 'DISTANTE',
    });
    expect(r.kind).toBe('DENIED');
    expect(recues).toEqual([]);
  });

  it('sans file, une annulation distante reste simplement REFUSÉE', async () => {
    const undo = undoDouble({ apercu: apercuDeNote(), resultat: REFUS_DISTANT });
    const r = await assistantAvec(undo).say('annule', { surface: 'DISTANTE' });
    expect(r.kind).toBe('DENIED');
  });
});

/* ====================================================================== *
 * 5. UN SEUL REGISTRE — le CLI n'a plus sa propre chaîne
 * ====================================================================== */

describe('⚠ la phrase ne vit plus qu’à UN endroit', () => {
  it('le CLI n’a plus ni motif d’annulation ni chaîne parallèle', () => {
    /* C'était le défaut : `/^annule la derni[eè]re action/iu` et tout le
       scénario `docs/09 §2.1` vivaient dans l'interface. Une capacité
       branchée à une seule surface est, vue des autres, absente. */
    const cli = sansCommentaires(readFileSync('src/apps/cli/main.ts', 'utf8'));
    expect(cli, 'le motif ne doit plus être dans le CLI').not.toMatch(
      /annule la derni\[e/u,
    );
    expect(cli, 'la chaîne aperçu → question n’est plus ici').not.toContain(
      'previewLast',
    );
    expect(cli, 'ni l’exécution « la dernière »').not.toContain('undoLast');
  });

  it('CONTRÔLE — mais la commande /annule existe toujours, comme raccourci', () => {
    /* Sans lui, les assertions d'absence seraient vraies dans un CLI où plus
       personne ne peut annuler. */
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain("line === '/annule'");
    expect(cli).toContain('annule la dernière action');
  });

  it('⚠ et le TÉLÉPHONE l’atteint — un bouton qui écrit la phrase', () => {
    /* ADR-094 : une capacité que l'interface ne montre pas est, du siège de
       l'utilisateur, une capacité absente. Le bouton envoie du TEXTE par la
       boucle ordinaire — il ne donne aucun pouvoir que la parole ne donne pas,
       et le Policy Gate décide comme pour n'importe quelle phrase. */
    const ui = readFileSync('src/apps/server/ui.ts', 'utf8');
    expect(ui).toContain('data-phrase="annule la dernière action"');
    expect(ui).toContain("reply.kind === 'ANNULE'");
    expect(ui, 'aucune route dédiée ne doit exister').not.toContain('/api/annule');
  });
});
