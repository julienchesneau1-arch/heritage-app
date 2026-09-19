/**
 * LE MODE PRIVÉ — la règle existait, personne ne pouvait l'atteindre — ADR-106.
 *
 * `gate.ts` refuse toute égression quand `context.mode === 'PRIVATE'`. C'était
 * écrit, testé, et **les deux surfaces envoyaient `NORMAL`** : le régime que
 * `docs/02` nomme comme livrable de Phase 4 — « Mode privé (cloud OFF, réseau
 * externe OFF, indicateur visible) » — n'était accessible par aucune phrase,
 * aucun bouton, aucune commande.
 *
 * ⚠ LA PROPRIÉTÉ QUI COMPTE n'est pas « la phrase marche ». C'est que le mode
 * soit **lu** par le Tool Gateway et non **reçu** de l'appelant : sinon il
 * suffirait d'envoyer `NORMAL` pour le désactiver sans jamais le lever.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appDb, databaseAvailable } from '../helpers/db.js';
import { buildRuntime, type Runtime } from '../../src/apps/runtime.js';
import { estUnPassageEnModePrive } from '../../src/core/privacy/parole.js';
import { createAssistant, type AssistantDeps } from '../../src/core/assistant.js';
import { createIntentEngine } from '../../src/core/intent/engine.js';
import { ok, err, jarvisError, type Result } from '../../src/core/types/result.js';
import { sansCommentaires } from '../helpers/source.js';
import { arretDouble } from '../helpers/arret.js';
import { undoDouble } from '../helpers/undo.js';
import { modePriveDouble } from '../helpers/mode-prive.js';
import type { ModePrive } from '../../src/core/privacy/mode-prive.js';
import type { GatewayResult, ToolCall, ToolGateway } from '../../src/core/tools/gateway.js';

/* ====================================================================== *
 * 1. LA RECONNAISSANCE
 * ====================================================================== */

describe('les phrases qui font passer en mode privé', () => {
  const OUI = [
    'mode privé',
    'Mode privé.',
    'passe en mode privé',
    'Passe en mode privé !',
    'passe au mode privé',
    'active le mode privé',
    'mets-toi en mode privé',
    'coupe le réseau',
    'coupe internet',
    'ne sors rien',
    'ne sors rien de la machine',
  ];

  it.each(OUI)('« %s » active le mode privé', (phrase) => {
    expect(estUnPassageEnModePrive(phrase)).toBe(true);
  });

  const NON = [
    'note que je préfère le mode privé',
    'retiens que le mode privé existe',
    'sors du mode privé',
    'désactive le mode privé',
    'quitte le mode privé',
    'qu’est-ce que le mode privé',
  ];

  it.each(NON)('⚠ « %s » n’active PAS le mode privé', (phrase) => {
    expect(estUnPassageEnModePrive(phrase)).toBe(false);
  });

  it('⚠ AUCUNE phrase ne le DÉSACTIVE — la dissymétrie d’`halt.ts`', () => {
    /* Activer va dans le sens sûr ; désactiver rend à Jarvis le droit de
       parler à l'extérieur. Si « sors du mode privé » était une phrase,
       quelqu'un détenant le jeton du téléphone pourrait rouvrir le réseau à
       distance — et l'utilisateur ne verrait qu'un indicateur éteint, ce qu'il
       lit comme « normal ».

       Les trois formulations les plus naturelles sont éprouvées ci-dessus.
       Celle-ci tient la RÈGLE : la sortie est une commande locale. */
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain("line === '/normal'");
    expect(cli).toContain('runtime.value.modePrive.lever');
    expect(cli, 'une levée sans raison doit être refusée').toContain(
      'raison.length === 0',
    );

    const ui = readFileSync('src/apps/server/ui.ts', 'utf8');
    expect(ui, 'aucun bouton de sortie sur le téléphone').not.toContain(
      'data-phrase="sors du mode privé"',
    );
    expect(ui).not.toContain('/api/normal');
  });

  it('la fonction est PURE', () => {
    const src = readFileSync('src/core/privacy/parole.ts', 'utf8');
    for (const interdit of ['await ', 'Promise', 'db.', 'query(']) {
      expect(src, `« ${interdit} » n’a rien à faire ici`).not.toContain(interdit);
    }
  });
});

/* ====================================================================== *
 * 2. LE CHEMIN
 * ====================================================================== */

function assistantAvec(modePrive: ModePrive, calls: ToolCall[] = []) {
  const deps: AssistantDeps = {
    arret: arretDouble(),
    undo: undoDouble(),
    modePrive,
    // ADR-107 — sans mémoire d'affichage, un ordinal DEMANDE. C'est le défaut.
    affichage: null,
    intent: createIntentEngine(),
    gateway: {
      register: () => ok(undefined),
      list: () => [],
      restoreTrust: () => Promise.resolve(ok(undefined)),
      invoke: (call: ToolCall): Promise<Result<GatewayResult>> => {
        calls.push(call);
        return Promise.resolve(err(jarvisError('INTERNAL', 'aucun outil attendu')));
      },
    } as unknown as ToolGateway,
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
  };
  return createAssistant(deps);
}

describe('la phrase atteint le mode privé', () => {
  it('« passe en mode privé » l’active, sans invoquer aucun outil', async () => {
    /* Un changement de RÉGIME, pas un appel d'outil. Lui inventer un `toolId`
       le ferait traverser le Policy Gate — c'est-à-dire soumettre à la
       politique le geste qui la durcit. */
    const calls: ToolCall[] = [];
    const mode = modePriveDouble();
    const r = await assistantAvec(mode, calls).say('passe en mode privé', {
      surface: 'LOCALE',
    });

    expect(r.kind).toBe('MODE_PRIVE');
    if (r.kind !== 'MODE_PRIVE') return;
    expect(r.dejaActif).toBe(false);
    expect(calls).toEqual([]);
    expect(mode.motifs[0], 'le motif transporte la phrase').toContain('mode privé');
  });

  it('⚠ il fonctionne depuis une surface DISTANTE — sens sûr, comme l’arrêt', async () => {
    const r = await assistantAvec(modePriveDouble()).say('mode privé', {
      surface: 'DISTANTE',
    });
    expect(r.kind).toBe('MODE_PRIVE');
  });

  it('⚠ « il l’était déjà » se DIT — une bascule qui ne bascule rien', async () => {
    /* Annoncer un changement qui n'a pas eu lieu apprend à l'utilisateur que
       ses commandes font quelque chose même quand elles ne font rien. C'est
       ce qui rend les confirmations creuses. */
    const vieux = new Date(Date.now() - 60_000).toISOString();
    const r = await assistantAvec(modePriveDouble(vieux)).say('mode privé', {
      surface: 'LOCALE',
    });
    expect(r.kind).toBe('MODE_PRIVE');
    if (r.kind !== 'MODE_PRIVE') return;
    expect(r.dejaActif).toBe(true);
    expect(r.depuis).toBe(vieux);
  });

  it('une activation qui ÉCHOUE ne prétend pas avoir réussi', async () => {
    const casse: ModePrive = {
      etat: () => Promise.resolve(ok({ actif: false })),
      activer: () => Promise.resolve(err(jarvisError('INTERNAL', 'base injoignable'))),
      lever: () => Promise.resolve(ok(undefined)),
    };
    const r = await assistantAvec(casse).say('mode privé', { surface: 'LOCALE' });
    expect(r.kind).toBe('ERROR');
  });
});

/* ====================================================================== *
 * 3. ⚠ LE MODE EST LU, JAMAIS REÇU
 * ====================================================================== */

describe('⚠ le Tool Gateway DURCIT le mode depuis la base', () => {
  it('il lit l’état plutôt que de croire l’appelant', () => {
    /* LA PROPRIÉTÉ CENTRALE. `gate.ts` refuse l'égression sur
       `context.mode === 'PRIVATE'`. Si ce champ venait de l'appelant SEUL, il
       suffirait d'envoyer `NORMAL` pour désactiver le mode privé sans jamais
       le lever — la même faille que pour `egress` (ADR-052) et pour l'arrêt
       d'urgence (ADR-057). */
    const gw = sansCommentaires(readFileSync('src/core/tools/gateway.ts', 'utf8'));
    expect(gw, 'le Gateway doit LIRE l’état').toContain('await modePrive.etat()');
    expect(gw, 'et poser le mode qu’il a calculé').toContain('mode: modeEffectif');
    expect(gw, 'jamais celui de l’appelant seul').not.toContain(
      'mode: call.context.mode',
    );
  });

  it('⚠ la lecture ne peut que DURCIR, jamais assouplir', () => {
    /* `strictest()` du Policy Gate, appliqué à une autre dimension : un
       appelant qui demande déjà `PRIVATE` le reste. La base ne peut pas lui
       rendre le droit de sortir. */
    const gw = sansCommentaires(readFileSync('src/core/tools/gateway.ts', 'utf8'));
    const bloc = /const modeEffectif =[\s\S]{0,260}?;/u.exec(gw)?.[0] ?? '';
    expect(bloc, 'le calcul du mode effectif est introuvable').not.toBe('');
    expect(bloc).toContain("'PRIVATE'");
    expect(bloc).toContain('call.context.mode');
  });

  it('⚠ un état ILLISIBLE vaut PRIVÉ — et le repli est l’inverse de l’arrêt', () => {
    /* L'arrêt d'urgence refuse TOUTE action quand son état est illisible : un
       arrêt inconnu affecte tout. Un mode privé inconnu n'affecte que le droit
       de SORTIR — se croire privé bloque l'égression et rien d'autre. Refuser
       toute action serait plus strict sans être plus sûr. */
    const gw = sansCommentaires(readFileSync('src/core/tools/gateway.ts', 'utf8'));
    const bloc = /const modeEffectif =[\s\S]{0,260}?;/u.exec(gw)?.[0] ?? '';
    expect(bloc, 'l’échec de lecture doit mener à PRIVATE').toContain('!prive.ok');
  });

  it('⚠ `ModePrive` est CONSTRUIT dans le Gateway, pas injecté', () => {
    /* Même raison qu'`EmergencyHalt` : une dépendance injectée serait
       remplaçable par une doublure qui répond toujours « pas privé », et la
       protection ne serait plus jamais éprouvée de bout en bout. */
    const gw = sansCommentaires(readFileSync('src/core/tools/gateway.ts', 'utf8'));
    expect(gw).toContain('createModePrive(deps.db)');
  });
});

/* ====================================================================== *
 * 4. LA CLÉ DE CONFIGURATION EST ENFIN LUE
 * ====================================================================== */

describe('⚠ `privacy.startInPrivateMode` n’était lue par PERSONNE', () => {
  it('le runtime la transmet au Gateway', () => {
    /* Même famille que `cloud.enabled` avant ADR-069 : une clé déclarée dans
       le schéma, documentée « mode privé actif au démarrage ? », et que rien
       ne consultait. Un utilisateur qui se croit protégé par son choix. */
    const runtime = sansCommentaires(readFileSync('src/apps/runtime.ts', 'utf8'));
    expect(runtime).toContain('config.value.public.privacy.startInPrivateMode');
    expect(runtime).toContain('startInPrivateMode:');
  });

  it('le Gateway en tient compte', () => {
    const gw = sansCommentaires(readFileSync('src/core/tools/gateway.ts', 'utf8'));
    expect(gw).toContain('deps.startInPrivateMode === true');
  });

  it('⚠ et le défaut reste `false` — un défaut ne surprend pas', () => {
    const defaut: unknown = JSON.parse(readFileSync('config/default.json', 'utf8'));
    const lu = defaut as { privacy?: { startInPrivateMode?: boolean } };
    expect(lu.privacy?.startInPrivateMode).toBe(false);
  });
});

/* ====================================================================== *
 * 5. L'INDICATEUR VISIBLE — `docs/02` l'exige nommément
 * ====================================================================== */

describe('⚠ « indicateur visible » — la troisième moitié du livrable', () => {
  it('le téléphone porte un badge dans l’EN-TÊTE, pas dans un menu', () => {
    /* Un indicateur qu'il faut aller chercher ne répond pas à la question
       « est-ce que quelque chose peut sortir d'ici ? » au moment où on se la
       pose. */
    const ui = readFileSync('src/apps/server/ui.ts', 'utf8');
    expect(ui).toContain('id="prive"');
    expect(ui).toContain('badgePrive');
  });

  it('⚠ et il est lu AU CHARGEMENT, pas seulement après une bascule', () => {
    /* Le mode privé vit en base : il survit aux redémarrages et il est partagé
       entre le CLI et la passerelle. Un badge qui n'apparaîtrait qu'après
       l'avoir activé DANS CET ONGLET mentirait à chaque réouverture. */
    const ui = readFileSync('src/apps/server/ui.ts', 'utf8');
    expect(ui).toContain("api('/api/diagnostic')).modePrive");
  });

  it('le diagnostic le rend sur les DEUX surfaces', () => {
    const cli = readFileSync('src/apps/cli/main.ts', 'utf8');
    expect(cli).toContain('Mode privé');
    const ui = readFileSync('src/apps/server/ui.ts', 'utf8');
    expect(ui).toContain("'Mode privé '");
  });

  it('⚠ un état ILLISIBLE s’affiche ACTIF — les deux registres dans le même sens', () => {
    /* Le Gateway durcit en `PRIVATE` quand il ne sait pas. Si l'indicateur
       affichait `false` dans le même cas, l'utilisateur croirait le réseau
       ouvert alors qu'il est fermé — deux registres du même fait qui se
       contredisent (ADR-041), sur la protection qu'il pense la plus simple. */
    const rapports = readFileSync('src/apps/reports.ts', 'utf8');
    expect(rapports).toContain('!etat.ok || etat.value.actif');
  });
});

/* ====================================================================== *
 * 6. LE COMPORTEMENT, SUR LA BOUCLE RÉELLE
 * ====================================================================== */

/**
 * ⚠ LES CINQ BLOCS CI-DESSUS SONT TEXTUELS. Ils tiennent la FORME de la garde
 * — et une forme juste peut encadrer un comportement faux.
 *
 * Celui-ci mesure ce qui compte : avec le mode privé actif, une demande qui
 * doit sortir de la machine est REFUSÉE, et le refus le dit. Sans lui, tout ce
 * fichier prouverait seulement que j'ai bien écrit ce que je voulais écrire.
 */
describe.skipIf(!databaseAvailable())(
  '⚠ mode privé actif : ce qui doit sortir ne sort pas',
  () => {
    let runtime: Runtime;

    beforeAll(() => {
      const built = buildRuntime(appDb());
      if (!built.ok) throw new Error(built.error.message);
      runtime = built.value;
    });

    afterAll(async () => {
      /* On lève avant de rendre la main : `fileParallelism: false` fait tourner
         les fichiers sur la MÊME base, et un mode privé oublié ferait échouer
         toute égression des bancs suivants — avec un message parfaitement
         correct et parfaitement incompréhensible. */
      await runtime.modePrive.lever('fin du banc mode privé');
      await runtime.close();
    });

    it('la phrase active, la recherche web est refusée, la levée la rouvre', async () => {
      const actif = await runtime.assistant.say('passe en mode privé', {
        surface: 'LOCALE',
      });
      expect(actif.kind).toBe('MODE_PRIVE');

      const sortie = await runtime.assistant.say(
        'cherche sur le web le prix du carrelage',
        { surface: 'LOCALE' },
      );
      /* ⚠ LE REFUS DOIT NOMMER LE MODE PRIVÉ. « Indisponible » enverrait
         l'utilisateur chercher une panne là où il y a une DÉCISION — la sienne,
         prise une minute plus tôt. */
      expect(['DENIED', 'ERROR']).toContain(sortie.kind);
      const dit =
        sortie.kind === 'DENIED'
          ? sortie.reason
          : sortie.kind === 'ERROR'
            ? sortie.message
            : '';
      expect(dit.toLowerCase()).toContain('privé');

      const leve = await runtime.modePrive.lever('vérification de bout en bout');
      expect(leve.ok, leve.ok ? '' : leve.error.message).toBe(true);

      /* CONTRÔLE : sans lui, l'assertion ci-dessus serait vraie dans un Jarvis
         qui refuse tout, pour toujours. Après la levée, le refus change de
         raison — il ne parle plus de mode privé. */
      const apres = await runtime.assistant.say(
        'cherche sur le web le prix du carrelage',
        { surface: 'LOCALE' },
      );
      const ditApres =
        apres.kind === 'DENIED'
          ? apres.reason
          : apres.kind === 'ERROR'
            ? apres.message
            : '';
      expect(ditApres.toLowerCase()).not.toContain('mode privé');
    });

    it('⚠ une LECTURE LOCALE reste possible en mode privé', async () => {
      /* Le mode privé ferme le RÉSEAU, pas Jarvis. Confondre les deux ferait
         d'une protection un interrupteur d'arrêt — et personne ne l'activerait
         jamais. */
      const actif = await runtime.modePrive.activer('banc : lectures locales');
      expect(actif.ok).toBe(true);

      const lecture = await runtime.assistant.say('mes tâches', { surface: 'LOCALE' });
      expect(lecture.kind).toBe('DONE');

      await runtime.modePrive.lever('fin du contrôle');
    });

    it('activer deux fois ne casse rien, et le dit', async () => {
      const un = await runtime.modePrive.activer('premier');
      const deux = await runtime.modePrive.activer('second');
      expect(un.ok && deux.ok).toBe(true);
      if (!un.ok || !deux.ok) return;
      /* L'index unique de la base garantit une seule ligne active ; le second
         appel rend l'existante, avec son motif d'origine. Quelqu'un qui répète
         n'est pas en faute, il n'est pas sûr. */
      expect(deux.value.depuis).toBe(un.value.depuis);
      expect(deux.value.motif).toBe('premier');
      await runtime.modePrive.lever('fin');
    });

    it('⚠ lever un mode INACTIF est une erreur, pas un succès muet', async () => {
      const leve = await runtime.modePrive.lever('alors qu’il n’est pas actif');
      expect(leve.ok).toBe(false);
      if (leve.ok) return;
      expect(leve.error.kind).toBe('NOT_FOUND');
    });
  },
);
