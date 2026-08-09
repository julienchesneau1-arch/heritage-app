// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `eslint.config.js` s'exclut lui-même : il n'est pas couvert par tsconfig,
  // et l'inclure demanderait `allowJs` pour un seul fichier d'outillage.
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      /* 06 — « un `as` sur une frontière est un défaut ».
         On ne peut pas distinguer statiquement « frontière » du reste, donc on
         interdit les assertions les plus dangereuses partout, et on force la
         validation Zod à l'entrée. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
    },
  },
  {
    // L'outillage d'exploitation a le droit d'écrire sur la sortie standard.
    files: ['ops/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
