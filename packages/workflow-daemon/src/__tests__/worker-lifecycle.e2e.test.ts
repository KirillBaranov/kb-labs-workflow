import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initPlatform, platform, resetPlatform } from '@kb-labs/core-runtime';
import { createWorkflowWorker } from '../worker.js';

const executeMock = vi.fn(async () => ({
  ok: true,
  data: { ok: true },
  executionTimeMs: 1,
}));
const shutdownMock = vi.fn(async () => undefined);
const createExecutionBackendMock = vi.fn(() => ({
  execute: executeMock,
  shutdown: shutdownMock,
}));

vi.mock('@kb-labs/plugin-execution-factory', () => ({
  createExecutionBackend: createExecutionBackendMock,
}));

function hasDocker(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('workflow worker lifecycle e2e', () => {
  let sandboxDir: string;

  beforeEach(async () => {
    resetPlatform();
    executeMock.mockClear();
    shutdownMock.mockClear();
    createExecutionBackendMock.mockClear();
    sandboxDir = await mkdtemp(path.join(tmpdir(), 'kb-workflow-worker-e2e-'));
  });

  afterEach(async () => {
    try {
      await platform.shutdown();
    } catch {
      // Best-effort shutdown in tests.
    }
    await rm(sandboxDir, { recursive: true, force: true });
    resetPlatform();
  });

  it.skipIf(!hasDocker())(
    'creates and cleans environment/workspace for strict isolation without adapter-specific assertions',
    async () => {
      const workspaceRoot = path.resolve(process.cwd(), '../../..');
      const originalProcessSend = (process as any).send;
      (process as any).send = undefined;

      try {
        await initPlatform(
          {
            adapters: {
              db: '@kb-labs/adapters-sqlite',
              environment: '@kb-labs/adapters-environment-docker',
              workspace: '@kb-labs/adapters-workspace-localfs',
            } as any,
            adapterOptions: {
              db: { filename: ':memory:' },
              environment: {
                defaultImage: 'node:20-alpine',
                autoRemove: true,
                mountWorkspace: false,
                defaultTtlMs: 5 * 60 * 1000,
              },
              workspace: {
                rootDir: path.join(sandboxDir, 'workspaces'),
                registryDir: path.join(sandboxDir, 'workspace-registry'),
                workspace: { cwd: workspaceRoot },
              },
            } as any,
            execution: {
              mode: 'in-process',
            },
          },
          workspaceRoot
        );
      } finally {
        (process as any).send = originalProcessSend;
      }

      const runId = `run-${Date.now().toString(36)}`;
      const jobId = `${runId}:job`;
      const run: any = {
        id: runId,
        tenantId: 'default',
        env: {},
        metadata: { isolation: 'strict' },
        jobs: [{
          id: jobId,
          jobName: 'job',
          status: 'queued',
          attempt: 0,
          steps: [],
        }],
      };

      const createdEnvironmentIds: string[] = [];
      const destroyedEnvironmentIds: string[] = [];
      const releasedWorkspaceIds: string[] = [];
      const completion = createDeferred<void>();

      const environmentManager = {
        async create(request: any) {
          const descriptor = await platform.environmentManager.createEnvironment(request);
          createdEnvironmentIds.push(descriptor.environmentId);
          return { environmentId: descriptor.environmentId };
        },
        async destroy(environmentId: string, reason?: string) {
          destroyedEnvironmentIds.push(environmentId);
          await platform.environmentManager.destroyEnvironment(environmentId, reason);
        },
      };

      const workspaceManager = {
        async materialize(request: any) {
          const descriptor = await platform.workspaceManager.materializeWorkspace(request);
          return {
            workspaceId: descriptor.workspaceId,
            rootPath: descriptor.rootPath,
          };
        },
        async attach(request: { workspaceId: string; environmentId: string }) {
          return platform.workspaceManager.attachWorkspace(request);
        },
        async release(workspaceId: string, environmentId?: string) {
          releasedWorkspaceIds.push(workspaceId);
          await platform.workspaceManager.releaseWorkspace(workspaceId, environmentId);
        },
      };

      let queueDrained = false;
      const engine: any = {
        async nextJob() {
          if (queueDrained) {
            return null;
          }
          queueDrained = true;
          return { runId, jobId };
        },
        async getRun(requestedRunId: string) {
          return requestedRunId === runId ? run : null;
        },
        async markJobStarted() {
          run.jobs[0].status = 'running';
        },
        async markJobCompleted() {
          run.jobs[0].status = 'success';
          completion.resolve();
        },
        async markJobFailed(_r: string, _j: string, error: Error) {
          completion.reject(error);
        },
        async markStepStarted() {},
        async markStepCompleted() {},
        async markStepFailed() {},
        async markJobInterrupted() {},
      };

      const worker = await createWorkflowWorker({
        engine,
        executionBackend: {} as any,
        cliApi: {} as any,
        logger: platform.logger,
        workspaceRoot,
        platform: {
          getAdapter<T>(key: string): T | undefined {
            if (key === 'environment') {
              return environmentManager as T;
            }
            if (key === 'workspace') {
              return workspaceManager as T;
            }
            return undefined;
          },
        },
        concurrency: 1,
      });

      const startPromise = worker.start();
      await Promise.race([
        completion.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('worker completion timeout')), 20_000)),
      ]);
      await worker.stop();
      await startPromise;

      expect(run.jobs[0].status).toBe('success');
      expect(createdEnvironmentIds.length).toBe(1);
      expect(destroyedEnvironmentIds).toEqual(createdEnvironmentIds);
      expect(releasedWorkspaceIds.length).toBe(1);

      const createdEnvironmentId = createdEnvironmentIds[0];
      expect(createdEnvironmentId).toBeDefined();
      const finalEnvironmentStatus = await platform.environmentManager.getEnvironmentStatus(createdEnvironmentId as string);
      expect(finalEnvironmentStatus.status).toBe('terminated');
    }
  );
});
