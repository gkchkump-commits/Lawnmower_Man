export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'voice/**', 'release/**', 'public/**', '.claude/**'],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly', console: 'readonly',
        process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        performance: 'readonly', fetch: 'readonly', URL: 'readonly', AbortController: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly', Buffer: 'readonly', globalThis: 'readonly',
        structuredClone: 'readonly', queueMicrotask: 'readonly', atob: 'readonly', btoa: 'readonly',
        Blob: 'readonly', Image: 'readonly', AudioContext: 'readonly', __dirname: 'readonly', require: 'readonly', module: 'writable',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
  {
    files: ['electron/preload.cjs', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
