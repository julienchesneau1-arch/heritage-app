import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Repart d'un schéma neuf : le journal étant append-only, il ne peut pas
    // être remis à zéro autrement. Voir tests/global-setup.ts.
    globalSetup: ['tests/global-setup.ts'],
    // Les tests de sécurité touchent des rôles PostgreSQL partagés : on évite
    // les interférences entre fichiers.
    fileParallelism: false,
    testTimeout: 30_000,
    reporters: ['default'],
  },
});
