/**
 * @module @kb-labs/workflow-daemon/worker
 * WorkflowWorker implementation - processes jobs from WorkflowEngine
 */

import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ExecutionBackend } from '@kb-labs/plugin-execution';
import type { CliAPI } from '@kb-labs/cli-api';
import type { ILogger, IAnalytics } from '@kb-labs/core-platform';
import { SandboxRunner } from '@kb-labs/workflow-runtime';

export interface CreateWorkflowWorkerOptions {
  engine: WorkflowEngine;
  executionBackend: ExecutionBackend;
  cliApi: CliAPI;
  logger: ILogger;
  workspaceRoot: string;
  concurrency?: number;
  /** Default timeout for step execution (ms). Default: 120000 (2 minutes) */
  defaultTimeout?: number;
  /** Platform analytics adapter (OPTIONAL) */
  analytics?: IAnalytics;
}

export interface WorkflowWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create a workflow worker that processes jobs from the queue.
 * Uses SandboxRunner with ExecutionBackend for plugin execution.
 */
export async function createWorkflowWorker(
  options: CreateWorkflowWorkerOptions
): Promise<WorkflowWorker> {
  const {
    engine,
    executionBackend,
    cliApi,
    logger,
    workspaceRoot,
    concurrency = 5,
    defaultTimeout = 120000,
    analytics,
  } = options;

  let isRunning = false;
  let stopRequested = false;

  // Track running jobs for graceful shutdown
  const runningJobs = new Map<string, Promise<void>>();

  // Create logger adapter for RuntimeLogger interface
  const runtimeLogger = {
    debug: (message: string, meta?: Record<string, unknown>) => logger.debug(message, meta),
    info: (message: string, meta?: Record<string, unknown>) => logger.info(message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => logger.warn(message, meta),
    error: (message: string, meta?: Record<string, unknown>) => logger.error(message, undefined, meta),
  };

  // Create SandboxRunner with ExecutionBackend
  const runner = new SandboxRunner({
    backend: executionBackend,
    cliApi,
    workspaceRoot,
    defaultTimeout,
  });

  /**
   * Process a single job from the queue.
   */
  async function processJob(): Promise<boolean> {
    const entry = await engine.nextJob();
    if (!entry) {
      return false; // No job available
    }

    // Get run and job from state store using IDs from queue entry
    const run = await engine.getRun(entry.runId);
    if (!run) {
      logger.error('Data inconsistency: Run not found for job entry', undefined, {
        runId: entry.runId,
        jobId: entry.jobId
      });
      return true; // Entry was processed (but run missing - data corruption)
    }

    const job = run.jobs.find(j => j.id === entry.jobId);
    if (!job) {
      logger.error('Data inconsistency: Job not found in run', undefined, {
        runId: run.id,
        jobId: entry.jobId
      });
      return true; // Entry was processed (but job missing - data corruption)
    }

    const jobKey = `${run.id}:${job.id}`;
    const jobStartTime = Date.now();

    logger.info('Processing job', {
      runId: run.id,
      jobId: job.id,
      jobName: job.jobName,
    });

    // Mark job as started (sets startedAt timestamp)
    await engine.markJobStarted(run.id, job.id);

    // Track job processing started
    analytics?.track('workflow.worker.job.started', {
      runId: run.id,
      jobId: job.id,
      jobName: job.jobName,
      stepCount: job.steps.length,
    }).catch(() => {});

    // Create job execution promise for graceful shutdown tracking
    const jobPromise = (async () => {
      try {
        // Execute job steps using SandboxRunner
        // IMPORTANT: Steps MUST run sequentially because:
        // - Step outputs are inputs for next steps
        // - Steps may have side effects that depend on order
        // - Workflow semantics require sequential execution
        /* eslint-disable no-await-in-loop */
        for (const step of job.steps) {
          if (step.status === 'success') {
            continue; // Skip already completed steps
          }

          logger.info('Executing step', {
            runId: run.id,
            jobId: job.id,
            stepId: step.id,
          });

          // Mark step as started (sets startedAt timestamp)
          await engine.markStepStarted(run.id, job.id, step.id);

          const result = await runner.execute({
            spec: step.spec,  // Pass StepSpec, not StepRun
            context: {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
              attempt: 1,
              env: run.env || ({} as Record<string, string>),
              secrets: {} as Record<string, string>, // TODO: map run.secrets array to Record
              logger: runtimeLogger,
            },
            workspace: workspaceRoot,
          });

          if (result.status === 'failed') {
            const error = new Error(result.error?.message ?? 'Step execution failed');

            // Mark step as failed (sets finishedAt timestamp + error)
            await engine.markStepFailed(run.id, job.id, step.id, error);

            logger.error('Step failed', error, {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
            });
            throw error;
          }

          // Mark step as completed (sets finishedAt timestamp + outputs)
          await engine.markStepCompleted(run.id, job.id, step.id, result.status === 'success' ? result.outputs : undefined);

          logger.info('Step completed', {
            runId: run.id,
            jobId: job.id,
            stepId: step.id,
          });
        }
        /* eslint-enable no-await-in-loop */

        // Mark job as completed
        await engine.markJobCompleted(run.id, job.id);

        const jobDuration = Date.now() - jobStartTime;
        logger.info('Job completed successfully', {
          runId: run.id,
          jobId: job.id,
        });

        // Track job processing completed
        analytics?.track('workflow.worker.job.completed', {
          runId: run.id,
          jobId: job.id,
          jobName: job.jobName,
          durationMs: jobDuration,
          stepCount: job.steps.length,
        }).catch(() => {});
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const jobDuration = Date.now() - jobStartTime;

        // Mark job as failed (engine will retry based on retries policy: max 3 attempts by default)
        // shouldRetry=true means "attempt retry if policy allows"
        // Engine checks attempt < retryPolicy.max to prevent infinite loops
        await engine.markJobFailed(run.id, job.id, err, true);

        // Track job processing failed
        analytics?.track('workflow.worker.job.failed', {
          runId: run.id,
          jobId: job.id,
          jobName: job.jobName,
          errorMessage: err.message,
          durationMs: jobDuration,
        }).catch(() => {});
      } finally {
        // Remove from tracking
        runningJobs.delete(jobKey);
      }
    })();

    // Track running job
    runningJobs.set(jobKey, jobPromise);

    // Wait for completion
    await jobPromise;

    return true;
  }

  /**
   * Worker loop - continuously processes jobs from the queue.
   */
  async function workerLoop(): Promise<void> {
    // IMPORTANT: This is a polling loop, must run sequentially
    /* eslint-disable no-await-in-loop */
    while (isRunning && !stopRequested) {
      try {
        const processed = await processJob();

        if (!processed) {
          // No job available, wait before polling again
          await sleep(1000);
        }
      } catch (error) {
        logger.error(
          'Worker loop error',
          error instanceof Error ? error : undefined,
          {
            errorMessage: error instanceof Error ? error.message : String(error),
            errorStack: error instanceof Error ? error.stack : undefined,
          },
        );
        await sleep(5000); // Wait longer on error
      }
    }
    /* eslint-enable no-await-in-loop */

    logger.info('Worker loop stopped');
  }

  return {
    async start() {
      if (isRunning) {
        logger.warn('Worker already running');
        return;
      }

      logger.info('Starting workflow worker', { concurrency });
      isRunning = true;
      stopRequested = false;

      // Track worker start
      analytics?.track('workflow.worker.started', {
        concurrency,
      }).catch(() => {});

      // Start multiple worker loops for concurrency
      const promises: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) {
        promises.push(workerLoop());
      }

      await Promise.all(promises);
    },

    async stop() {
      if (!isRunning) {
        return;
      }

      logger.info('Stopping workflow worker', {
        runningJobsCount: runningJobs.size,
      });

      // Signal stop
      stopRequested = true;
      isRunning = false;

      // Wait for in-flight jobs to complete (graceful shutdown)
      if (runningJobs.size > 0) {
        logger.info('Waiting for in-flight jobs to complete', {
          count: runningJobs.size,
        });

        const shutdownTimeoutMs = parseInt(
          process.env.WORKFLOW_SHUTDOWN_TIMEOUT_MS || '120000',
          10
        );

        try {
          // Wait for all running jobs with timeout
          await Promise.race([
            Promise.all(Array.from(runningJobs.values())),
            sleep(shutdownTimeoutMs),
          ]);

          if (runningJobs.size > 0) {
            logger.warn('Shutdown timeout reached, marking jobs as interrupted', {
              count: runningJobs.size,
            });

            // Mark unfinished jobs as interrupted (parallel for speed)
            await Promise.all(
              Array.from(runningJobs.keys()).map(async (jobKey) => {
                const [runId, jobId] = jobKey.split(':');
                if (runId && jobId) {
                  await engine.markJobInterrupted(runId, jobId);
                }
              })
            );
          } else {
            logger.info('All in-flight jobs completed gracefully');
          }
        } catch (error) {
          logger.error('Error during graceful shutdown', error instanceof Error ? error : undefined, {
            runningJobsCount: runningJobs.size,
          });
        }
      }

      logger.info('Workflow worker stopped');

      // Track worker stop
      analytics?.track('workflow.worker.stopped', {
        gracefulShutdown: runningJobs.size === 0,
        interruptedJobs: runningJobs.size,
      }).catch(() => {});
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}
