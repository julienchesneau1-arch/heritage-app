/**
 * Intent Engine Tier 0 — règles déterministes, aucun modèle.
 *
 * Référence : PRD §21–23 et §32.
 *
 * Deux familles de tests comptent autant l'une que l'autre :
 * ce qui doit être reconnu, et ce qui doit être **honnêtement refusé**. Un
 * moteur d'intention qui devine produit des actions que personne n'a demandées.
 */
import { describe, expect, it } from 'vitest';
import { createIntentEngine } from '../../src/core/intent/engine.js';

const engine = createIntentEngine();

function toolCall(text: string) {
  const proposal = engine.propose(text);
  if (proposal.kind !== 'TOOL_CALL') {
    throw new Error(`attendu TOOL_CALL pour « ${text} », obtenu ${proposal.kind}`);
  }
  return proposal;
}

describe('reconnaissance des commandes', () => {
  it('05/A1 — « Ajoute du café à ma liste »', () => {
    const proposal = toolCall('Ajoute du café à ma liste');
    expect(proposal.toolId).toBe('task_create');
    expect(proposal.input['title']).toBe('du café');
    expect(proposal.tier).toBe(0);
  });

  it('« Rappelle-moi d\'appeler le plombier »', () => {
    const proposal = toolCall('Rappelle-moi d\'appeler le plombier');
    expect(proposal.toolId).toBe('task_create');
    expect(proposal.input['title']).toBe('appeler le plombier');
  });

  it('« Crée une tâche : réviser la chaudière »', () => {
    const proposal = toolCall('Crée une tâche : réviser la chaudière');
    expect(proposal.toolId).toBe('task_create');
    expect(proposal.input['title']).toBe('réviser la chaudière');
  });

  it('« Mes tâches »', () => {
    expect(toolCall('Mes tâches').toolId).toBe('task_list');
    expect(toolCall('Qu\'est-ce que j\'ai à faire ?').toolId).toBe('task_list');
  });

  it('« Note que le plombier passe jeudi »', () => {
    const proposal = toolCall('Note que le plombier passe jeudi');
    expect(proposal.toolId).toBe('note_create');
    expect(proposal.input['content']).toBe('le plombier passe jeudi');
  });

  it('« Retiens que Jean travaille chez Orano »', () => {
    const proposal = toolCall('Retiens que Jean travaille chez Orano');
    expect(proposal.toolId).toBe('memory_add');
    expect(proposal.input['content']).toBe('Jean travaille chez Orano');
    expect(proposal.input['sourceType']).toBe('USER_EXPLICIT');
  });

  it('05/A6 — « Qu\'est-ce qu\'on avait décidé concernant la déco ? »', () => {
    const proposal = toolCall('Qu\'est-ce qu\'on avait décidé concernant la déco ?');
    expect(proposal.toolId).toBe('memory_search');
    expect(String(proposal.input['query'])).toContain('déco');
  });

  it('« Que sais-tu sur le projet mariage ? »', () => {
    const proposal = toolCall('Que sais-tu sur le projet mariage ?');
    expect(proposal.toolId).toBe('memory_search');
    expect(proposal.input['query']).toBe('le projet mariage');
  });

  it('nettoie la ponctuation finale', () => {
    expect(toolCall('Note que ça marche !').input['content']).toBe('ça marche');
    expect(toolCall('Note que ça marche.').input['content']).toBe('ça marche');
  });
});

describe('provenance des paramètres', () => {
  it('le texte saisi par l\'utilisateur est fiable', () => {
    const proposal = toolCall('Note que le portail grince');
    expect(proposal.parameterProvenance['content']).toBe('USER');
  });

  it('les paramètres décidés par les règles portent SYSTEM, jamais USER', () => {
    // `sourceType` et `dataCategory` ne viennent pas de l'utilisateur : ils
    // sont décidés par la règle. Les marquer USER serait un mensonge sur la
    // provenance, et c'est précisément ce que le Policy Gate consomme.
    const proposal = toolCall('Retiens que Jean travaille chez Orano');
    expect(proposal.parameterProvenance['sourceType']).toBe('SYSTEM');
    expect(proposal.parameterProvenance['dataCategory']).toBe('SYSTEM');
  });

  it('aucun paramètre n\'est laissé sans provenance déclarée', () => {
    for (const text of [
      'Note que ça marche',
      'Ajoute du pain à ma liste',
      'Mes tâches',
      'Retiens que X',
      'Que sais-tu sur Y',
    ]) {
      const proposal = toolCall(text);
      for (const key of Object.keys(proposal.input)) {
        // Un paramètre non déclaré serait traité comme non fiable par le
        // Gateway — comportement sûr, mais qui produirait une confirmation
        // à chaque commande banale.
        if (key === 'source' || key === 'suggestedConfidence') continue;
        expect(proposal.parameterProvenance[key]).toBeDefined();
      }
    }
  });
});

describe('PRD §23 — échec explicite, jamais « je n\'ai pas compris »', () => {
  it('nomme une capacité reconnue mais absente', () => {
    const proposal = engine.propose('Envoie un mail à Paul');
    expect(proposal.kind).toBe('UNSUPPORTED');
    if (proposal.kind !== 'UNSUPPORTED') return;
    expect(proposal.understood).toContain('envoyer un message');
    expect(proposal.missing).toContain('pas encore construite');
  });

  it('distingue « pas compris » de « pas encore possible »', () => {
    const agenda = engine.propose('Déplace mon rendez-vous de jeudi');
    expect(agenda.kind).toBe('UNSUPPORTED');
    if (agenda.kind !== 'UNSUPPORTED') return;
    expect(agenda.understood).toContain('agenda');

    const charabia = engine.propose('zzz qwerty flurb');
    expect(charabia.kind).toBe('UNSUPPORTED');
    if (charabia.kind !== 'UNSUPPORTED') return;
    expect(charabia.missing).toContain('formulation');
  });

  it('propose toujours une sortie, jamais un simple refus', () => {
    const proposal = engine.propose('fais un truc');
    expect(proposal.kind).toBe('UNSUPPORTED');
    if (proposal.kind !== 'UNSUPPORTED') return;
    // On liste ce qu'on sait faire : l'utilisateur repart avec une action
    // possible, pas avec une impasse.
    expect(proposal.missing).toContain('note');
  });

  it('une saisie vide est traitée sans planter', () => {
    expect(engine.propose('').kind).toBe('UNSUPPORTED');
    expect(engine.propose('   ').kind).toBe('UNSUPPORTED');
  });

  it('demande précision quand la règle capture du vide', () => {
    const proposal = engine.propose('Note que');
    expect(proposal.kind).toBe('CLARIFY');
    if (proposal.kind === 'CLARIFY') {
      // Une seule question (PRD §85).
      expect(proposal.question.split('?').length - 1).toBe(1);
    }
  });
});

describe('confirmation implicite', () => {
  it('« retiens que X » vaut confirmation — pas de friction inutile', () => {
    // PRD §137 : une fonctionnalité qui ajoute plus de friction qu'elle n'en
    // retire est suspecte. Redemander « confirmes-tu ? » après un ordre de
    // mémorisation explicite serait exactement cela.
    expect(toolCall('Retiens que Jean travaille chez Orano').userConfirms).toBe(
      true,
    );
  });

  it('aucune autre commande ne vaut confirmation', () => {
    for (const text of [
      'Note que ça marche',
      'Ajoute du pain à ma liste',
      'Mes tâches',
      'Que sais-tu sur Jean',
    ]) {
      expect(toolCall(text).userConfirms).toBe(false);
    }
  });
});

describe('le moteur ne décide rien', () => {
  it('ne produit jamais qu\'une proposition — aucune exécution', () => {
    const proposal = toolCall('Ajoute du café à ma liste');
    // Pas de champ « autorisé », « exécuté », « confirmé ». La proposition
    // traverse le Policy Gate comme n'importe quelle autre.
    expect(Object.keys(proposal).sort()).toEqual([
      'confidence',
      'input',
      'kind',
      'parameterProvenance',
      'tier',
      'toolId',
      'userConfirms',
    ]);
  });

  it('reste au Tier 0 : aucun appel de modèle', () => {
    for (const text of ['Note que X', 'Mes tâches', 'Retiens que Y']) {
      expect(toolCall(text).tier).toBe(0);
    }
  });
});
