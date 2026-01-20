/**
 * workflow:metrics command - Get workflow metrics
 */

import { defineCommand, type PluginContextV3 } from '@kb-labs/sdk';
import { type MetricsFlags } from '@kb-labs/workflow-contracts';
import { WorkflowDaemonClient } from '../http-client.js';

type MetricsInput = MetricsFlags & { argv?: string[] };

export default defineCommand({
  id: 'workflow:metrics',
  description: 'Get workflow daemon metrics',

  handler: {
    async execute(ctx: PluginContextV3, input: MetricsInput): Promise<{ exitCode: number }> {
      const flags = (input as any).flags ?? input;
      const outputJson = flags.json ?? false;

      try {
        const client = new WorkflowDaemonClient();
        const metrics = await client.getMetrics();

        if (outputJson) {
          ctx.ui?.json?.({ ok: true, data: metrics });
        } else {
          ctx.ui?.info?.('Workflow Metrics:');
          ctx.ui?.info?.('');

          // Runs metrics
          ctx.ui?.info?.(`Runs:`);
          ctx.ui?.info?.(`  Total: ${metrics.runs.total}`);
          ctx.ui?.info?.(`  Queued: ${metrics.runs.queued}`);
          ctx.ui?.info?.(`  Running: ${metrics.runs.running}`);
          ctx.ui?.info?.(`  Completed: ${metrics.runs.completed}`);
          ctx.ui?.info?.(`  Failed: ${metrics.runs.failed}`);
          ctx.ui?.info?.(`  Cancelled: ${metrics.runs.cancelled}`);
          ctx.ui?.info?.('');

          // Jobs metrics
          ctx.ui?.info?.(`Jobs:`);
          ctx.ui?.info?.(`  Total: ${metrics.jobs.total}`);
          ctx.ui?.info?.(`  Queued: ${metrics.jobs.queued}`);
          ctx.ui?.info?.(`  Running: ${metrics.jobs.running}`);
          ctx.ui?.info?.(`  Completed: ${metrics.jobs.completed}`);
          ctx.ui?.info?.(`  Failed: ${metrics.jobs.failed}`);
        }

        return { exitCode: 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (outputJson) {
          ctx.ui?.json?.({ ok: false, error: message });
        } else {
          ctx.ui?.error?.(`Failed to get metrics: ${message}`);
          ctx.ui?.warn?.(`Make sure workflow daemon is running: kb-workflow`);
        }

        return { exitCode: 1 };
      }
    },
  },
});
