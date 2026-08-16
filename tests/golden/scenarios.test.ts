/**
 * SCÉNARIOS DORÉS — ceux que `docs/28` a trouvés sans test.
 *
 * `docs/05` en compte trente ; quatorze n'étaient référencés nulle part.
 * Trois cas de figure, et la distinction compte plus que le décompte :
 *
 *   ÉCRIT ICI     la capacité existe, le test manquait      → ce fichier
 *   RATTACHÉ      la propriété était déjà éprouvée ailleurs → l'identifiant
 *                 sans porter le nom du scénario              est ajouté au test
 *   BLOQUÉ        la capacité n'existe pas                  → `contract.test.ts`
 *
 * La deuxième catégorie mérite un mot : mettre en scène une capacité absente
 * ne prouverait que la mise en scène. Et dupliquer un test qui existe déjà
 * ailleurs, sous un autre nom, produirait deux vérités à maintenir.
 *
 * ⚠ INFRASTRUCTURE DE TEST.
 */
import { describe, expect, it } from 'vitest';
import { createIntentEngine } from '../../src/core/intent/engine.js';
import { createEnvSecretVault } from '../../src/core/secrets/vault.js';
import { redact } from '../../src/core/observability/logger.js';
import { isPrivateAddress, validateTokenStrength } from '../../src/apps/server/auth.js';

describe('docs/05 — scénarios dorés jusque-là sans test', () => {
  /* ================================================================== *
   * A4 — Échec explicite
   * ================================================================== */

  describe('A4 — échec explicite', () => {
    const engine = createIntentEngine();

    it('A4 — dit ce qui a été COMPRIS et ce qui MANQUE', () => {
      /* `docs/05` interdit nommément « Désolé, je n'ai pas compris ». Ce n'est
         pas une question de politesse : une excuse ne dit rien, alors que
         « j'ai compris X, il me manque Y » est une information sur laquelle
         l'utilisateur peut agir. */
      const proposal = engine.propose('Crée un rendez-vous avec Jean.');

      if (proposal.kind === 'UNSUPPORTED') {
        expect(proposal.understood.length).toBeGreaterThan(0);
        expect(proposal.missing.length).toBeGreaterThan(0);

        // L'INTERDIT du scénario, vérifié littéralement.
        const phrase = `${proposal.understood} ${proposal.missing}`.toLowerCase();
        expect(phrase).not.toContain("je n'ai pas compris");
        expect(phrase).not.toContain('désolé');
      } else {
        /* Une clarification est l'autre réponse acceptable — elle informe
           aussi. Ce qui serait refusé, c'est d'exécuter à l'aveugle. */
        expect(proposal.kind).toBe('CLARIFY');
      }
    });

    it("A4 — l'interdit est tenu par le TYPAGE, pas par la discipline", () => {
      /* La garantie la plus forte n'est pas ce test : c'est que la variante
         `UNSUPPORTED` exige `understood` ET `missing`. On ne PEUT pas écrire
         « je n'ai pas compris » sans dire ce qu'on a compris — l'excuse creuse
         n'est pas représentable. */
      const proposal = engine.propose('azertyuiop qsdfghjklm wxcvbn');
      if (proposal.kind !== 'UNSUPPORTED') return;
      expect(typeof proposal.understood).toBe('string');
      expect(typeof proposal.missing).toBe('string');
      expect(proposal.understood.trim().length).toBeGreaterThan(0);
    });
  });

  /* ================================================================== *
   * B11 — Demande de secret
   * ================================================================== */

  describe('B11 — demande de secret', () => {
    it('B11 — un secret ne traverse aucune des trois surfaces exposables', () => {
      /* L'INTERDIT : « que le secret apparaisse dans un contexte modèle, un
         log ou une réponse ». Les trois sont éprouvées. */
      const vault = createEnvSecretVault({
        OPENAI_API_KEY: 'sk-secret-a-ne-jamais-voir',
      });
      const secret = vault.get('OPENAI_API_KEY');
      expect(secret.ok).toBe(true);
      if (!secret.ok) return;

      /* (1) LA SÉRIALISATION. Le piège le plus courant, parce qu'un objet
             finit toujours par passer dans un `JSON.stringify` — un corps de
             requête, une réponse d'API, un contexte modèle. */
      expect(JSON.stringify(secret.value)).not.toContain('sk-secret');
      expect(String(secret.value)).not.toContain('sk-secret');
      expect(`${String(secret.value)}`).not.toContain('sk-secret');

      // (2) LE JOURNAL applicatif efface la valeur.
      const journalise = JSON.stringify(
        redact({ requete: 'clé = sk-secret-a-ne-jamais-voir' }),
      );
      expect(journalise).not.toContain('sk-secret-a-ne-jamais-voir');

      /* (3) LA LECTURE est possible, mais seulement par un appel EXPLICITE et
             nommé. C'est ce qui rend toute fuite volontaire, donc visible en
             revue — plutôt qu'accidentelle. */
      expect(secret.value.expose()).toBe('sk-secret-a-ne-jamais-voir');
    });

    it("B11 — un secret inconnu est refusé sans révéler ceux qui existent", () => {
      const vault = createEnvSecretVault({ OPENAI_API_KEY: 'sk-x' });
      const absent = vault.get('CLE_INEXISTANTE');
      expect(absent.ok).toBe(false);
      if (absent.ok) return;
      // Énumérer les secrets présents renseignerait un appelant hostile.
      expect(absent.error.message).not.toContain('OPENAI_API_KEY');
      expect(absent.error.message).not.toContain('sk-x');
    });
  });

  /* ================================================================== *
   * B14 — Ouverture réseau non décidée
   * ================================================================== */

  describe('B14 — ouverture réseau non décidée', () => {
    it('B14 — une adresse publique n\'est jamais prise pour une adresse privée', () => {
      /* Le scénario exige un REFUS DE DÉMARRER, pas un avertissement : « un
         serveur qui démarre en signalant un problème est un serveur qui
         tourne ». Le refus repose entièrement sur cette classification. */
      expect(isPrivateAddress('0.0.0.0')).toBe(false);
      expect(isPrivateAddress('::')).toBe(false);

      // Et le cas normal ne doit pas déclencher un refus injustifié — une
      // garde qui bloque le démarrage légitime finit désactivée.
      expect(isPrivateAddress('127.0.0.1')).toBe(true);
      expect(isPrivateAddress('192.168.1.10')).toBe(true);
    });

    it('B14 — un jeton absent ou faible empêche le démarrage', () => {
      // Les deux autres conditions du scénario, à côté de l'interface.
      expect(validateTokenStrength(undefined).valid).toBe(false);
      expect(validateTokenStrength('').valid).toBe(false);
      expect(validateTokenStrength('trop-court').valid).toBe(false);
      expect(validateTokenStrength('x'.repeat(64)).valid).toBe(true);
    });
  });
});
