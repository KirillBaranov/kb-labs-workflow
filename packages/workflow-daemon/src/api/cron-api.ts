/**
 * @module @kb-labs/workflow-daemon/api/cron
 * Cron REST API routes
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { CronScheduler } from '../cron-scheduler.js';
import type {
  CronRegistrationRequest,
  CronInfo,
  CronListResponse,
} from '@kb-labs/workflow-contracts';

export interface CronAPIOptions {
  server: FastifyInstance;
  cronScheduler?: CronScheduler;
  logger: ILogger;
}

/**
 * Register Cron API routes
 */
export function registerCronAPI(options: CronAPIOptions): void {
  const { server, cronScheduler, logger } = options;

  /**
   * Register cron job
   * POST /api/cron
   */
  server.post<{ Body: CronRegistrationRequest }>(
    '/api/v1/cron',
    async (request, reply) => {
      if (!cronScheduler) {
        reply.code(503);
        return { error: 'Cron scheduler not available' };
      }

      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
      const { id, schedule, jobType, payload, timezone, enabled } = request.body;

      if (!id || !schedule || !jobType) {
        reply.code(400);
        return {
          error: 'Missing required fields: id, schedule, jobType',
        };
      }

      try {
        // Register cron job with CronScheduler
        cronScheduler.register({
          id,
          source: 'api', // Mark as API-registered
          schedule,
          timezone: timezone ?? 'UTC',
          priority: 'normal',
          enabled: enabled ?? true,
          handler: jobType, // CronScheduler uses 'handler' internally
          metadata: {
            tenantId,
            payload,
          },
        });

        logger.info('Cron job registered', { id, schedule, jobType, tenantId });
        return { ok: true };
      } catch (error) {
        logger.error('Failed to register cron job', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to register cron job',
        };
      }
    }
  );

  /**
   * Unregister cron job
   * DELETE /api/cron/:id
   */
  server.delete<{ Params: { id: string } }>(
    '/api/cron/:id',
    async (request, reply) => {
      if (!cronScheduler) {
        reply.code(503);
        return { error: 'Cron scheduler not available' };
      }

      const { id } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        cronScheduler.unregister(id);
        logger.info('Cron job unregistered', { id, tenantId });
        return { ok: true };
      } catch (error) {
        logger.error('Failed to unregister cron job', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to unregister cron job',
        };
      }
    }
  );

  /**
   * List cron jobs
   * GET /api/cron
   */
  server.get('/api/v1/cron', async (request, reply) => {
    if (!cronScheduler) {
      reply.code(503);
      return { error: 'Cron scheduler not available' };
    }

    const _tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
    // TODO: Filter cron jobs by tenant when multi-tenancy is implemented

    try {
      const registeredJobs = cronScheduler.getRegisteredJobs();

      // Map CronScheduler jobs to CronInfo
      const crons: CronInfo[] = registeredJobs.map(job => {
        // Get next run time from scheduler
        const nextRun = cronScheduler.getNextRunTime(job.id);

        return {
          id: job.id,
          schedule: job.schedule,
          jobType: job.handler,
          timezone: job.timezone,
          enabled: job.enabled,
          // TODO: Track lastRun from execution history
          lastRun: undefined,
          nextRun: nextRun ?? undefined,
          pluginId: job.source === 'plugin' ? job.id.split(':')[1] : undefined,
        };
      });

      const response: CronListResponse = {
        crons,
      };

      return response;
    } catch (error) {
      logger.error('Failed to list cron jobs', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        error: error instanceof Error ? error.message : 'Failed to list cron jobs',
      };
    }
  });

  /**
   * Trigger cron job manually
   * POST /api/cron/:id/trigger
   */
  server.post<{ Params: { id: string } }>(
    '/api/cron/:id/trigger',
    async (request, reply) => {
      if (!cronScheduler) {
        reply.code(503);
        return { error: 'Cron scheduler not available' };
      }

      const { id } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        await cronScheduler.triggerNow(id);
        logger.info('Cron job triggered manually', { id, tenantId });
        return { ok: true };
      } catch (error) {
        logger.error('Failed to trigger cron job', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to trigger cron job',
        };
      }
    }
  );

  /**
   * Pause cron job
   * POST /api/cron/:id/pause
   */
  server.post<{ Params: { id: string } }>(
    '/api/cron/:id/pause',
    async (request, reply) => {
      if (!cronScheduler) {
        reply.code(503);
        return { error: 'Cron scheduler not available' };
      }

      const { id } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        cronScheduler.pause(id);
        logger.info('Cron job paused', { id, tenantId });
        return { ok: true };
      } catch (error) {
        logger.error('Failed to pause cron job', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to pause cron job',
        };
      }
    }
  );

  /**
   * Resume cron job
   * POST /api/cron/:id/resume
   */
  server.post<{ Params: { id: string } }>(
    '/api/cron/:id/resume',
    async (request, reply) => {
      if (!cronScheduler) {
        reply.code(503);
        return { error: 'Cron scheduler not available' };
      }

      const { id } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        cronScheduler.resume(id);
        logger.info('Cron job resumed', { id, tenantId });
        return { ok: true };
      } catch (error) {
        logger.error('Failed to resume cron job', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to resume cron job',
        };
      }
    }
  );
}
