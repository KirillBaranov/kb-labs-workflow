/**
 * @module @kb-labs/workflow-daemon/worker
 * WorkflowWorker implementation - processes jobs from WorkflowEngine
 */

import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ExecutionBackend } from '@kb-labs/plugin-execution';
import type { CliAPI } from '@kb-labs/cli-api';
import type { ILogger } from '@kb-labs/core-platform';
import { SandboxRunner } from '@kb-labs/workflow-runtime';

export interface CreateWorkflowWorkerOptions {
  engine: WorkflowEngine;
  executionBackend: ExecutionBackend;
  cliApi: CliAPI;
  logger: ILogger;
  workspaceRoot: string;
  concurrency?: number;
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
  } = options;

  let isRunning = false;
  let stopRequested = false;

  // Create SandboxRunner with ExecutionBackend
  const runner = new SandboxRunner({
    backend: executionBackend,
    cliApi,
    workspaceRoot,
    defaultTimeout: 120000, // 2 minutes
  });

  /**
   * Process a single job from the queue.
   */
  async function processJob(): Promise<boolean> {
    const entry = await engine.nextJob();
    if (!entry) {
      return false; // No job available
    }

    const { run, job } = entry;

    logger.info('Processing job', {
      runId: run.id,
      jobId: job.id,
      jobName: job.name,
    });

    try {
      // Execute job steps using SandboxRunner
      for (const step of job.steps) {
        if (step.status === 'success') {
          continue; // Skip already completed steps
        }

        logger.info('Executing step', {
          runId: run.id,
          jobId: job.id,
          stepId: step.id,
        });

        const result = await runner.execute({
          spec: step,
          context: {
            runId: run.id,
            jobId: job.id,
            stepId: step.id,
            attempt: 1,
            logger,
          },
          workspace: workspaceRoot,
        });

        if (result.status === 'failed') {
          logger.error('Step failed', {
            runId: run.id,
            jobId: job.id,
            stepId: step.id,
            error: result.error?.message,
          });
          throw new Error(result.error?.message ?? 'Step execution failed');
        }

        logger.info('Step completed', {
          runId: run.id,
          jobId: job.id,
          stepId: step.id,
        });
      }

      logger.info('Job completed successfully', {
        runId: run.id,
        jobId: job.id,
      });

      return true;
    } catch (error) {
      logger.error('Job failed', {
        runId: run.id,
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });

      // TODO: Update job status to failed in engine
      return true;
    }
  }

  /**
   * Worker loop - continuously processes jobs from the queue.
   */
  async function workerLoop(): Promise<void> {
    while (isRunning && !stopRequested) {
      try {
        const processed = await processJob();

        if (!processed) {
          // No job available, wait before polling again
          await sleep(1000);
        }
      } catch (error) {
        logger.error('Worker loop error', {
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(5000); // Wait longer on error
      }
    }

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

      logger.info('Stopping workflow worker');
      stopRequested = true;
      isRunning = false;

      // Wait for graceful shutdown
      await sleep(1000);
      logger.info('Workflow worker stopped');
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
