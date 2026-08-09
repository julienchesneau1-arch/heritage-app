/**
 * Les secrets ne fuient-ils pas ?
 *
 * Invariant S3 / 03 §9 : un secret n'entre jamais dans un prompt, un log, la
 * mémoire, un message d'erreur, ou le dépôt.
 *
 * Les fuites de secrets ne viennent presque jamais d'un `console.log(apiKey)`
 * délibéré. Elles viennent d'une interpolation dans un message d'erreur, d'un
 * objet de contexte sérialisé, d'un `JSON.stringify` sur une configuration.
 * Ces tests visent ces chemins-là.
 */
import { describe, expect, it } from 'vitest';
import { createEnvSecretVault, Secret } from '../../src/core/secrets/vault.js';
import {
  createLogger,
  redact,
  redactString,
} from '../../src/core/observability/logger.js';

const CANARY = 'sk-canary_ThisMustNeverAppear_0123456789abcdef';

describe('enveloppe Secret', () => {
  const secret = new Secret('API_KEY', CANARY);

  it('n\'expose pas la valeur par interpolation', () => {
    expect(`clé = ${String(secret)}`).not.toContain(CANARY);
    expect(`clé = ${String(secret)}`).toContain('[REDACTED]');
  });

  it('n\'expose pas la valeur par sérialisation JSON', () => {
    expect(JSON.stringify({ secret })).not.toContain(CANARY);
  });

  it('n\'expose pas la valeur dans un objet imbriqué sérialisé', () => {
    const config = { db: { host: 'localhost', password: secret } };
    expect(JSON.stringify(config)).not.toContain(CANARY);
  });

  it('expose la valeur uniquement via expose()', () => {
    expect(secret.expose()).toBe(CANARY);
  });
});

describe('coffre', () => {
  it('renvoie une erreur nommant le secret, jamais sa valeur', () => {
    const vault = createEnvSecretVault({ PRESENT: CANARY });
    const missing = vault.get('ABSENT');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(JSON.stringify(missing.error)).not.toContain(CANARY);
      expect(missing.error.details?.['secretName']).toBe('ABSENT');
    }
  });

  it('traite une variable vide comme absente', () => {
    const vault = createEnvSecretVault({ EMPTY: '' });
    expect(vault.has('EMPTY')).toBe(false);
    expect(vault.get('EMPTY').ok).toBe(false);
  });
});

describe('redaction des journaux', () => {
  it('masque une clé de style OpenAI dans une chaîne libre', () => {
    expect(redactString(`échec avec ${CANARY}`)).not.toContain(CANARY);
  });

  it('masque un JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactString(jwt)).toBe('[REDACTED]');
  });

  it('masque un jeton GitHub', () => {
    expect(redactString('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain(
      '[REDACTED]',
    );
  });

  it('masque par nom de champ, quel que soit le contenu', () => {
    const redacted = redact({
      user: 'julien',
      password: 'nimportequoi',
      api_key: 'valeur',
      authorization: 'Bearer abc',
      nested: { dbPassword: 'x' },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('nimportequoi');
    expect(serialized).not.toContain('Bearer abc');
    expect(serialized).toContain('julien'); // le non-sensible reste lisible
  });

  it('ne journalise pas de contenu binaire brut', () => {
    const redacted = redact({ audio: new Uint8Array([1, 2, 3, 4]) });
    expect(JSON.stringify(redacted)).toContain('[binary 4o]');
  });

  it('borne la profondeur au lieu de boucler', () => {
    interface Deep { next?: Deep }
    const deep: Deep = {};
    let cursor = deep;
    for (let i = 0; i < 20; i += 1) {
      cursor.next = {};
      cursor = cursor.next;
    }
    expect(() => JSON.stringify(redact(deep))).not.toThrow();
  });

  it('le logger masque secrets et motifs sensibles', () => {
    const lines: string[] = [];
    const logger = createLogger({ minLevel: 'debug', sink: (l) => lines.push(l) });

    logger.info(`appel échoué avec ${CANARY}`, {
      apiKey: new Secret('API_KEY', CANARY),
      password: 'motdepasse',
      tool: 'web_search',
    });

    const output = lines.join('\n');
    expect(output).not.toContain(CANARY);
    expect(output).not.toContain('motdepasse');
    expect(output).toContain('web_search'); // le champ utile reste
  });
});
