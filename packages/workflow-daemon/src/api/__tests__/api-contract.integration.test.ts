import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerCronAPI } from '../cron-api.js';
import { registerJobsAPI } from '../jobs-api.js';
import { registerWorkflowsAPI } from '../workflows-api.js';

function createHostServiceMock() {
  return {
    submitJob: vi.fn(async () => ({ jobId: 'job-1' })),
    getJob: vi.fn(async () => ({ id: 'job-1', type: 'test', status: 'running' })),
    cancelJob: vi.fn(async () => ({ cancelled: true })),
    listJobs: vi.fn(async () => ({ jobs: [{ id: 'job-1', type: 'test', status: 'running' }] })),
    getJobSteps: vi.fn(async () => [{ id: 's1', status: 'success' }]),
    getJobLogs: vi.fn(async () => [{ message: 'log' }]),
    registerCron: vi.fn(() => ({ ok: true })),
    unregisterCron: vi.fn(() => ({ ok: true })),
    listCron: vi.fn(() => ({ crons: [{ id: 'c1', schedule: '* * * * *', jobType: 'test', enabled: true }] })),
    triggerCron: vi.fn(async () => ({ ok: true })),
    pauseCron: vi.fn(() => ({ ok: true })),
    resumeCron: vi.fn(() => ({ ok: true })),
    listWorkflows: vi.fn(async () => ({ workflows: [{ id: 'w1', name: 'wf', source: 'standalone' }] })),
    getWorkflow: vi.fn(async () => ({ id: 'w1', name: 'wf', source: 'standalone' })),
    runWorkflow: vi.fn(async () => ({ runId: 'r1', status: 'queued' })),
  };
}

describe('Workflow API Contract Integration', () => {
  let app: FastifyInstance;
  let hostService: ReturnType<typeof createHostServiceMock>;
  let engine: { getRun: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    app = Fastify({ logger: false });
    hostService = createHostServiceMock();
    engine = {
      getRun: vi.fn(),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as any;

    registerJobsAPI({ server: app, hostService: hostService as any, logger });
    registerCronAPI({ server: app, hostService: hostService as any, logger });
    registerWorkflowsAPI({ server: app, hostService: hostService as any, engine: engine as any, logger });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns envelope for jobs list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/jobs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      data: { jobs: [{ id: 'job-1', type: 'test', status: 'running' }] },
    });
  });

  it('supports cron v1 routes and rejects legacy aliases', async () => {
    const v1 = await app.inject({ method: 'POST', url: '/api/v1/cron/c1/pause' });
    const legacy = await app.inject({ method: 'POST', url: '/api/cron/c1/pause' });

    expect(v1.statusCode).toBe(200);
    expect(legacy.statusCode).toBe(404);
    expect(v1.json()).toEqual({ ok: true, data: { ok: true } });
  });

  it('returns envelope for cron list on v1 endpoint only', async () => {
    const v1 = await app.inject({ method: 'GET', url: '/api/v1/cron' });

    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toEqual({
      ok: true,
      data: { crons: [{ id: 'c1', schedule: '* * * * *', jobType: 'test', enabled: true }] },
    });
  });

  it('returns 404 envelope when workflow not found', async () => {
    hostService.getWorkflow.mockResolvedValueOnce(null as any);
    const res = await app.inject({ method: 'GET', url: '/api/v1/workflows/missing' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      ok: false,
      error: 'Workflow not found',
    });
  });
});
