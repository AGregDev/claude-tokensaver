import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['node_modules/', 'dist/', 'coverage/', '.claude-plugin/types/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Data that crosses a boundary is parsed, never asserted.
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: ['variable', 'parameter'],
          types: ['boolean'],
          format: ['PascalCase'],
          prefix: ['is', 'has', 'should', 'was', 'had', 'can', 'did'],
        },
      ],
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      'no-else-return': 'error',
      'no-param-reassign': 'error',
      'object-shorthand': 'error',
      'prefer-const': 'error',
      'prefer-template': 'error',
    },
  },
  {
    // The state contract must use `interface` to merge into Claude Code's own.
    files: ['types/**/*.d.ts'],
    rules: { '@typescript-eslint/consistent-type-definitions': 'off' },
  },
  {
    // The hooks module compiles JSX against Claude Code's global `h`.
    files: ['hooks/**/*.tsx'],
    languageOptions: { globals: { h: 'readonly', Fragment: 'readonly' } },
  },
  {
    // Files typed against Claude Code's mod API. This rule does not terminate
    // over the unions in those types (measured: over 100 s on one file, 2 s
    // without it); `tsc` still checks every handler's signature.
    files: ['hooks/**/*.tsx', 'tests/engine/**/*.test.ts'],
    rules: { '@typescript-eslint/no-misused-promises': 'off' },
  },
  {
    // Vitest types its asymmetric matchers (`expect.stringContaining`) as `any`.
    files: ['tests/**/*.spec.ts'],
    rules: { '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
  {
    // Build scripts are plain Node programs: no type information, and they may print.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      parserOptions: { projectService: false },
      globals: { console: 'readonly', process: 'readonly' },
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules, 'no-console': 'off' },
  },
)
