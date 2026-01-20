/**
 * workflow:status command - Get job status
 */

import { defineCommand, type PluginContextV3 } from '@kb-labs/sdk';
import { type StatusFlags } from '@kb-labs/workflow-contracts';
import { WorkflowDaemonClient } from '../http-client.js';

type StatusInput = StatusFlags & { argv?: string[] };

export default defineCommand({
  id: 'workflow:status',
  description: 'Get status of a workflow job',

  handler: {
    async execute(ctx: PluginContextV3, input: StatusInput): Promise<{ exitCode: number }> {
      const flags = (input as any).flags ?? input;
      const outputJson = flags.json ?? false;
      const jobId = flags['job-id'];

      if (!jobId) {
        if (outputJson) {
          ctx.ui?.json?.({ ok: false, error: 'Missing required flag: --job-id' });
        } else {
          ctx.ui?.error?.('Missing required flag: --job-id');
          ctx.ui?.info?.('Usage: kb workflow status --job-id=<job-id>');
        }
        return { exitCode: 1 };
      }

      try {
        const client = new WorkflowDaemonClient();
        const status = await client.getJobStatus(jobId);

        if (outputJson) {
          ctx.ui?.json?.({ ok: true, data: status });
        } else {
          ctx.ui?.info?.(`Job Status: ${jobId}`);
          ctx.ui?.info?.('');
          ctx.ui?.info?.(`  ID: ${status.id}`);
          ctx.ui?.info?.(`  Status: ${status.status}`);
          ctx.ui?.info?.(`  Started: ${status.startedAt || 'N/A'}`);
          ctx.ui?.info?.(`  Finished: ${status.finishedAt || 'N/A'}`);
        }

        return { exitCode: 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (outputJson) {
          ctx.ui?.json?.({ ok: false, error: message });
        } else {
          ctx.ui?.error?.(`Failed to get job status: ${message}`);
        }

        return { exitCode: 1 };
      }
    },
  },
});
