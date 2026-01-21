/**
 * Tests for WorkflowWorker
 *
 * Critical infrastructure tests covering:
 * - Job queue processing
 * - Step execution via SandboxRunner
 * - Graceful shutdown with in-flight jobs
 * - Error handling and retries
 * - Concurrency control
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createWorkflowWorker, type WorkflowWorker } from '../worker.js';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ExecutionBackend } from '@kb-labs/plugin-execution';
import type { CliAPI } from '@kb-labs/cli-api';
import type { ILogger } from '@kb-labs/core-platform';
import type { WorkflowRun, JobRun, JobQueueEntry } from '@kb-labs/workflow-contracts';

// Mock ExecutionBackend
class MockExecutionBackend implements ExecutionBackend {
  mockResult: any = { ok: true, data: { result: 'success' }, executionTimeMs: 100 };

  async execute(request: any, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { message: 'Aborted', code: 'ABORTED' },
      };
    }
    return this.mockResult;
  }
}

// Mock CliAPI
class MockCliAPI implements Partial<CliAPI> {
  mockManifests: any[] = [];

  snapshot() {
    return { manifests: this.mockManifests };
  }
}

// Mock WorkflowEngine
class MockWorkflowEngine implements Partial<WorkflowEngine> {
  private queue: JobQueueEntry[] = [];
  private runs = new Map<string, WorkflowRun>();
  markJobCompletedCalls: Array<{ runId: string; jobId: string }> = [];
  markJobFailedCalls: Array<{ runId: string; jobId: string; error: Error }> = [];
  markJobInterruptedCalls: Array<{ runId: string; jobId: string }> = [];

  async nextJob(): Promise<JobQueueEntry | null> {
    return this.queue.shift() ?? null;
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.runs.get(runId) ?? null;
  }

  async markJobCompleted(runId: string, jobId: string): Promise<void> {
    this.markJobCompletedCalls.push({ runId, jobId });
  }

  async markJobFailed(runId: string, jobId: string, error: Error): Promise<void> {
    this.markJobFailedCalls.push({ runId, jobId, error });
  }

  async markJobInterrupted(runId: string, jobId: string): Promise<void> {
    this.markJobInterruptedCalls.push({ runId, jobId });
  }

  // Test helpers
  addJobToQueue(entry: JobQueueEntry): void {
    this.queue.push(entry);
  }

  addRun(run: WorkflowRun): void {
    this.runs.set(run.id, run);
  }
}

// Mock Logger
const createMockLogger = (): ILogger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(function () {
    return createMockLogger();
  }),
});

describe('WorkflowWorker', () => {
  let engine: MockWorkflowEngine;
  let backend: MockExecutionBackend;
  let cliApi: MockCliAPI;
  let logger: ILogger;
  let worker: WorkflowWorker;

  beforeEach(() => {
    engine = new MockWorkflowEngine();
    backend = new MockExecutionBackend();
    cliApi = new MockCliAPI();
    logger = createMockLogger();

    // Setup CLI API with mock plugin
    cliApi.mockManifests = [
      {
        pluginId: 'test-plugin',
        pluginRoot: '/plugins/test-plugin',
        manifest: {
          version: '1.0.0',
          workflows: {
            handlers: [
              { id: 'test-handler', handler: './dist/handlers/test.js' },
            ],
          },
        },
      },
    ];
  });

  afterEach(async () => {
    if (worker) {
      await worker.stop();
    }
  });

  describe('Worker Creation', () => {
    it('should create worker with required dependencies', async () => {
      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 2,
      });

      expect(worker).toBeDefined();
      expect(worker.start).toBeDefined();
      expect(worker.stop).toBeDefined();
    });

    it('should use default concurrency if not provided', async () => {
      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        // No concurrency specified (defaults to 5)
      });

      expect(worker).toBeDefined();
    });
  });

  describe('Job Processing', () => {
    it('should process job from queue', async () => {
      const run: WorkflowRun = {
        id: 'run-1',
        name: 'Test Workflow',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [
          {
            id: 'job-1',
            jobName: 'main',
            status: 'running',
            createdAt: new Date().toISOString(),
            steps: [
              {
                id: 'step-1',
                name: 'Test Step',
                status: 'pending',
                createdAt: new Date().toISOString(),
                spec: {
                  name: 'Test Step',
                  uses: 'plugin:test-plugin/test-handler',
                  with: { foo: 'bar' },
                },
              },
            ],
          } as JobRun,
        ],
      } as WorkflowRun;

      engine.addRun(run);
      engine.addJobToQueue({
        runId: 'run-1',
        jobId: 'job-1',
        priority: 'normal',
        queuedAt: new Date().toISOString(),
      });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      // Start worker and let it process one job
      const workerPromise = worker.start();

      // Wait a bit for processing
      await new Promise(resolve => setTimeout(resolve, 100));

      // Stop worker
      await worker.stop();

      // Verify job was processed
      expect(engine.markJobCompletedCalls).toHaveLength(1);
      expect(engine.markJobCompletedCalls[0]).toEqual({
        runId: 'run-1',
        jobId: 'job-1',
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Processing job',
        expect.objectContaining({
          runId: 'run-1',
          jobId: 'job-1',
        })
      );

      expect(logger.info).toHaveBeenCalledWith(
        'Job completed successfully',
        expect.objectContaining({
          runId: 'run-1',
          jobId: 'job-1',
        })
      );
    });

    it('should skip already completed steps', async () => {
      const run: WorkflowRun = {
        id: 'run-1',
        name: 'Test Workflow',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [
          {
            id: 'job-1',
            jobName: 'main',
            status: 'running',
            createdAt: new Date().toISOString(),
            steps: [
              {
                id: 'step-1',
                name: 'Already Done',
                status: 'success', // Already completed
                createdAt: new Date().toISOString(),
                spec: {
                  name: 'Already Done',
                  uses: 'plugin:test-plugin/test-handler',
                },
              },
              {
                id: 'step-2',
                name: 'To Do',
                status: 'pending',
                createdAt: new Date().toISOString(),
                spec: {
                  name: 'To Do',
                  uses: 'plugin:test-plugin/test-handler',
                },
              },
            ],
          } as JobRun,
        ],
      } as WorkflowRun;

      engine.addRun(run);
      engine.addJobToQueue({
        runId: 'run-1',
        jobId: 'job-1',
        priority: 'normal',
        queuedAt: new Date().toISOString(),
      });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      await worker.stop();

      // Should only execute step-2 (step-1 already completed)
      const executingStepLogs = (logger.info as any).mock.calls.filter(
        (call: any[]) => call[0] === 'Executing step'
      );

      expect(executingStepLogs).toHaveLength(1);
      expect(executingStepLogs[0][1]).toMatchObject({
        stepId: 'step-2',
      });
    });

    it('should handle job with no steps', async () => {
      const run: WorkflowRun = {
        id: 'run-1',
        name: 'Test Workflow',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [
          {
            id: 'job-1',
            jobName: 'empty',
            status: 'running',
            createdAt: new Date().toISOString(),
            steps: [], // No steps
          } as JobRun,
        ],
      } as WorkflowRun;

      engine.addRun(run);
      engine.addJobToQueue({
        runId: 'run-1',
        jobId: 'job-1',
        priority: 'normal',
        queuedAt: new Date().toISOString(),
      });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      await worker.stop();

      // Should still mark as completed
      expect(engine.markJobCompletedCalls).toHaveLength(1);
    });
  });

  describe('Error Handling', () => {
    it('should mark job as failed on step execution error', async () => {
      // Make backend fail
      backend.mockResult = {
        ok: false,
        error: {
          message: 'Step execution failed',
          code: 'EXECUTION_ERROR',
        },
      };

      const run: WorkflowRun = {
        id: 'run-1',
        name: 'Test Workflow',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [
          {
            id: 'job-1',
            jobName: 'main',
            status: 'running',
            createdAt: new Date().toISOString(),
            steps: [
              {
                id: 'step-1',
                name: 'Failing Step',
                status: 'pending',
                createdAt: new Date().toISOString(),
                spec: {
                  name: 'Failing Step',
                  uses: 'plugin:test-plugin/test-handler',
                },
              },
            ],
          } as JobRun,
        ],
      } as WorkflowRun;

      engine.addRun(run);
      engine.addJobToQueue({
        runId: 'run-1',
        jobId: 'job-1',
        priority: 'normal',
        queuedAt: new Date().toISOString(),
      });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      await worker.stop();

      // Verify job was marked as failed
      expect(engine.markJobFailedCalls).toHaveLength(1);
      expect(engine.markJobFailedCalls[0]).toMatchObject({
        runId: 'run-1',
        jobId: 'job-1',
      });

      expect(logger.error).toHaveBeenCalledWith(
        'Step failed',
        expect.any(Error),
        expect.objectContaining({
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
        })
      );
    });

    it('should handle missing run gracefully', async () => {
      engine.addJobToQueue({
        runId: 'non-existent-run',
        jobId: 'job-1',
        priority: 'normal',
        queuedAt: new Date().toISOString(),
      });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      await worker.stop();

      expect(logger.warn).toHaveBeenCalledWith(
        'Run not found for job entry',
        expect.objectContaining({
          runId: 'non-existent-run',
          jobId: 'job-1',
        })
      );
    });

    it('should handle missing job in run gracefully', async () => {
      const run: WorkflowRun = {
        id: 'run-1',
        name: 'Test Workflow',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [], // No jobs
      } as WorkflowRun;

      engine.addRun(run);
      engine.addJobToQueue({
        runId: 'run-1',
        jobId: 'non-existent-job',
        priority: 'normal',
        queuedAt: new Date().toISOString(),
      });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      await worker.stop();

      expect(logger.warn).toHaveBeenCalledWith(
        'Job not found in run',
        expect.objectContaining({
          runId: 'run-1',
          jobId: 'non-existent-job',
        })
      );
    });
  });

  describe('Lifecycle Management', () => {
    it('should start worker and begin processing', async () => {
      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 2,
      });

      const workerPromise = worker.start();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      await worker.stop();

      expect(logger.info).toHaveBeenCalledWith(
        'Starting workflow worker',
        expect.objectContaining({
          concurrency: 2,
        })
      );
    });

    it('should warn if start called when already running', async () => {
      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();

      // Try to start again
      await worker.start();

      await worker.stop();

      expect(logger.warn).toHaveBeenCalledWith('Worker already running');
    });

    it('should stop worker gracefully', async () => {
      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      await worker.stop();

      expect(logger.info).toHaveBeenCalledWith(
        'Stopping workflow worker',
        expect.any(Object)
      );

      expect(logger.info).toHaveBeenCalledWith('Workflow worker stopped');
    });

    it('should do nothing if stop called when not running', async () => {
      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      // Stop without starting
      await worker.stop();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('Graceful Shutdown', () => {
    it('should wait for in-flight jobs to complete', async () => {
      // Create job with slow step
      const run: WorkflowRun = {
        id: 'run-1',
        name: 'Test Workflow',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [
          {
            id: 'job-1',
            jobName: 'main',
            status: 'running',
            createdAt: new Date().toISOString(),
            steps: [
              {
                id: 'step-1',
                name: 'Slow Step',
                status: 'pending',
                createdAt: new Date().toISOString(),
                spec: {
                  name: 'Slow Step',
                  uses: 'plugin:test-plugin/test-handler',
                },
              },
            ],
          } as JobRun,
        ],
      } as WorkflowRun;

      // Make backend slow
      backend.execute = async () => {
        await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
        return { ok: true, data: { result: 'success' }, executionTimeMs: 200 };
      };

      engine.addRun(run);
      engine.addJobToQueue({
        runId: 'run-1',
        jobId: 'job-1',
        priority: 'normal',
        queuedAt: new Date().toISOString(),
      });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 1,
      });

      const workerPromise = worker.start();

      // Wait for job to start
      await new Promise(resolve => setTimeout(resolve, 50));

      // Stop (should wait for job to complete)
      await worker.stop();

      // Job should have completed
      expect(engine.markJobCompletedCalls).toHaveLength(1);

      expect(logger.info).toHaveBeenCalledWith(
        'Waiting for in-flight jobs to complete',
        expect.objectContaining({
          count: 1,
        })
      );

      expect(logger.info).toHaveBeenCalledWith('All in-flight jobs completed gracefully');
    });

    // Note: Testing shutdown timeout would require mocking setTimeout/timers
    // or using fake timers, which is complex for this test
  });

  describe('Concurrency', () => {
    it('should process multiple jobs concurrently', async () => {
      const run1: WorkflowRun = {
        id: 'run-1',
        name: 'Workflow 1',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [
          {
            id: 'job-1',
            jobName: 'main',
            status: 'running',
            createdAt: new Date().toISOString(),
            steps: [
              {
                id: 'step-1',
                name: 'Step 1',
                status: 'pending',
                createdAt: new Date().toISOString(),
                spec: { name: 'Step 1', uses: 'plugin:test-plugin/test-handler' },
              },
            ],
          } as JobRun,
        ],
      } as WorkflowRun;

      const run2: WorkflowRun = {
        id: 'run-2',
        name: 'Workflow 2',
        version: '1.0.0',
        status: 'running',
        createdAt: new Date().toISOString(),
        env: {},
        secrets: {},
        jobs: [
          {
            id: 'job-2',
            jobName: 'main',
            status: 'running',
            createdAt: new Date().toISOString(),
            steps: [
              {
                id: 'step-2',
                name: 'Step 2',
                status: 'pending',
                createdAt: new Date().toISOString(),
                spec: { name: 'Step 2', uses: 'plugin:test-plugin/test-handler' },
              },
            ],
          } as JobRun,
        ],
      } as WorkflowRun;

      engine.addRun(run1);
      engine.addRun(run2);
      engine.addJobToQueue({ runId: 'run-1', jobId: 'job-1', priority: 'normal', queuedAt: new Date().toISOString() });
      engine.addJobToQueue({ runId: 'run-2', jobId: 'job-2', priority: 'normal', queuedAt: new Date().toISOString() });

      worker = await createWorkflowWorker({
        engine: engine as any,
        executionBackend: backend as any,
        cliApi: cliApi as any,
        logger,
        workspaceRoot: '/test/workspace',
        concurrency: 2, // Process 2 jobs concurrently
      });

      const workerPromise = worker.start();
      await new Promise(resolve => setTimeout(resolve, 150));
      await worker.stop();

      // Both jobs should be completed
      expect(engine.markJobCompletedCalls).toHaveLength(2);
      expect(engine.markJobCompletedCalls).toEqual(
        expect.arrayContaining([
          { runId: 'run-1', jobId: 'job-1' },
          { runId: 'run-2', jobId: 'job-2' },
        ])
      );
    });
  });
});
