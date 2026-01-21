/**
 * @module @kb-labs/workflow-daemon/api/jobs
 * Jobs REST API routes
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobBroker } from '../job-broker.js';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type {
  JobSubmissionRequest,
  JobSubmissionResponse,
  JobStatusInfo,
  JobListFilter,
  JobListResponse,
  JobCancelResponse,
} from '@kb-labs/workflow-contracts';

export interface JobsAPIOptions {
  server: FastifyInstance;
  jobBroker: JobBroker;
  engine: WorkflowEngine;
  logger: ILogger;
}

/**
 * Register Jobs API routes
 */
export function registerJobsAPI(options: JobsAPIOptions): void {
  const { server, jobBroker, engine, logger } = options;

  /**
   * Submit job
   * POST /api/jobs
   */
  server.post<{ Body: JobSubmissionRequest }>(
    '/api/jobs',
    async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
      const { type, payload, priority, maxRetries, timeout, runAt, idempotencyKey } = request.body;

      if (!type) {
        reply.code(400);
        return { error: 'Missing required field: type' };
      }

      try {
        // Map plugin-contracts format to JobBroker format
        const run = await jobBroker.submit({
          handler: type, // JobBroker uses 'handler' internally
          input: payload,
          priority: mapPriority(priority ?? 5),
          // TODO: Support maxRetries, timeout, runAt, idempotencyKey
        });

        const response: JobSubmissionResponse = {
          jobId: run.id,
        };

        logger.info('Job submitted', { jobId: run.id, type, tenantId });
        return response;
      } catch (error) {
        logger.error('Job submission failed', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Job submission failed',
        };
      }
    }
  );

  /**
   * Get job status
   * GET /api/jobs/:jobId
   */
  server.get<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId',
    async (request, reply) => {
      const { jobId } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const run = await engine.getRun(jobId);

        if (!run) {
          reply.code(404);
          return { error: 'Job not found' };
        }

        // Map WorkflowRun to JobStatusInfo
        const jobInfo: JobStatusInfo = {
          id: run.id,
          type: run.name, // WorkflowRun.name maps to job type
          status: run.status,
          tenantId: run.tenantId ?? tenantId,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result,
          error: run.error,
          // TODO: Add priority, attempt, maxRetries, progress from run metadata
        };

        return jobInfo;
      } catch (error) {
        logger.error('Failed to get job status', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to get job status',
        };
      }
    }
  );

  /**
   * Cancel job
   * POST /api/jobs/:jobId/cancel
   */
  server.post<{ Params: { jobId: string } }>(
    '/api/jobs/:jobId/cancel',
    async (request, reply) => {
      const { jobId } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        const cancelled = await engine.cancelRun(jobId);

        const response: JobCancelResponse = {
          cancelled,
        };

        if (cancelled) {
          logger.info('Job cancelled', { jobId, tenantId });
        } else {
          logger.warn('Job cancellation failed (already finished?)', { jobId, tenantId });
        }

        return response;
      } catch (error) {
        logger.error('Failed to cancel job', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to cancel job',
        };
      }
    }
  );

  /**
   * List jobs
   * GET /api/jobs?type=pattern&status=running&limit=10&offset=0
   */
  server.get<{ Querystring: JobListFilter }>(
    '/api/jobs',
    async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
      const { type, status, limit, offset } = request.query;

      try {
        // Get all runs from engine (including completed/failed/cancelled)
        const allRuns = await engine.getAllRuns();

        let jobs: JobStatusInfo[] = allRuns.map(run => ({
          id: run.id,
          type: run.name,
          status: run.status,
          tenantId: run.tenantId ?? tenantId,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result,
          error: run.error,
        }));

        // Apply filters
        if (type) {
          const pattern = type.replace(/\*/g, '.*');
          const regex = new RegExp(`^${pattern}$`);
          jobs = jobs.filter(job => regex.test(job.type));
        }

        if (status) {
          jobs = jobs.filter(job => job.status === status);
        }

        // Apply pagination
        const start = offset ?? 0;
        const end = limit ? start + limit : jobs.length;
        jobs = jobs.slice(start, end);

        const response: JobListResponse = {
          jobs,
        };

        return response;
      } catch (error) {
        logger.error('Failed to list jobs', error instanceof Error ? error : undefined);
        reply.code(500);
        return {
          error: error instanceof Error ? error.message : 'Failed to list jobs',
        };
      }
    }
  );
}

/**
 * Map priority number (1-10) to JobBroker priority ('low' | 'normal' | 'high')
 */
function mapPriority(priority: number): 'low' | 'normal' | 'high' {
  if (priority <= 3) return 'low';
  if (priority <= 7) return 'normal';
  return 'high';
}
