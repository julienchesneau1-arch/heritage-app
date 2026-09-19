/**
 * LE CONTRÔLE NÉGATIF DU DÉPOUILLEUR — ADR-105.
 *
 * ⚠ SON MODE DE PANNE EST SILENCIEUX ET TOTAL. Si `sansCommentaires` rendait
 * la chaîne vide, ou mangeait le code en plus des commentaires, **toutes** les
 * gardes qui s'en servent deviendraient vertes d'un coup :
 *
 *   « le routeur ne connaît pas le CostGate »      → vrai sur du vide
 *   « le noyau audio ne nomme aucun moteur »        → vrai sur du vide
 *   « la file ne connaît pas l'Undo Engine »        → vrai sur du vide
 *
 * Trois propriétés de sécurité perdues sans qu'aucun test ne rougisse. Ce
 * fichier est la seule chose qui s'y oppose.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { describe, expect, it } from 'vitest';
import { sansCommentaires } from './source.js';

describe('sansCommentaires', () => {
  it('retire un commentaire de bloc', () => {
    expect(sansCommentaires('/* interdit */ const a = 1;')).not.toContain('interdit');
  });

  it('retire un commentaire de ligne', () => {
    expect(sansCommentaires('  // interdit\nconst a = 1;')).not.toContain('interdit');
  });

  it('⚠ LAISSE le code — sans quoi les gardes seraient aveugles', () => {
    const faux = [
      '/* un commentaire qui cite gpt-4 sans conséquence */',
      '// et une ligne qui parle de whisper',
      "const MODELE = 'gpt-4-turbo';",
      "import { x } from '../cost/gate.js';",
      'undo.undoOperation(id);',
    ].join('\n');
    const nu = sansCommentaires(faux);

    expect(nu, 'le commentaire de bloc doit avoir disparu').not.toContain('sans conséquence');
    expect(nu, 'le commentaire de ligne doit avoir disparu').not.toContain('parle de whisper');
    expect(nu, 'une constante doit rester visible').toContain('gpt-4-turbo');
    expect(nu, 'un import réel doit rester visible').toContain('cost/gate');
    expect(nu, 'un appel réel doit rester visible').toContain('undoOperation');
  });

  it('⚠ ne rend PAS une chaîne vide sur un fichier réel', () => {
    /* Le mode de panne le plus dangereux, mesuré sur du vrai code plutôt que
       sur un exemple choisi pour réussir. */
    const nu = sansCommentaires(
      "import { z } from 'zod';\n/** doc */\nexport const A = z.string();\n",
    );
    expect(nu.trim().length).toBeGreaterThan(20);
    expect(nu).toContain('z.string()');
  });
});
