import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

// Gate independente focado em erros lógicos; não equivale ao conjunto completo do SonarQube.
export default [{
  files: ['src/**/*.ts'],
  ignores: ['**/*.spec.ts', '**/tests/**'],
  languageOptions: { parser: tseslint.parser },
  plugins: { sonarjs },
  rules: {
    'sonarjs/no-identical-expressions': 'error',
    'sonarjs/no-identical-conditions': 'error',
    'sonarjs/no-duplicate-in-composite': 'error',
    'sonarjs/no-collection-size-mischeck': 'error',
    'sonarjs/duplicates-in-character-class': 'error',
    'sonarjs/unverified-certificate': 'error',
    'sonarjs/weak-ssl': 'error',
    'sonarjs/no-weak-cipher': 'error',
    'sonarjs/insecure-jwt-token': 'error',
  },
}];
