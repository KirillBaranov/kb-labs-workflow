/**
 * @module @kb-labs/workflow-daemon/api/jobs
 * Jobs REST API routes
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type {
  JobSubmissionRequest,
  JobListFilter,
} from '@kb-labs/workflow-contracts';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import { fail, ok } from './response.js';

export interface JobsAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  logger: ILogger;
}

/**
 * Register Jobs API routes
 */
export function registerJobsAPI(options: JobsAPIOptions): void {
  const { server, hostService, logger } = options;

  /**
   * Submit job
   * POST /api/v1/jobs
   */
  server.post<{ Body: JobSubmissionRequest }>(
    '/api/v1/jobs',
    async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const data = await hostService.submitJob(tenantId, request.body);
        return ok(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Job submission failed';
        logger.error('Job submission failed', error instanceof Error ? error : undefined, { tenantId });
        if (message.startsWith('Invalid tenant') || message.startsWith('Missing required') || message.startsWith('Priority')) {
          return fail(reply, 400, message);
        } else {
          return fail(reply, 500, message);
        }
      }
    }
  );

  /**
   * Get job status
   * GET /api/v1/jobs/:jobId
   */
  server.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const data = await hostService.getJob(tenantId, jobId);
        return ok(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get job status';
        if (message === 'Job not found') {
          return fail(reply, 404, message);
        }
        logger.error('Failed to get job status', error instanceof Error ? error : undefined, { jobId });
        return fail(reply, 500, message);
      }
    }
  );

  /**
   * Cancel job
   * POST /api/v1/jobs/:jobId/cancel
   */
  server.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/cancel',
    async (request, reply) => {
      const { jobId } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const data = await hostService.cancelJob(tenantId, jobId);
        return ok(data);
      } catch (error) {
        logger.error('Failed to cancel job', error instanceof Error ? error : undefined);
        return fail(reply, 500, error instanceof Error ? error.message : 'Failed to cancel job');
      }
    }
  );

  /**
   * List jobs
   * GET /api/v1/jobs?type=pattern&status=running&limit=10&offset=0
   */
  server.get<{ Querystring: JobListFilter }>(
    '/api/v1/jobs',
    async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
      const filter = request.query;

      try {
        const data = await hostService.listJobs(tenantId, filter);
        return ok(data);
      } catch (error) {
        logger.error('Failed to list jobs', error instanceof Error ? error : undefined);
        return fail(reply, 500, error instanceof Error ? error.message : 'Failed to list jobs');
      }
    }
  );
  server.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/steps',
    async (request, reply) => {
      const { jobId } = request.params;
      try {
        const steps = await hostService.getJobSteps(jobId);
        return ok(steps);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get job steps';
        if (message === 'Job not found') {
          return fail(reply, 404, message);
        }
        return fail(reply, 500, message);
      }
    }
  );

  server.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/logs',
    async (request, reply) => {
      const { jobId } = request.params;
      const limit =
        typeof request.query === 'object' && request.query && 'limit' in request.query
          ? Number((request.query as Record<string, unknown>).limit)
          : undefined;
      const offset =
        typeof request.query === 'object' && request.query && 'offset' in request.query
          ? Number((request.query as Record<string, unknown>).offset)
          : undefined;
      const level =
        typeof request.query === 'object' && request.query && 'level' in request.query
          ? String((request.query as Record<string, unknown>).level)
          : undefined;

      try {
        const logs = await hostService.getJobLogs(jobId, { limit, offset, level });
        return ok({ logs });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get job logs';
        if (message === 'Job not found') {
          return fail(reply, 404, message);
        }
        return fail(reply, 500, message);
      }
    }
  );
}
