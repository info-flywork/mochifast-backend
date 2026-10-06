import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // SQL enjeksiyonu: execute/query'ye interpolasyonlu template literal verilemez.
          // Dinamik kolon/sıralama gerekiyorsa whitelist sözlüğünden seçilmeli.
          selector:
            'CallExpression[callee.property.name=/^(execute|query)$/] > TemplateLiteral[expressions.length>0]',
          message:
            'SQL içinde ${…} interpolasyonu yasak. Placeholder (?, :name) kullan; dinamik kimlikler için whitelist.',
        },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
