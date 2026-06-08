export default [
  {
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-case-declarations': 'off',
      'no-unreachable': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: (await import("@typescript-eslint/parser")).default,
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-case-declarations': 'off',
      'no-unreachable': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    rules: {
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-console': 'off',
      'no-redeclare': 'off',
      'no-case-declarations': 'off',
      'no-unreachable': 'off',
    },
  }
];
