/**
 * Chargement de configuration — c'est une frontière, donc elle est validée.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config/load.js';

const baseEnv = {
  JARVIS_ENV: 'test',
  JARVIS_DB_PASSWORD: 'x',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('charge la configuration de test', () => {
    const result = loadConfig({ env: baseEnv });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.public.environment).toBe('test');
      expect(result.value.public.database.name).toBe('jarvis_test');
    }
  });

  it('refuse un environnement inconnu', () => {
    const result = loadConfig({ env: { ...baseEnv, JARVIS_ENV: 'prod' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('CONFIGURATION');
  });

  it('refuse de démarrer sans le secret de base de données', () => {
    const result = loadConfig({ env: { JARVIS_ENV: 'test' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('JARVIS_DB_PASSWORD');
  });

  it('le budget cloud vaut 0 € par défaut (04 §9)', () => {
    const result = loadConfig({ env: baseEnv });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.public.cloud.budgetMonthlyEur).toBe(0);
  });

  it('le cloud est désactivé par défaut (invariant I2)', () => {
    const result = loadConfig({ env: baseEnv });
    if (result.ok) expect(result.value.public.cloud.enabled).toBe(false);
  });

  it('la télémétrie externe ne peut pas être activée par configuration', () => {
    const result = loadConfig({ env: baseEnv });
    if (result.ok) expect(result.value.public.privacy.externalTelemetry).toBe(false);
  });

  it('le refus est la décision par défaut du moteur de politique', () => {
    const result = loadConfig({ env: baseEnv });
    if (result.ok) expect(result.value.public.policy.defaultDecision).toBe('deny');
  });

  it('l\'environnement LAB démarre en mode privé (07 §5)', () => {
    const result = loadConfig({ env: { ...baseEnv, JARVIS_ENV: 'lab' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.public.privacy.startInPrivateMode).toBe(true);
      expect(result.value.public.cloud.enabled).toBe(false);
    }
  });

  it('la configuration publique ne contient aucun secret', () => {
    const result = loadConfig({ env: { ...baseEnv, JARVIS_DB_PASSWORD: 'canary_pw' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value.public)).not.toContain('canary_pw');
    }
  });
});
