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
import { WorkflowHostService } from './host/workflow-host-service.js';
import { registerJobsAPI } from './api/jobs-api.js';
import { registerCronAPI } from './api/cron-api.js';
import { registerWorkflowsAPI } from './api/workflows-api.js';
import { registerApprovalsAPI } from './api/approvals-api.js';
import { registerStatsAPI } from './api/stats-api.js';

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
  const hostService = new WorkflowHostService({
    engine,
    jobBroker,
    workflowService,
    cronScheduler,
    logger,
  });

  const server = Fastify({
    logger: false, // Use platform logger instead
    bodyLimit: 1048576, // 1MB body limit (prevents parsing huge payloads)
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const requireAuth = process.env.KB_DAEMON_REQUIRE_AUTH === 'true' || isProduction;
  const daemonApiKey = process.env.KB_DAEMON_API_KEY;
  const enableLegacyEndpoints = process.env.KB_DAEMON_ENABLE_LEGACY_ENDPOINTS === 'true';

  if (requireAuth && !daemonApiKey) {
    throw new Error(
      'KB_DAEMON_API_KEY is required when daemon auth is enabled (KB_DAEMON_REQUIRE_AUTH=true or NODE_ENV=production)'
    );
  }

  server.addHook('onRequest', async (request, reply) => {
    if (!requireAuth) {
      return;
    }

    if (request.url === '/health') {
      return;
    }

    const apiKeyHeader = request.headers['x-api-key'];
    const authHeader = request.headers.authorization;
    const bearerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined;

    const token = (typeof apiKeyHeader === 'string' ? apiKeyHeader : undefined) ?? bearerToken;

    if (!token || token !== daemonApiKey) {
      reply.code(401).send({ ok: false, error: 'Unauthorized' });
    }
  });

  // Enable CORS with restricted origins
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5173', // Vite dev server
  ];

  // @ts-expect-error - Fastify CORS plugin type mismatch
  await server.register(cors, {
    origin: (origin, callback) => {
      // TODO: Security - For production, implement proper authentication (API keys, mTLS)
      // instead of allowing no-origin requests. Currently allows for development convenience.

      // Allow requests with no origin ONLY in development
      if (!origin) {
        // Check NODE_ENV to determine environment
        const isDevelopment = process.env.NODE_ENV !== 'production';
        if (isDevelopment) {
          // Development: allow no-origin (curl, Postman, server-to-server)
          callback(null, true);
          return;
        }
        // Production: reject no-origin requests (enforce proper auth instead)
        callback(new Error('Origin header required in production'), false);
        return;
      }

      // Check if origin is in whitelist
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`), false);
      }
    },
  });

  // Register REST API routes
  registerJobsAPI({
    server,
    hostService,
    logger,
  });

  registerCronAPI({
    server,
    hostService,
    logger,
  });

  if (workflowService) {
    registerWorkflowsAPI({
      server,
      hostService,
      engine,
      logger,
    });
  }

  // Approvals API (always enabled — needed for builtin:approval steps)
  registerApprovalsAPI({
    server,
    engine,
    logger,
  });

  // Stats API — dashboard statistics
  registerStatsAPI({
    server,
    hostService,
    cronScheduler,
    logger,
  });
  // and need to be rewritten for new WorkflowRun structure (name instead of workflowName,
  // jobs instead of steps, result.error instead of error, datetime strings instead of Date objects)

  // Register stats API (dashboard)
  // registerStatsAPI({
  //   server,
  //   engine,
  //   jobBroker,
  //   workflowService,
  //   cronScheduler,
  //   logger,
  // });

  // Register logs API
  // registerLogsAPI({
  //   server,
  //   jobBroker,
  //   logger,
  // });

  // Register steps API
  // registerStepsAPI({
  //   server,
  //   engine,
  //   logger,
  // });

  // Register history API
  // registerHistoryAPI({
  //   server,
  //   engine,
  //   logger,
  // });

  // Health check
  server.get('/health', async () => {
    return hostService.getHealth();
  });

  // Metrics
  server.get('/metrics', async () => {
    const metrics = await hostService.getMetrics();
    return {
      ok: true,
      data: metrics,
    };
  });

  // Legacy endpoints are disabled by default.
  // Re-enable only when explicitly requested via KB_DAEMON_ENABLE_LEGACY_ENDPOINTS=true.
  if (!enableLegacyEndpoints) {
    logger.info('Legacy daemon endpoints are disabled');
    return server;
  }

  logger.warn('Legacy daemon endpoints are enabled; use /api/* routes for production clients');

  // Job status (legacy)
  server.get<{ Params: { id: string } }>('/jobs/:id/status', async (request, reply) => {
    const { id } = request.params;
    const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
    try {
      const status = await hostService.getJob(tenantId, id);
      return { ok: true, data: status };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get job status';
      reply.code(message === 'Job not found' ? 404 : 500);
      return { ok: false, error: message };
    }
  });

  // Job logs (placeholder - uses platform.logger filtering)
  server.get<{ Params: { id: string } }>('/jobs/:id/logs', async (request, reply) => {
    const { id } = request.params;
    try {
      const logs = await hostService.getJobLogs(id);
      return { ok: true, data: { logs } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to get logs';
      reply.code(message === 'Job not found' ? 404 : 500);
      return { ok: false, error: message };
    }
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

      const submission = await hostService.submitJob('default', {
        type: handler,
        payload: input,
        priority,
      });

      return {
        ok: true,
        data: {
          id: submission.jobId,
          status: 'pending',
        },
      };
    }
  );

  // List active executions
  server.get('/executions', async () => {
    const executions = await hostService.listActiveExecutions();
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

    const data = hostService.listLegacyCronJobs();
    return {
      ok: true,
      data,
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
