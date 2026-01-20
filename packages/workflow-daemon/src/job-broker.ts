/**
 * @module @kb-labs/workflow-daemon/job-broker
 * JobBroker implementation - facade for background job operations
 * Specification: kb-labs-mind/docs/adr/0034-job-broker-cron-scheduler.md
 */

import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { WorkflowRun, WorkflowSpec } from '@kb-labs/workflow-contracts';
import type { ILogger } from '@kb-labs/core-platform';

export interface SubmitJobRequest {
  handler: string;
  input?: unknown;
  priority?: 'low' | 'normal' | 'high';
  metadata?: Record<string, unknown>;
}

export interface ScheduleJobRequest {
  handler: string;
  cron: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * JobBroker - Facade for workflow engine operations.
 * Converts job requests to WorkflowSpec and delegates to WorkflowEngine.
 */
export class JobBroker {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly logger: ILogger,
  ) {}

  /**
   * Submit a background job for execution.
   * Creates a WorkflowSpec with a single job and submits to WorkflowEngine.
   */
  async submit(request: SubmitJobRequest): Promise<WorkflowRun> {
    this.logger.info('Submitting background job', {
      handler: request.handler,
      priority: request.priority ?? 'normal',
    });

    // Convert to WorkflowSpec
    const spec: WorkflowSpec = {
      name: `job-${request.handler}`,
      jobs: {
        main: {
          name: `job-${Date.now()}`,
          steps: [
            {
              id: 'execute',
              name: 'Execute handler',
              uses: `plugin:${request.handler}`,
              with: request.input ?? {},
            },
          ],
        },
      },
    };

    // Submit to engine
    const run = await this.engine.runFromInline(spec, {
      env: {},
      metadata: request.metadata,
    });

    this.logger.info('Background job submitted', {
      runId: run.id,
      handler: request.handler,
      status: run.status,
    });

    return run;
  }

  /**
   * Schedule a recurring job with cron expression.
   * Registers job with CronScheduler (if available).
   *
   * NOTE: CronScheduler integration not yet implemented.
   * This is a placeholder for future implementation.
   */
  async schedule(request: ScheduleJobRequest): Promise<{ id: string; cron: string }> {
    this.logger.warn('CronScheduler not yet implemented', {
      handler: request.handler,
      cron: request.cron,
    });

    // TODO: Integrate with CronScheduler
    // const scheduleId = await this.cronScheduler.register({
    //   id: `schedule-${Date.now()}`,
    //   cron: request.cron,
    //   handler: request.handler,
    //   input: request.input,
    // });

    throw new Error('CronScheduler not yet implemented');
  }

  /**
   * Get job status by run ID.
   */
  async getStatus(runId: string): Promise<WorkflowRun | null> {
    return this.engine.getRun(runId);
  }

  /**
   * Cancel a running job.
   */
  async cancel(runId: string): Promise<void> {
    await this.engine.cancelRun(runId);
    this.logger.info('Job cancelled', { runId });
  }
}
