/**
 * @module @kb-labs/workflow-daemon/api/cron
 * Cron REST API routes
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { CronRegistrationRequest } from '@kb-labs/workflow-contracts';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import { fail, ok } from './response.js';

interface CronIdParams {
  id: string;
}

export interface CronAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  logger: ILogger;
}

/**
 * Register Cron API routes
 */
export function registerCronAPI(options: CronAPIOptions): void {
  const { server, hostService, logger } = options;

  const registerCronHandler = async (
    request: { headers: Record<string, unknown>; body: CronRegistrationRequest },
    reply: any,
  ) => {
    const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
    try {
      const data = hostService.registerCron(tenantId, request.body);
      return ok(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to register cron job';
      if (message === 'Cron scheduler not available') {
        return fail(reply, 503, message);
      }
      if (message.startsWith('Missing required fields')) {
        return fail(reply, 400, message);
      }
      logger.error('Failed to register cron job', error instanceof Error ? error : undefined);
      return fail(reply, 500, message);
    }
  };

  const listCronHandler = async (_request: unknown, reply: any) => {
    try {
      return ok(hostService.listCron());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list cron jobs';
      if (message === 'Cron scheduler not available') {
        return fail(reply, 503, message);
      }
      logger.error('Failed to list cron jobs', error instanceof Error ? error : undefined);
      return fail(reply, 500, message);
    }
  };

  const unregisterCronHandler = async (
    request: { params: CronIdParams; headers: Record<string, unknown> },
    reply: any,
  ) => {
    const { id } = request.params;
    const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
    try {
      const data = hostService.unregisterCron(tenantId, id);
      return ok(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to unregister cron job';
      if (message === 'Cron scheduler not available') {
        return fail(reply, 503, message);
      }
      logger.error('Failed to unregister cron job', error instanceof Error ? error : undefined);
      return fail(reply, 500, message);
    }
  };

  const triggerCronHandler = async (
    request: { params: CronIdParams; headers: Record<string, unknown> },
    reply: any,
  ) => {
    const { id } = request.params;
    const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
    try {
      const data = await hostService.triggerCron(tenantId, id);
      return ok(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to trigger cron job';
      if (message === 'Cron scheduler not available') {
        return fail(reply, 503, message);
      }
      logger.error('Failed to trigger cron job', error instanceof Error ? error : undefined);
      return fail(reply, 500, message);
    }
  };

  const pauseCronHandler = async (
    request: { params: CronIdParams; headers: Record<string, unknown> },
    reply: any,
  ) => {
    const { id } = request.params;
    const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
    try {
      const data = hostService.pauseCron(tenantId, id);
      return ok(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to pause cron job';
      if (message === 'Cron scheduler not available') {
        return fail(reply, 503, message);
      }
      logger.error('Failed to pause cron job', error instanceof Error ? error : undefined);
      return fail(reply, 500, message);
    }
  };

  const resumeCronHandler = async (
    request: { params: CronIdParams; headers: Record<string, unknown> },
    reply: any,
  ) => {
    const { id } = request.params;
    const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
    try {
      const data = hostService.resumeCron(tenantId, id);
      return ok(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resume cron job';
      if (message === 'Cron scheduler not available') {
        return fail(reply, 503, message);
      }
      logger.error('Failed to resume cron job', error instanceof Error ? error : undefined);
      return fail(reply, 500, message);
    }
  };

  // Canonical v1 routes
  server.post<{ Body: CronRegistrationRequest }>('/api/v1/cron', registerCronHandler as any);
  server.get('/api/v1/cron', listCronHandler as any);
  server.delete<{ Params: CronIdParams }>('/api/v1/cron/:id', unregisterCronHandler as any);
  server.post<{ Params: CronIdParams }>('/api/v1/cron/:id/trigger', triggerCronHandler as any);
  server.post<{ Params: CronIdParams }>('/api/v1/cron/:id/pause', pauseCronHandler as any);
  server.post<{ Params: CronIdParams }>('/api/v1/cron/:id/resume', resumeCronHandler as any);
}
