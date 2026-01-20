/**
 * workflow:list command - List active executions
 */

import { defineCommand, type PluginContextV3 } from '@kb-labs/sdk';
import { type ListFlags } from '@kb-labs/workflow-contracts';
import { WorkflowDaemonClient } from '../http-client.js';

type ListInput = ListFlags & { argv?: string[] };

export default defineCommand({
  id: 'workflow:list',
  description: 'List active workflow executions',

  handler: {
    async execute(ctx: PluginContextV3, input: ListInput): Promise<{ exitCode: number }> {
      const flags = (input as any).flags ?? input;
      const outputJson = flags.json ?? false;
      const statusFilter = flags.status;
      const typeFilter = flags.type;

      try {
        const client = new WorkflowDaemonClient();

        // Handle --type cron filter
        if (typeFilter === 'cron') {
          const result = await client.getCronJobs();

          if (outputJson) {
            ctx.ui?.json?.({ ok: true, data: result });
          } else {
            ctx.ui?.info?.(`Cron Jobs: ${result.total}`);
            ctx.ui?.info?.(`Scheduler Running: ${result.running ? 'Yes' : 'No'}`);
            ctx.ui?.info?.('');

            if (result.cronJobs.length === 0) {
              ctx.ui?.warn?.('No cron jobs found');
              ctx.ui?.info?.('');
              ctx.ui?.info?.('To add cron jobs:');
              ctx.ui?.info?.('  1. Plugin manifests: Add "cron" section to manifest.ts');
              ctx.ui?.info?.('  2. User YAML: Create .kb/jobs/*.yml files');
            } else {
              for (const job of result.cronJobs) {
                ctx.ui?.info?.(`  ${job.id}`);
                ctx.ui?.info?.(`    Source:   ${job.source}`);
                ctx.ui?.info?.(`    Schedule: ${job.schedule} (${job.timezone || 'UTC'})`);
                ctx.ui?.info?.(`    Priority: ${job.priority}`);
                ctx.ui?.info?.(`    Enabled:  ${job.enabled ? 'Yes' : 'No'}`);
                if (job.handler) {
                  ctx.ui?.info?.(`    Handler:  ${job.handler}`);
                }
                if (job.workflowName) {
                  ctx.ui?.info?.(`    Workflow: ${job.workflowName}`);
                }
                ctx.ui?.info?.('');
              }
            }
          }

          return { exitCode: 0 };
        }

        // Default: list active executions (runs)
        let executions = await client.getExecutions();

        // Filter by status if provided
        if (statusFilter) {
          executions = executions.filter((exec: any) => exec.status === statusFilter);
        }

        if (outputJson) {
          ctx.ui?.json?.({ ok: true, data: { executions } });
        } else {
          ctx.ui?.info?.(`Active Executions: ${executions.length}`);
          ctx.ui?.info?.('');

          if (executions.length === 0) {
            ctx.ui?.warn?.('No active executions found');
          } else {
            for (const exec of executions) {
              ctx.ui?.info?.(`  ID: ${exec.id}`);
              ctx.ui?.info?.(`    Status: ${exec.status}`);
              ctx.ui?.info?.(`    Started: ${exec.startedAt || 'N/A'}`);
              ctx.ui?.info?.('');
            }
          }
        }

        return { exitCode: 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (outputJson) {
          ctx.ui?.json?.({ ok: false, error: message });
        } else {
          ctx.ui?.error?.(`Failed to list: ${message}`);
          ctx.ui?.warn?.(`Make sure workflow daemon is running: kb-workflow`);
        }

        return { exitCode: 1 };
      }
    },
  },
});
