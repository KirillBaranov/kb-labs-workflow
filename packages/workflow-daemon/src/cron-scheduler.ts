/**
 * @module @kb-labs/workflow-daemon/cron-scheduler
 * CronScheduler - manages periodic job execution using node-cron
 */

import cron from 'node-cron';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobBroker } from './job-broker.js';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type {
  RegisteredCronJob,
  PluginCronJob,
  UserCronJob,
  WorkflowSpec,
} from '@kb-labs/workflow-contracts';

export interface CronSchedulerOptions {
  jobBroker: JobBroker;
  workflowEngine: WorkflowEngine;
  logger: ILogger;
  timezone?: string;
}

/**
 * CronScheduler manages periodic job execution.
 *
 * Features:
 * - Registers cron jobs from plugin manifests and user YAML files
 * - Uses node-cron for scheduling
 * - Submits jobs via JobBroker
 * - Graceful shutdown (stops all scheduled tasks)
 */
export class CronScheduler {
  private readonly jobBroker: JobBroker;
  private readonly workflowEngine: WorkflowEngine;
  private readonly logger: ILogger;
  private readonly defaultTimezone: string;

  private readonly registeredJobs = new Map<string, RegisteredCronJob>();
  private readonly scheduledTasks = new Map<string, cron.ScheduledTask>();
  private isRunning = false;

  constructor(options: CronSchedulerOptions) {
    this.jobBroker = options.jobBroker;
    this.workflowEngine = options.workflowEngine;
    this.logger = options.logger;
    this.defaultTimezone = options.timezone ?? 'UTC';
  }

  /**
   * Register cron job from plugin manifest.
   */
  registerPluginJob(pluginId: string, job: PluginCronJob): void {
    const cronJobId = `plugin:${pluginId}:${job.id}`;

    if (this.registeredJobs.has(cronJobId)) {
      this.logger.warn('Cron job already registered, skipping', { cronJobId });
      return;
    }

    const registered: RegisteredCronJob = {
      id: cronJobId,
      source: 'plugin',
      schedule: job.schedule,
      timezone: job.timezone ?? this.defaultTimezone,
      priority: job.priority,
      enabled: job.enabled,
      handler: job.handler,
      input: job.input,
      metadata: job.metadata,
    };

    this.registeredJobs.set(cronJobId, registered);
    this.logger.debug('Plugin cron job registered', {
      cronJobId,
      schedule: job.schedule,
      handler: job.handler,
    });
  }

  /**
   * Register cron job from user YAML file.
   */
  registerUserJob(fileName: string, job: UserCronJob): void {
    const cronJobId = `user:${fileName}`;

    if (this.registeredJobs.has(cronJobId)) {
      this.logger.warn('Cron job already registered, skipping', { cronJobId });
      return;
    }

    const registered: RegisteredCronJob = {
      id: cronJobId,
      source: 'user',
      schedule: job.schedule,
      timezone: job.timezone ?? this.defaultTimezone,
      priority: job.priority,
      enabled: job.enabled,
      workflowSpec: {
        name: job.name,
        jobs: job.jobs,
        env: job.env,
      },
      metadata: job.metadata,
    };

    this.registeredJobs.set(cronJobId, registered);
    this.logger.debug('User cron job registered', {
      cronJobId,
      schedule: job.schedule,
      name: job.name,
    });
  }

  /**
   * Start all registered cron jobs.
   * Schedules enabled jobs using node-cron.
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('CronScheduler already running');
      return;
    }

    this.logger.info('Starting CronScheduler', {
      totalJobs: this.registeredJobs.size,
    });

    for (const [cronJobId, job] of this.registeredJobs) {
      if (!job.enabled) {
        this.logger.debug('Skipping disabled cron job', { cronJobId });
        continue;
      }

      // Validate cron expression
      if (!cron.validate(job.schedule)) {
        this.logger.error('Invalid cron expression', undefined, {
          cronJobId,
          schedule: job.schedule,
        });
        continue;
      }

      // Schedule task
      const task = cron.schedule(
        job.schedule,
        () => this.executeCronJob(cronJobId, job),
        {
          scheduled: false, // Don't start immediately, we call .start() manually
          timezone: job.timezone,
        }
      );

      this.scheduledTasks.set(cronJobId, task);
      task.start();

      this.logger.info('Cron job scheduled', {
        cronJobId,
        schedule: job.schedule,
        timezone: job.timezone,
        source: job.source,
      });
    }

    this.isRunning = true;
    this.logger.info('CronScheduler started', {
      scheduledJobs: this.scheduledTasks.size,
    });
  }

  /**
   * Stop all scheduled cron jobs.
   * Called during graceful shutdown.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping CronScheduler', {
      scheduledJobs: this.scheduledTasks.size,
    });

    for (const [cronJobId, task] of this.scheduledTasks) {
      task.stop();
      this.logger.debug('Cron job stopped', { cronJobId });
    }

    this.scheduledTasks.clear();
    this.isRunning = false;

    this.logger.info('CronScheduler stopped');
  }

  /**
   * Execute cron job by submitting it to JobBroker.
   */
  private async executeCronJob(
    cronJobId: string,
    job: RegisteredCronJob
  ): Promise<void> {
    this.logger.info('Executing cron job', { cronJobId });

    try {
      if (job.source === 'plugin' && job.handler) {
        // Plugin cron job - submit via JobBroker
        const result = await this.jobBroker.submit({
          handler: job.handler,
          input: job.input,
          priority: job.priority,
          metadata: {
            ...job.metadata,
            cronJobId,
            scheduledBy: 'cron',
            scheduledAt: new Date().toISOString(),
          },
        });

        this.logger.info('Cron job submitted', {
          cronJobId,
          runId: result.id,
        });
      } else if (job.source === 'user' && job.workflowSpec) {
        // User cron job - run workflow directly via WorkflowEngine
        // Create complete WorkflowSpec from user job
        const spec: WorkflowSpec = {
          name: job.workflowSpec.name,
          version: '1.0.0',
          on: { manual: true }, // Cron-triggered workflows use manual trigger
          jobs: job.workflowSpec.jobs,
          env: job.workflowSpec.env,
        };

        // Debug: log the spec being passed
        console.log('🔍 CRON SPEC:', JSON.stringify(spec, null, 2));
        this.logger.debug('Running workflow from cron', {
          cronJobId,
          spec: JSON.stringify(spec, null, 2),
        });

        const result = await this.workflowEngine.runFromInline(spec, {
          trigger: {
            type: 'schedule',
            payload: {
              cronJobId,
              scheduledAt: new Date().toISOString(),
            },
          },
          env: job.workflowSpec.env ?? {},
          metadata: {
            ...job.metadata,
            cronJobId,
            scheduledBy: 'cron',
            scheduledAt: new Date().toISOString(),
          },
        });

        this.logger.info('Cron workflow submitted', {
          cronJobId,
          runId: result.id,
          workflowName: spec.name,
        });
      } else {
        throw new Error(`Invalid cron job configuration: ${cronJobId}`);
      }
    } catch (error) {
      this.logger.error(
        'Failed to execute cron job',
        error instanceof Error ? error : undefined,
        { cronJobId }
      );
    }
  }

  /**
   * Get all registered cron jobs.
   */
  getRegisteredJobs(): RegisteredCronJob[] {
    return Array.from(this.registeredJobs.values());
  }

  /**
   * Get cron job by ID.
   */
  getJob(cronJobId: string): RegisteredCronJob | undefined {
    return this.registeredJobs.get(cronJobId);
  }

  /**
   * Check if scheduler is running.
   */
  isSchedulerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Clear all registered cron jobs.
   * IMPORTANT: This does NOT stop scheduled tasks - call stop() first if needed.
   */
  clearAll(): void {
    this.logger.info('Clearing all registered cron jobs', {
      count: this.registeredJobs.size,
    });

    this.registeredJobs.clear();
    // Note: scheduledTasks are cleared in stop()
  }
}
