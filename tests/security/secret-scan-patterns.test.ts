/**
 * Le scan de secrets détecte-t-il vraiment ?
 *
 * Ce test existe parce que la première version des motifs comportait un défaut
 * réel : une frontière de mot `\b` en fin d'expression empêchait de reconnaître
 * une clé plus longue que sa taille nominale. Le défaut n'était visible qu'en
 * confrontant les motifs à des échantillons — c'est-à-dire en testant la garde
 * plutôt qu'en la relisant.
 *
 * Un scan de sécurité doit préférer le faux positif au silence. Les deux
 * familles de cas sont donc vérifiées : ce qui doit être détecté, et ce qui ne
 * doit pas déclencher inutilement.
 */
import { describe, expect, it } from 'vitest';
import { PATTERNS } from '../../ops/security/scan-secrets.js';

/** Échantillons synthétiques. Aucun n'est un secret réel. */
const SHOULD_DETECT: Readonly<Record<string, string>> = {
  'Clé de style OpenAI': 'sk-proj_abcdefghijklmnopqrstuvwxyz012345',
  'Jeton GitHub': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'Clé AWS': 'AKIAIOSFODNN7EXAMPLE',
  'Clé Google': `AIza${'B'.repeat(39)}`, // volontairement plus longue que 35
  'Clé Anthropic': 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  'Bloc de clé privée': '-----BEGIN RSA PRIVATE KEY-----',
  JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  'Mot de passe en dur': 'password = "supersecret123"',
};

/** Code ordinaire : ne doit déclencher aucun motif. */
const SHOULD_NOT_DETECT: readonly string[] = [
  'const skip = true;',
  'if (secretVault.has("DB_PASSWORD")) { return; }',
  'AKIA est un préfixe de clé AWS',
  'const password = userInput;',
  'import { Secret } from "./vault.js";',
  '// le mot de passe ne doit jamais être journalisé',
];

describe('motifs du scan de secrets', () => {
  it('chaque motif a un échantillon de référence', () => {
    expect(PATTERNS.map((p) => p.name).sort()).toEqual(
      Object.keys(SHOULD_DETECT).sort(),
    );
  });

  for (const pattern of PATTERNS) {
    it(`détecte : ${pattern.name}`, () => {
      const sample = SHOULD_DETECT[pattern.name];
      expect(sample).toBeDefined();
      expect(pattern.regex.test(sample ?? '')).toBe(true);
    });
  }

  it('ne se déclenche pas sur du code ordinaire', () => {
    const falsePositives: string[] = [];
    for (const line of SHOULD_NOT_DETECT) {
      for (const { name, regex } of PATTERNS) {
        if (regex.test(line)) falsePositives.push(`${name} sur « ${line} »`);
      }
    }
    expect(falsePositives).toEqual([]);
  });

  it('reconnaît une clé Google plus longue que sa taille nominale', () => {
    // Régression : le `\b` final faisait échouer ce cas précis.
    const google = PATTERNS.find((p) => p.name === 'Clé Google');
    expect(google).toBeDefined();
    expect(google?.regex.test(`AIza${'C'.repeat(50)}`)).toBe(true);
  });
});
