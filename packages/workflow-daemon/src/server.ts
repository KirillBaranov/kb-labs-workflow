/**
 * @module @kb-labs/workflow-daemon/server
 * HTTP API server for workflow daemon management
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { WorkflowEngine, WorkflowService } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobBroker } from './job-broker.js';
import type { CronScheduler } from './cron-scheduler.js';
import type { CronDiscovery } from './cron-discovery.js';
import { registerJobsAPI } from './api/jobs-api.js';
import { registerCronAPI } from './api/cron-api.js';
import { registerWorkflowsAPI } from './api/workflows-api.js';
import { registerStatsAPI } from './api/stats-api.js';
import { registerLogsAPI } from './api/logs-api.js';
import { registerStepsAPI } from './api/steps-api.js';
import { registerHistoryAPI } from './api/history-api.js';

export interface CreateServerOptions {
  engine: WorkflowEngine;
  jobBroker: JobBroker;
  workflowService?: WorkflowService;
  cronScheduler?: CronScheduler;
  cronDiscovery?: CronDiscovery;
  logger: ILogger;
}

/**
 * Create Fastify HTTP server for workflow daemon.
 * Provides endpoints for job management and monitoring.
 */
export async function createServer(options: CreateServerOptions) {
  const { engine, jobBroker, workflowService, cronScheduler, cronDiscovery, logger } = options;

  const server = Fastify({
    logger: false, // Use platform logger instead
  });

  // Enable CORS
  await server.register(cors, {
    origin: true,
  });

  // Register REST API routes
  registerJobsAPI({
    server,
    jobBroker,
    engine,
    logger,
  });

  registerCronAPI({
    server,
    cronScheduler,
    logger,
  });

  if (workflowService) {
    registerWorkflowsAPI({
      server,
      workflowService,
      engine,
      logger,
    });
  }

  // Register stats API (dashboard)
  registerStatsAPI({
    server,
    engine,
    jobBroker,
    workflowService,
    cronScheduler,
    logger,
  });

  // Register logs API
  registerLogsAPI({
    server,
    jobBroker,
    logger,
  });

  // Register steps API
  registerStepsAPI({
    server,
    engine,
    logger,
  });

  // Register history API
  registerHistoryAPI({
    server,
    engine,
    logger,
  });

  // Health check
  server.get('/health', async () => {
    return { ok: true, service: 'workflow-daemon' };
  });

  // Metrics
  server.get('/metrics', async () => {
    const metrics = await engine.getMetrics();
    return {
      ok: true,
      data: metrics,
    };
  });

  // Legacy endpoints (kept for backward compatibility)
  // TODO: Deprecate these in favor of /api/* endpoints

  // Job status (legacy)
  server.get<{ Params: { id: string } }>('/jobs/:id/status', async (request, reply) => {
    const { id } = request.params;
    const run = await engine.getRun(id);

    if (!run) {
      reply.code(404);
      return { ok: false, error: 'Job not found' };
    }

    return {
      ok: true,
      data: {
        id: run.id,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
    };
  });

  // Job logs (placeholder - uses platform.logger filtering)
  server.get<{ Params: { id: string } }>('/jobs/:id/logs', async (request, reply) => {
    const { id } = request.params;
    const run = await engine.getRun(id);

    if (!run) {
      reply.code(404);
      return { ok: false, error: 'Job not found' };
    }

    // TODO: Query platform.logger with filter { runId: id }
    // For now, return placeholder
    return {
      ok: true,
      data: {
        logs: [
          {
            level: 'info',
            message: 'Logs filtered by platform.logger (not yet implemented)',
            runId: id,
          },
        ],
      },
    };
  });

  // Submit job (legacy - use POST /api/jobs instead)
  server.post<{ Body: { handler: string; input?: unknown; priority?: number } }>(
    '/jobs/submit',
    async (request, reply) => {
      const { handler, input, priority } = request.body;

      if (!handler) {
        reply.code(400);
        return { ok: false, error: 'Missing handler field' };
      }

      const run = await jobBroker.submit({
        handler,
        input,
        priority: mapPriority(priority ?? 5),
      });

      return {
        ok: true,
        data: {
          id: run.id,
          status: run.status,
        },
      };
    }
  );

  // List active executions
  server.get('/executions', async () => {
    const executions = await engine.getActiveExecutions();
    return {
      ok: true,
      data: { executions },
    };
  });

  // List cron jobs
  server.get('/cron/jobs', async () => {
    if (!cronScheduler) {
      return {
        ok: true,
        data: { cronJobs: [] },
      };
    }

    const cronJobs = cronScheduler.getRegisteredJobs();
    return {
      ok: true,
      data: {
        cronJobs: cronJobs.map(job => ({
          id: job.id,
          source: job.source,
          schedule: job.schedule,
          timezone: job.timezone,
          priority: job.priority,
          enabled: job.enabled,
          handler: job.handler,
          workflowName: job.workflowSpec?.name,
          metadata: job.metadata,
        })),
        total: cronJobs.length,
        running: cronScheduler.isSchedulerRunning(),
      },
    };
  });

  // Refresh cron jobs (reload from disk without daemon restart)
  server.post('/cron/refresh', async () => {
    if (!cronScheduler || !cronDiscovery) {
      return {
        ok: false,
        error: 'CronScheduler or CronDiscovery not available',
      };
    }

    try {
      logger.info('Refreshing cron jobs from disk');

      // Stop scheduler
      const wasRunning = cronScheduler.isSchedulerRunning();
      if (wasRunning) {
        await cronScheduler.stop();
      }

      // Clear all jobs
      cronScheduler.clearAll();

      // Rediscover
      const discovered = await cronDiscovery.discoverAll();
      logger.info('Cron jobs rediscovered', discovered);

      // Restart if was running
      if (wasRunning && discovered.plugins + discovered.users > 0) {
        await cronScheduler.start();
      }

      return {
        ok: true,
        data: {
          discovered,
          schedulerRestarted: wasRunning,
        },
      };
    } catch (error) {
      logger.error('Failed to refresh cron jobs', error instanceof Error ? error : undefined);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return server;
}

function mapPriority(priority: number): 'low' | 'normal' | 'high' {
  if (priority <= 3) return 'low';
  if (priority <= 7) return 'normal';
  return 'high';
}
