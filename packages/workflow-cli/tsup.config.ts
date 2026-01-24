import { defineConfig } from 'tsup';
import nodePreset from '@kb-labs/devkit/tsup/node';

export default defineConfig({
  ...nodePreset,
  tsconfig: 'tsconfig.build.json',
  entry: [
    'src/index.ts',
    'src/manifest.ts',
    'src/commands/health.ts',
    'src/commands/metrics.ts',
    'src/commands/status.ts',
    'src/commands/logs.ts',
    'src/commands/list.ts',
    'src/commands/run.ts',
    'src/rest/stats-handler.ts',
    'src/rest/workflows-list-handler.ts',
    'src/rest/workflow-detail-handler.ts',
    'src/rest/workflow-run-handler.ts',
    'src/rest/workflow-runs-handler.ts',
    'src/rest/jobs-list-handler.ts',
    'src/rest/job-detail-handler.ts',
    'src/rest/job-logs-handler.ts',
    'src/rest/job-cancel-handler.ts',
    'src/rest/cron-list-handler.ts',
    'src/rest/job-steps-handler.ts',
    'src/ws/logs-channel.ts',
    'src/ws/progress-channel.ts',
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
