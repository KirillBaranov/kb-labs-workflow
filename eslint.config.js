import nodePreset from '@kb-labs/devkit/eslint/node.js';

export default [
  ...nodePreset,
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.d.ts',
      '**/tsup.config.ts',
      '**/vitest.config.ts',
      '**/*.vue'
    ]
  },
  {
    // Workflow engine orchestrates async jobs — await-in-loop matters here
    rules: {
      'no-await-in-loop': 'warn',
    },
  },
];