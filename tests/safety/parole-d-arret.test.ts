/**
 * « JARVIS, STOP » — la phrase atteint-elle le bouton rouge ? — ADR-104.
 *
 * `docs/05 §C2` est le seul scénario doré `CRITIQUE` dont l'ENTRÉE est une
 * phrase. Le mécanisme existait depuis ADR-057 ; `engage()` n'avait aucun
 * appelant. Ce fichier éprouve les deux moitiés du chemin qui manquait :
 *
 * ```text
 * RECONNAÎTRE   quelles phrases sont un arrêt, et surtout lesquelles NE LE
 *               SONT PAS — « arrête la tâche du plombier » est task_cancel
 * ATTEINDRE     l'Assistant court-circuite AVANT le Tier 0 et le Policy Gate
 * ```
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { estUneParoleDArret } from '../../src/core/safety/parole-d-arret.js';
import { createAssistant } from '../../src/core/assistant.js';
import { createIntentEngine } from '../../src/core/intent/engine.js';
import { ok, err, jarvisError, type Result } from '../../src/core/types/result.js';
import { arretDouble } from '../helpers/arret.js';
import { undoDouble } from '../helpers/undo.js';
import { modePriveDouble } from '../helpers/mode-prive.js';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';
import type { GatewayResult, ToolCall, ToolGateway } from '../../src/core/tools/gateway.js';
import type { CompteRenduDArret, ControleDArret } from '../../src/core/safety/controle.js';

/* ====================================================================== *
 * 1. LA RECONNAISSANCE — et surtout ce qu'elle REFUSE de reconnaître
 * ====================================================================== */

describe('les phrases qui arrêtent Jarvis', () => {
  const ARRETS = [
    'stop',
    'Stop.',
    'Jarvis, stop.',
    'jarvis stop',
    'arrête tout',
    'Arrête tout !',
    'arrete tout',
    'arrête-toi',
    'arrête',
    'stoppe',
    'coupe tout',
    'arrêt d’urgence',
    "arret d'urgence",
  ];

  it.each(ARRETS)('« %s » est un arrêt', (phrase) => {
    expect(estUneParoleDArret(phrase)).toBe(true);
  });

  /* ⚠ LA MOITIÉ QUI COMPTE VRAIMENT.

     Un arrêt d'urgence déclenché par « arrête la tâche du plombier »
     paralyserait Jarvis à la place d'une annulation ordinaire, et
     l'utilisateur ne comprendrait pas ce qui vient de se passer. La règle est
     qu'un arrêt d'urgence ne prend AUCUN complément d'objet. */
  const PAS_DES_ARRETS = [
    'arrête la tâche du plombier',
    'arrête le minuteur',
    'arrête de me rappeler ça',
    'stoppe la lecture du document',
    'arrête tout ce qui concerne le chantier',
    'non stop',
    'je veux arrêter de fumer',
    'note : arrête tout',
    'retiens que le chantier est à l’arrêt',
    'arrête tout le monde en parle',
  ];

  it.each(PAS_DES_ARRETS)('⚠ « %s » n’en est PAS un', (phrase) => {
    expect(estUneParoleDArret(phrase)).toBe(false);
  });

  it('la fonction est PURE — aucune entrée-sortie dans ce module', () => {
    /* La décision d'arrêter ne doit pas pouvoir échouer parce qu'une base ne
       répond pas. Même raison que pour `intent/engine.ts`. */
    const src = readFileSync('src/core/safety/parole-d-arret.ts', 'utf8');
    for (const interdit of ['await ', 'Promise', 'db.', 'query(']) {
      expect(src, `« ${interdit} » n’a rien à faire ici`).not.toContain(interdit);
    }
  });
});

/* ====================================================================== *
 * 2. LE CHEMIN — l'Assistant court-circuite tout le reste
 * ====================================================================== */

function passerelleQuiCompte(calls: ToolCall[]): ToolGateway {
  return {
    register: () => ok(undefined),
    list: () => [],
    restoreTrust: () => Promise.resolve(ok(undefined)),
    invoke: (call: ToolCall): Promise<Result<GatewayResult>> => {
      calls.push(call);
      return Promise.resolve(
        err(jarvisError('INTERNAL', 'aucun outil ne devrait être appelé ici')),
      );
    },
  } as unknown as ToolGateway;
}

function assistantAvec(arret: ControleDArret, calls: ToolCall[]) {
  return createAssistant({
    arret,
    undo: undoDouble(),
    modePrive: modePriveDouble(),
    intent: createIntentEngine(),
    gateway: passerelleQuiCompte(calls),
    setGuardConfirmed: () => undefined,
    cloudEnabled: false,
    resolver: {
      resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
    },
    designation: {
      resoudre: () => Promise.resolve(ok({ kind: 'INTROUVABLE' as const, mention: 'x' })),
    },
    file: null,
    temps: {
      resoudre: () => Promise.resolve(ok({ iso: '2026-09-19T09:00:00Z', humain: 'jeudi' })),
      resoudreFenetre: () =>
        Promise.resolve(
          ok({
            debutIso: '2026-09-19T00:00:00Z',
            finIso: '2026-09-20T00:00:00Z',
            humain: 'jeudi',
          }),
        ),
    },
    tier1: null,
  });
}

describe('⚠ l’arrêt court-circuite TOUT — `docs/05 §C2`', () => {
  it('« Arrête tout » engage l’arrêt et n’invoque AUCUN outil', async () => {
    const calls: ToolCall[] = [];
    const arret = arretDouble({ annulees: 3, enVol: 1 });
    const reponse = await assistantAvec(arret, calls).say('Arrête tout', {
      surface: 'LOCALE',
    });

    expect(reponse.kind).toBe('ARRET');
    if (reponse.kind !== 'ARRET') return;
    expect(reponse.annulees).toBe(3);
    expect(reponse.enVol).toBe(1);

    /* ⚠ L'ASSERTION QUI PORTE LA DÉCISION D'`halt.ts` : le Policy Gate n'a
       PAS été consulté, parce qu'aucun outil n'a été invoqué. « Un arrêt
       d'urgence que la politique peut refuser n'est pas un arrêt d'urgence. » */
    expect(calls).toEqual([]);
  });

  it('le motif transporte la phrase EXACTE de l’utilisateur', async () => {
    /* Le journal doit pouvoir dire ce qui a été dit, pas « arrêt demandé ».
       Une ligne d'arrêt sans son déclencheur ne permet pas de comprendre,
       trois jours plus tard, pourquoi Jarvis s'est tu. */
    const arret = arretDouble();
    await assistantAvec(arret, []).say('Jarvis, stop.', { surface: 'LOCALE' });
    expect(arret.motifs).toHaveLength(1);
    expect(arret.motifs[0]).toContain('Jarvis, stop.');
  });

  it('⚠ il fonctionne depuis une surface DISTANTE — exception assumée à ADR-090', async () => {
    /* ADR-090 refuse les actions dangereuses venues d'un canal moins sûr.
       Arrêter va dans le sens inverse, et quelqu'un qui n'est pas devant sa
       machine est celui qui a le plus besoin de pouvoir dire stop.

       Si ce test rougit un jour parce que quelqu'un a « harmonisé » les
       surfaces, l'arrêt d'urgence sera devenu inaccessible depuis le téléphone
       — sans qu'aucune règle de sécurité n'ait été affaiblie en apparence. */
    const arret = arretDouble();
    const reponse = await assistantAvec(arret, []).say('stop', {
      surface: 'DISTANTE',
    });
    expect(reponse.kind).toBe('ARRET');
  });

  it('⚠ « arrête la tâche du plombier » suit son chemin ORDINAIRE', async () => {
    /* CONTRÔLE NÉGATIF DU PRÉCÉDENT, et il porte le risque réel : une garde
       trop large transformerait chaque annulation en paralysie. */
    const arret = arretDouble();
    const calls: ToolCall[] = [];
    const reponse = await assistantAvec(arret, calls).say(
      'Supprime la tâche du plombier',
      { surface: 'LOCALE' },
    );
    expect(arret.motifs, 'aucun arrêt ne doit être engagé').toEqual([]);
    expect(reponse.kind).not.toBe('ARRET');
  });

  it('un arrêt qui échoue ne prétend PAS avoir arrêté', async () => {
    /* Règle 3 de `CLAUDE.md`. Répondre « ARRÊTÉ » quand la base a refusé
       l'écriture serait le pire succès non vérifié du dépôt : l'utilisateur
       croirait Jarvis muet alors qu'il continue d'agir. */
    const cassé: ControleDArret = {
      etat: () => Promise.resolve(ok({ halted: false })),
      engager: (): Promise<Result<CompteRenduDArret>> =>
        Promise.resolve(err(jarvisError('INTERNAL', 'base injoignable'))),
      lever: () => Promise.resolve(ok(undefined)),
    };
    const reponse = await assistantAvec(cassé, []).say('stop', { surface: 'LOCALE' });
    expect(reponse.kind).toBe('ERROR');
  });

  it('⚠ l’arrêt est consulté AVANT le moteur d’intention', async () => {
    /* Mesuré, pas supposé : le `Tier 0` ne doit pas voir la phrase. S'il la
       voyait, une future règle « arrête … » pourrait la capturer avant, et
       l'arrêt d'urgence deviendrait un outil — ce qu'`halt.ts` refuse. */
    const propose = vi.fn(() => ({
      kind: 'UNSUPPORTED' as const,
      understood: '',
      missing: '',
    }));
    const reponse = await createAssistant({
      arret: arretDouble(),
      undo: undoDouble(),
    modePrive: modePriveDouble(),
      intent: { propose },
      gateway: passerelleQuiCompte([]),
      setGuardConfirmed: () => undefined,
      cloudEnabled: false,
      resolver: {
        resolveMention: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
        resolveAnaphora: () => Promise.resolve(ok({ kind: 'NOT_FOUND' as const, mention: 'x' })),
      },
      designation: {
        resoudre: () => Promise.resolve(ok({ kind: 'INTROUVABLE' as const, mention: 'x' })),
      },
      file: null,
      temps: {
        resoudre: () => Promise.resolve(ok({ iso: '2026-09-19T09:00:00Z', humain: 'j' })),
        resoudreFenetre: () =>
          Promise.resolve(
            ok({ debutIso: '2026-09-19T00:00:00Z', finIso: '2026-09-20T00:00:00Z', humain: 'j' }),
          ),
      },
      tier1: null,
    }).say('arrête tout', { surface: 'LOCALE' });

    expect(reponse.kind).toBe('ARRET');
    expect(propose, 'le Tier 0 ne doit pas voir la phrase').not.toHaveBeenCalled();
  });
});

/* ====================================================================== *
 * 3. LA DISSYMÉTRIE — lever n'est pas aussi facile qu'engager
 * ====================================================================== */

describe('⚠ lever un arrêt n’est PAS une phrase', () => {
  it('aucune phrase de levée n’est reconnue', () => {
    /* `halt.ts` : « sans cette dissymétrie, une injection indirecte pourrait
       enchaîner arrêt → levée et n'aurait fait que du bruit ».

       Reconnaître « reprends » comme on reconnaît « stop » les rendrait aussi
       faciles l'une que l'autre. La levée est une COMMANDE, tapée, avec une
       raison, sur la machine. */
    for (const phrase of ['reprends', 'redémarre', 'lève l’arrêt', 'continue', 'go']) {
      expect(estUneParoleDArret(phrase)).toBe(false);
    }
  });

  it('⚠ le CLI exige une RAISON pour lever', () => {
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain('/reprendre');
    expect(cli).toContain('runtime.value.arret.lever');
    expect(cli, 'une levée sans raison doit être refusée').toContain('raison.length === 0');
  });

  it('⚠ la passerelle web n’expose AUCUN moyen de lever', () => {
    /* Même frontière qu'ADR-101 pour la file : le téléphone peut ARRÊTER —
       c'est le sens sûr — mais il ne peut pas REPARTIR. */
    const ui = readFileSync('src/apps/server/ui.ts', 'utf8');
    const http = readFileSync('src/apps/server/http.ts', 'utf8');
    expect(ui).not.toContain('data-cmd="/reprendre"');
    expect(ui).not.toContain('/api/reprendre');
    expect(http).not.toContain('lever(');
  });

  it('CONTRÔLE — le téléphone peut bien ARRÊTER', () => {
    /* Sans lui, les trois assertions d'absence ci-dessus seraient vraies dans
       un système où le téléphone ne peut rien faire du tout. */
    const ui = readFileSync('src/apps/server/ui.ts', 'utf8');
    expect(ui).toContain("reply.kind === 'ARRET'");
  });
});

/* ====================================================================== *
 * 4. CE QUE L'ARRÊT BLOQUE VRAIMENT — éprouvé sur la boucle RÉELLE
 * ====================================================================== */

/**
 * ⚠ CE BLOC EXISTE PARCE QUE J'AI ÉCRIT UNE PHRASE FAUSSE.
 *
 * La première version de l'affichage disait *« Plus aucune action ne
 * passera »*. Trouvé en UTILISANT Jarvis, pas en le relisant : après « arrête
 * tout », « mes tâches » a répondu normalement.
 *
 * Le mécanisme n'a aucun défaut — ADR-057 laisse délibérément passer les
 * lectures locales (`L1 && !networkRequired`), parce qu'après avoir appuyé sur
 * le bouton on a PLUS besoin de comprendre, pas moins. C'est la phrase qui
 * mentait, et dans le sens le plus coûteux : **elle promettait une protection
 * plus large que la vraie.**
 *
 * Aucun test ne reliait le texte affiché au comportement observé. Celui-ci le
 * fait, et dans les deux sens : il éprouve le comportement sur la boucle
 * réelle, puis exige que les surfaces le DISENT.
 */
describe.skipIf(!databaseAvailable())(
  '⚠ un arrêt bloque les ÉCRITURES, pas les lectures locales',
  () => {
    let runtime: Runtime;

    beforeAll(() => {
      const built = buildRuntime(appDb());
      if (!built.ok) throw new Error(built.error.message);
      runtime = built.value;
    });

    afterAll(async () => {
      /* On lève avant de rendre la main : `fileParallelism: false` fait tourner
         les fichiers sur la MÊME base, et un arrêt oublié ici ferait échouer
         tous les bancs suivants avec un message parfaitement correct et
         parfaitement incompréhensible. */
      await runtime.arret.lever('fin du banc d’arrêt');
      await runtime.close();
    });

    it('engage, puis REFUSE une écriture, puis laisse passer une lecture', async () => {
      const arret = await runtime.assistant.say('arrête tout', { surface: 'LOCALE' });
      expect(arret.kind).toBe('ARRET');

      const ecriture = await runtime.assistant.say('Ajoute du ciment à ma liste', {
        surface: 'LOCALE',
      });
      /* L'écriture est refusée par le Tool Gateway, qui a LU l'état d'arrêt en
         base — jamais reçu dans un contexte (ADR-052, même discipline
         qu'`egress`). */
      expect(['DENIED', 'ERROR']).toContain(ecriture.kind);

      const lecture = await runtime.assistant.say('mes tâches', { surface: 'LOCALE' });
      expect(lecture.kind, 'une lecture locale doit rester possible').toBe('DONE');
    });

    it('et une fois LEVÉ, l’écriture repasse', async () => {
      /* CONTRÔLE : sans lui, le test précédent serait vrai dans un Jarvis
         définitivement cassé. */
      const leve = await runtime.arret.lever('vérification de bout en bout');
      expect(leve.ok, leve.ok ? '' : leve.error.message).toBe(true);

      const ecriture = await runtime.assistant.say('Ajoute du sable à ma liste', {
        surface: 'LOCALE',
      });
      expect(ecriture.kind).toBe('DONE');
    });

    it('⚠ et les SURFACES disent exactement ça — pas plus', () => {
      /* LA MOITIÉ QUI MANQUAIT. Le comportement ci-dessus était déjà juste
         avant cette ADR ; ce qui n'existait pas, c'est le lien entre lui et ce
         que Jarvis affiche. Deux registres du même fait (ADR-041) : l'un dans
         le Tool Gateway, l'autre dans une chaîne de caractères. */
      for (const [nom, source] of [
        ['CLI', readFileSync('src/apps/cli/main.ts', 'utf8')],
        ['passerelle web', readFileSync('src/apps/server/ui.ts', 'utf8')],
      ] as const) {
        expect(source, `${nom} : « nouvelle » qualifie ce qui est bloqué`).toContain(
          'Aucune action NOUVELLE ne passera',
        );
        expect(source, `${nom} : les lectures locales doivent être annoncées`).toContain(
          'Les lectures locales restent possibles',
        );
        expect(source, `${nom} : la promesse trop large ne doit pas revenir`).not.toContain(
          'Plus aucune action ne passera',
        );
      }
    });
  },
);
