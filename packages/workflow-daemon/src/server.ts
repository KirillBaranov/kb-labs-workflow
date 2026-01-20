/**
 * @module @kb-labs/workflow-daemon/server
 * HTTP API server for workflow daemon management
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobBroker } from './job-broker.js';

export interface CreateServerOptions {
  engine: WorkflowEngine;
  jobBroker: JobBroker;
  logger: ILogger;
}

/**
 * Create Fastify HTTP server for workflow daemon.
 * Provides endpoints for job management and monitoring.
 */
export async function createServer(options: CreateServerOptions) {
  const { engine, jobBroker, logger } = options;

  const server = Fastify({
    logger: false, // Use platform logger instead
  });

  // Enable CORS
  await server.register(cors, {
    origin: true,
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

  // Job status
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

  // Submit job (POST)
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

  // List schedules (placeholder)
  server.get('/schedules', async () => {
    // TODO: Integrate with CronScheduler
    return {
      ok: true,
      data: { schedules: [] },
    };
  });

  return server;
}

function mapPriority(priority: number): 'low' | 'normal' | 'high' {
  if (priority <= 3) return 'low';
  if (priority <= 7) return 'normal';
  return 'high';
}
