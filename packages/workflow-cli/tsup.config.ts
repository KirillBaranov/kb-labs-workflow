import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node.js';

export default defineConfig({
  ...nodePreset,
  entry: [
    'src/index.ts',
    'src/manifest.ts',
    'src/commands/health.ts',
    'src/commands/metrics.ts',
    'src/commands/status.ts',
    'src/commands/logs.ts',
    'src/commands/list.ts',
  ],
  external: [
    '@kb-labs/sdk',
    '@kb-labs/workflow-contracts',
  ],
  dts: {
    resolve: true,
    skipLibCheck: true,
  },
  clean: true,
  sourcemap: true,
});
