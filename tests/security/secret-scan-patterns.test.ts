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
import { isExcepted, PATTERNS } from '../../ops/security/scan-secrets.js';

/** Échantillons synthétiques. Aucun n'est un secret réel. */
const SHOULD_DETECT: Readonly<Record<string, string>> = {
  'Clé de style OpenAI': 'sk-proj_abcdefghijklmnopqrstuvwxyz012345',
  'Jeton GitHub': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'Clé AWS': 'AKIAIOSFODNN7EXAMPLE',
  'Clé Google': `AIza${'B'.repeat(39)}`, // volontairement plus longue que 35
  /* ADR-078 — les trois secrets qu'introduit l'adaptateur Google Agenda, et
     qu'aucun motif ne voyait avant lui. Les deux premiers sont PERMANENTS :
     leur fuite ne s'éteint pas toute seule. */
  'Secret client Google OAuth': 'GOCSPX-abcdefghijklmnopqrstuvwxyz01',
  'Jeton de rafraîchissement Google': `1//0e${'A'.repeat(40)}`,
  'Jeton d’accès Google': `ya29.${'a'.repeat(60)}`,
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

  it('CONTRÔLE NÉGATIF — les motifs Google OAuth ne mordent pas au hasard', () => {
    /* Un motif de sécurité trop large se paie en bruit, et le bruit se paie en
       exceptions — c'est-à-dire en trous. Ces trois chaînes ressemblent aux
       secrets sans en être, et doivent passer. */
    const oauth = PATTERNS.filter((p) => p.name.includes('Google'));
    expect(oauth.length).toBeGreaterThanOrEqual(4);
    for (const innocent of [
      'const url = "https://1//example";',
      'ya29 est un identifiant de test',
      'GOCSPX-court',
      'import { google } from "./google.js";',
    ]) {
      for (const motif of oauth) {
        expect(motif.regex.test(innocent), `${motif.name} ← ${innocent}`).toBe(false);
      }
    }
  });

  it('un NOM de variable d’environnement n’est pas un secret', () => {
    /* ⚠ PRÉCISION AJOUTÉE PAR ADR-079, ET ELLE A UN ENJEU.

       Le motif signalait `clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET'` — un nom,
       pas une valeur. Un faux positif n'est pas gratuit : il pousse à blanchir
       un fichier, et un fichier blanchi laisse passer le vrai secret qu'on y
       ajoutera plus tard. Ici, sur le fichier qui manipule les jetons OAuth.

       Une valeur entièrement en MAJUSCULES_AVEC_TIRETS_BAS est un identifiant
       par convention. Les jetons réels mêlent les casses. */
    const motif = PATTERNS.find((p) => p.name === 'Mot de passe en dur');
    expect(motif).toBeDefined();
    for (const nom of [
      "clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET'",
      "secret: 'STRIPE_WEBHOOK_SIGNING_SECRET'",
      'PASSWORD = "DATABASE_PASSWORD_ENV"',
    ]) {
      expect(motif?.regex.test(nom), nom).toBe(false);
    }
  });

  it('CONTRÔLE NÉGATIF — une VRAIE valeur reste attrapée', () => {
    /* Sans lui, l'exclusion ci-dessus pourrait être trop large et personne ne le
       verrait : le test précédent passerait d'autant mieux que le motif serait
       cassé. On lui donne des secrets de forme réaliste. */
    const motif = PATTERNS.find((p) => p.name === 'Mot de passe en dur');
    for (const vrai of [
      "clientSecret: 'GOCSPX-aB3dEf7hIjKlMnOpQrSt'",
      'password = "supersecret123"',
      "secret: 'ya29.a0AfB_byC-longue-valeur'",
      // Majuscules ET minuscules mêlées : ce n'est pas un nom d'identifiant.
      "secret = 'ABCDEF_ghijkl_123456'",
    ]) {
      expect(motif?.regex.test(vrai), vrai).toBe(true);
    }
  });

  it('reconnaît une clé Google plus longue que sa taille nominale', () => {
    // Régression : le `\b` final faisait échouer ce cas précis.
    const google = PATTERNS.find((p) => p.name === 'Clé Google');
    expect(google).toBeDefined();
    expect(google?.regex.test(`AIza${'C'.repeat(50)}`)).toBe(true);
  });

  /* ================================================================== *
   * L'ÉTROITESSE DES EXCEPTIONS
   *
   * Ajoutée après avoir constaté que mon premier contrôle négatif était
   * INVALIDE : le scanner lit `git show HEAD:<fichier>`, pas l'arbre de
   * travail. Injecter un faux secret dans un fichier non commité ne prouve
   * donc rien — le scan ne l'a jamais lu.
   *
   * La vérification se fait ici, au niveau où elle a un sens.
   * ================================================================== */

  describe('les exceptions blanchissent un COUPLE, jamais un fichier', () => {
    const FIXTURE = 'tests/golden/scenarios.test.ts';

    it("le scénario doré B11 est excepté pour le SEUL motif dont il a besoin", () => {
      /* La redaction de `logger.ts` reconnaît les secrets à leur FORME. Un
         fixture qui ne ressemblerait pas à une clé rendrait l'assertion de
         B11 creuse — elle passerait parce que rien ne correspond, non parce
         que la redaction fonctionne. */
      expect(isExcepted(FIXTURE, 'Clé de style OpenAI')).toBe(true);
    });

    it("le MÊME fichier reste surveillé pour tous les autres motifs", () => {
      // C'est ce que « couple » signifie, et c'est la seule chose qui
      // distingue une exception d'un blanchiment.
      for (const autre of [
        'Jeton GitHub',
        'Clé AWS',
        'Clé Google',
        'Clé Anthropic',
        'JWT',
        'Bloc de clé privée',
        'Mot de passe en dur',
      ]) {
        expect(isExcepted(FIXTURE, autre), autre).toBe(false);
      }
    });

    it("un fichier quelconque n'hérite d'aucune exception", () => {
      expect(isExcepted('src/core/tools/gateway.ts', 'Clé de style OpenAI')).toBe(false);
      expect(isExcepted('tests/golden/contract.test.ts', 'Clé de style OpenAI')).toBe(false);
    });
  });
});
