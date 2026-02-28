/**
 * @module @kb-labs/workflow-daemon/worker
 * WorkflowWorker implementation - processes jobs from WorkflowEngine
 */

import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ExecutionBackend } from '@kb-labs/plugin-execution';
import type { CliAPI } from '@kb-labs/cli-api';
import type { ILogger, IAnalytics, IWorkspaceProvider, IEnvironmentProvider } from '@kb-labs/core-platform';
import type { ExecutionTarget } from '@kb-labs/workflow-contracts';
import { randomUUID } from 'node:crypto';
import { SandboxRunner } from '@kb-labs/workflow-runtime';

type IsolationProfile = 'strict' | 'balanced' | 'relaxed';

/**
 * Permanent job failure — retrying is pointless (misconfiguration, invalid input, etc.).
 * Worker passes shouldRetry=false to engine so the job goes straight to failed/DLQ
 * without burning through the retry budget.
 */
class PermanentJobError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

interface Platform {
  getAdapter<T>(key: string): T | undefined;
}

export interface CreateWorkflowWorkerOptions {
  engine: WorkflowEngine;
  executionBackend: ExecutionBackend;
  cliApi: CliAPI;
  logger: ILogger;
  platform: Platform;
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
    platform,
    workspaceRoot,
    concurrency = 5,
    defaultTimeout = 120000,
    analytics,
  } = options;

  let isRunning = false;
  let stopRequested = false;

  // Track running jobs for graceful shutdown
  const runningJobs = new Map<string, Promise<void>>();

  // Create SandboxRunner with ExecutionBackend
  const runner = new SandboxRunner({
    backend: executionBackend,
    cliApi,
    workspaceRoot,
    defaultTimeout,
  });

  function resolveIsolationProfile(job: Record<string, unknown>, run: Record<string, unknown>): IsolationProfile {
    const jobIsolation = job.isolation;
    if (jobIsolation === 'strict' || jobIsolation === 'balanced' || jobIsolation === 'relaxed') {
      return jobIsolation;
    }
    const runIsolation = (run.metadata as Record<string, unknown> | undefined)?.isolation;
    if (runIsolation === 'strict' || runIsolation === 'balanced' || runIsolation === 'relaxed') {
      return runIsolation;
    }
    return 'balanced';
  }

  async function resolveExecutionTarget(
    run: Record<string, unknown>,
    job: Record<string, unknown>,
  ): Promise<{
    target?: ExecutionTarget;
    workspace?: string;
    createdEnvironmentId?: string;
    createdWorkspaceId?: string;
  }> {
    const isolation = resolveIsolationProfile(job, run);
    const runTarget = (run.metadata as Record<string, unknown> | undefined)?.target;
    const baseTarget = (job.target ?? runTarget ?? {}) as ExecutionTarget;
    const namespace = baseTarget.namespace ?? `workflow/${String(run.id)}`;

    if (isolation === 'relaxed') {
      return {
        target: {
          ...baseTarget,
          namespace,
        },
        workspace: baseTarget.workdir ?? workspaceRoot,
      };
    }

    const workspaceProvider = platform.getAdapter<IWorkspaceProvider>('workspace');
    if (!workspaceProvider) {
      throw new PermanentJobError(
        `Workflow requires isolation='${isolation}' but the workspace adapter is not configured. ` +
        `Either set platform.adapters.workspace in kb.config.json, ` +
        `or explicitly set isolation: relaxed in the workflow YAML to run without a dedicated workspace.`
      );
    }

    let createdEnvironmentId: string | undefined;
    let createdWorkspaceId: string | undefined;
    let environmentId = baseTarget.environmentId;
    let workspaceId = baseTarget.workspaceId;

    // Materialize workspace first — for strict isolation we need rootPath to mount into the container.
    let workspaceRootPath: string | undefined;
    if (!workspaceId) {
      const workspace = await workspaceProvider.materialize({
        tenantId: typeof run.tenantId === 'string' ? run.tenantId : undefined,
        namespace,
        sourceRef: workspaceRoot,
        basePath: workspaceRoot,
        metadata: {
          source: 'workflow',
          runId: run.id,
          jobId: job.id,
        },
      });
      workspaceId = workspace.workspaceId;
      createdWorkspaceId = workspace.workspaceId;
      workspaceRootPath = workspace.rootPath;
      logger.debug('Workspace materialized for workflow job', {
        runId: run.id,
        jobId: job.id,
        workspaceId,
        rootPath: workspaceRootPath,
      });
    }

    if (isolation === 'strict') {
      const environmentProvider = platform.getAdapter<IEnvironmentProvider>('environment');
      if (!environmentProvider) {
        throw new PermanentJobError(
          `Workflow requires isolation='strict' but the environment adapter is not configured. ` +
          `Set platform.adapters.environment in kb.config.json, or use isolation: balanced instead.`
        );
      }
      if (!environmentId) {
        const provisioningRunId = `${String(run.id)}:${String(job.id)}:${job.attempt ?? 0}:${randomUUID().slice(0, 8)}`;
        const environment = await environmentProvider.create({
          tenantId: typeof run.tenantId === 'string' ? run.tenantId : undefined,
          namespace,
          runId: provisioningRunId,
          // Pass workspace rootPath so the container gets the volume mounted at create time.
          workspacePath: workspaceRootPath,
          metadata: {
            source: 'workflow',
            runId: run.id,
            jobId: job.id,
            attempt: job.attempt ?? 0,
            provisioningRunId,
          },
        });
        environmentId = environment.environmentId;
        createdEnvironmentId = environment.environmentId;
        logger.debug('Environment provisioned for workflow job', {
          runId: run.id,
          jobId: job.id,
          attempt: job.attempt ?? 0,
          environmentId,
          workspacePath: workspaceRootPath,
        });
      }

      if (workspaceId && environmentId) {
        await workspaceProvider.attach({
          workspaceId,
          environmentId,
        });
        logger.debug('Workspace attached to environment for workflow job', {
          runId: run.id,
          jobId: job.id,
          workspaceId,
          environmentId,
        });
      }
    }

    return {
      target: {
        ...baseTarget,
        namespace,
        environmentId,
        workspaceId,
      },
      workspace: baseTarget.workdir,
      createdEnvironmentId,
      createdWorkspaceId,
    };
  }

  async function cleanupExecutionTarget(resources: {
    target?: ExecutionTarget;
    createdEnvironmentId?: string;
    createdWorkspaceId?: string;
  }): Promise<void> {
    const { target, createdEnvironmentId, createdWorkspaceId } = resources;

    const workspaceId = createdWorkspaceId ?? (target?.workspaceId && target.environmentId ? target.workspaceId : undefined);
    if (workspaceId) {
      const workspaceProvider = platform.getAdapter<IWorkspaceProvider>('workspace');
      if (workspaceProvider) {
        try {
          await workspaceProvider.release(workspaceId, target?.environmentId);
          logger.debug('Workspace released for workflow job', {
            workspaceId,
            environmentId: target?.environmentId,
          });
        } catch (error) {
          logger.warn('Failed to release workspace', {
            workspaceId,
            environmentId: target?.environmentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    if (createdEnvironmentId) {
      const environmentProvider = platform.getAdapter<IEnvironmentProvider>('environment');
      if (environmentProvider) {
        try {
          await environmentProvider.destroy(createdEnvironmentId, 'workflow.job.completed');
          logger.debug('Environment destroyed for workflow job', {
            environmentId: createdEnvironmentId,
          });
        } catch (error) {
          logger.warn('Failed to destroy environment', {
            environmentId: createdEnvironmentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

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
    const jobLogger = logger.child({
      layer: 'workflow',
      workflowId: run.id,
      runId: run.id,
      jobId: job.id,
      requestId: run.id,
      reqId: run.id,
      traceId: run.id,
    });

    jobLogger.info('Processing job', {
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
      let executionTargetResources: {
        target?: ExecutionTarget;
        workspace?: string;
        createdEnvironmentId?: string;
        createdWorkspaceId?: string;
      } | null = null;

      try {
        executionTargetResources = await resolveExecutionTarget(
          run as unknown as Record<string, unknown>,
          job as unknown as Record<string, unknown>,
        );

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

          const stepExecutionId = `wf-${run.id}-${job.id}-${step.id}-${Date.now()}`;
          const stepLogger = jobLogger.child({
            stepId: step.id,
            attempt: 1,
            executionId: stepExecutionId,
            spanId: stepExecutionId,
            invocationId: stepExecutionId,
          });

          stepLogger.info('Executing step', {
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
              logger: {
                debug: (message: string, meta?: Record<string, unknown>) => stepLogger.debug(message, meta),
                info: (message: string, meta?: Record<string, unknown>) => stepLogger.info(message, meta),
                warn: (message: string, meta?: Record<string, unknown>) => stepLogger.warn(message, meta),
                error: (message: string, meta?: Record<string, unknown>) => stepLogger.error(message, undefined, meta),
              },
              trace: {
                traceId: run.id,
                spanId: stepExecutionId,
                parentSpanId: job.id,
              },
            },
            workspace: executionTargetResources.workspace,
            target: executionTargetResources.target,
          });

          if (result.status === 'failed') {
            const error = new Error(result.error?.message ?? 'Step execution failed');

            // Mark step as failed (sets finishedAt timestamp + error)
            await engine.markStepFailed(run.id, job.id, step.id, error);

            stepLogger.error('Step failed', error, {
              runId: run.id,
              jobId: job.id,
              stepId: step.id,
            });
            throw error;
          }

          // Mark step as completed (sets finishedAt timestamp + outputs)
          await engine.markStepCompleted(run.id, job.id, step.id, result.status === 'success' ? result.outputs : undefined);

          stepLogger.info('Step completed', {
            runId: run.id,
            jobId: job.id,
            stepId: step.id,
          });
        }
        /* eslint-enable no-await-in-loop */

        // Mark job as completed
        await engine.markJobCompleted(run.id, job.id);

        const jobDuration = Date.now() - jobStartTime;
        jobLogger.info('Job completed successfully', {
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

        // Permanent errors (misconfiguration, invalid spec) must not be retried —
        // the outcome will be identical on every attempt. Go straight to failed.
        const shouldRetry = !(error instanceof PermanentJobError);

        if (!shouldRetry) {
          jobLogger.error('Job failed permanently (no retry)', err, {
            runId: run.id,
            jobId: job.id,
            errorType: err.name,
          });
        }

        await engine.markJobFailed(run.id, job.id, err, shouldRetry);

        // Track job processing failed
        analytics?.track('workflow.worker.job.failed', {
          runId: run.id,
          jobId: job.id,
          jobName: job.jobName,
          errorMessage: err.message,
          permanent: !shouldRetry,
          durationMs: jobDuration,
        }).catch(() => {});
      } finally {
        if (executionTargetResources) {
          await cleanupExecutionTarget(executionTargetResources);
        }
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
