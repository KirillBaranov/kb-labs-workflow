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

// Helper: Map WorkflowRun status to JobStatusInfo status
function mapRunStatusToJobStatus(
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'dlq'
): 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' {
  switch (status) {
    case 'queued': return 'pending';
    case 'running': return 'running';
    case 'success': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'skipped': return 'cancelled'; // Treat skipped as cancelled
    case 'dlq': return 'failed'; // Treat DLQ as failed
  }
}

/**
 * Register Jobs API routes
 */
export function registerJobsAPI(options: JobsAPIOptions): void {
  const { server, jobBroker, engine, logger } = options;

  /**
   * Submit job
   * POST /api/v1/jobs
   */
  server.post<{ Body: JobSubmissionRequest }>(
    '/api/v1/jobs',
    async (request, reply) => {
      // TODO: Security - validate tenant ID from authenticated JWT token, not from headers
      // Current implementation trusts x-tenant-id header which can be spoofed
      // For production: implement auth middleware that extracts tenant from verified token
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
      const { type, payload, priority } = request.body;

      if (!type) {
        reply.code(400);
        return { error: 'Missing required field: type' };
      }

      // Validate tenant ID format (alphanumeric, hyphens, underscores only) and length
      if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || tenantId.length > 64) {
        reply.code(400);
        return { error: 'Invalid tenant ID format or length (max 64 chars)' };
      }

      // Note: Payload size is already validated by Fastify bodyLimit (1MB)
      // No need to re-serialize the entire payload here

      // Validate priority range
      if (priority !== undefined && (priority < 1 || priority > 10)) {
        reply.code(400);
        return { error: 'Priority must be between 1 and 10' };
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
        // Log sanitized error details server-side (no sensitive data in logs)
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Job submission failed', error instanceof Error ? error : undefined, {
          message: sanitizeErrorMessage(errorMessage),
          type,
          tenantId,
        });
        reply.code(500);
        // Return sanitized error to client (no stack trace, no internal details)
        return {
          error: 'Job submission failed. Please check request and try again.',
        };
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
      // TODO: Security - validate tenant ID from authenticated JWT token, not from headers
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      // Validate tenant ID format and length
      if (!/^[a-zA-Z0-9_-]+$/.test(tenantId) || tenantId.length > 64) {
        reply.code(400);
        return { error: 'Invalid tenant ID format or length (max 64 chars)' };
      }

      try {
        const run = await engine.getRun(jobId);

        if (!run) {
          reply.code(404);
          return { error: 'Job not found' };
        }

        // Map WorkflowRun to JobStatusInfo with full details
        const jobInfo: JobStatusInfo = {
          id: run.id,
          type: run.name, // WorkflowRun.name maps to job type
          status: mapRunStatusToJobStatus(run.status),
          tenantId: run.tenantId ?? tenantId,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result,
          error: run.result?.error?.message,
        };

        // Include detailed jobs and steps data for full inspection
        const detailedResponse = {
          ...jobInfo,
          jobs: run.jobs?.map(job => ({
            id: job.id,
            name: job.jobName,
            status: job.status,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            durationMs: job.durationMs,
            error: job.error?.message,
            steps: job.steps?.map(step => ({
              id: step.id,
              name: step.name,
              status: step.status,
              handler: step.spec?.uses,
              startedAt: step.startedAt,
              finishedAt: step.finishedAt,
              durationMs: step.durationMs,
              outputs: step.outputs,
              error: step.error,
            })),
          })),
        };

        return detailedResponse;
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
   * POST /api/v1/jobs/:jobId/cancel
   */
  server.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/cancel',
    async (request, reply) => {
      const { jobId } = request.params;
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';

      try {
        await engine.cancelRun(jobId);

        logger.info('Job cancelled', { jobId, tenantId });

        const response: JobCancelResponse = {
          cancelled: true,
        };

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
   * GET /api/v1/jobs?type=pattern&status=running&limit=10&offset=0
   */
  server.get<{ Querystring: JobListFilter }>(
    '/api/v1/jobs',
    async (request, reply) => {
      const tenantId = (request.headers['x-tenant-id'] as string) ?? 'default';
      const { type, status, limit, offset } = request.query;

      try {
        // Get all runs from engine (including completed/failed/cancelled)
        const allRuns = await engine.getAllRuns();

        let jobs: JobStatusInfo[] = allRuns.map(run => ({
          id: run.id,
          type: run.name,
          status: mapRunStatusToJobStatus(run.status),
          tenantId: run.tenantId ?? tenantId,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          result: run.result,
          error: run.result?.error?.message,
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
  if (priority <= 3) {return 'low';}
  if (priority <= 7) {return 'normal';}
  return 'high';
}

/**
 * Sanitize error message by removing potential sensitive data patterns
 * (connection strings, API keys, tokens, passwords)
 */
function sanitizeErrorMessage(message: string): string {
  return message
    // Remove connection strings
    .replace(/(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi, '[CONNECTION_STRING]')
    // Remove API keys (common patterns)
    .replace(/(?:api[_-]?key|apikey|token)[=:]\s*[^\s&]+/gi, '[API_KEY]')
    // Remove Bearer tokens
    .replace(/bearer\s+[^\s]+/gi, 'Bearer [TOKEN]')
    // Remove passwords
    .replace(/(?:password|pwd)[=:]\s*[^\s&]+/gi, 'password=[REDACTED]')
    // Remove JWT tokens
    .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[JWT_TOKEN]');
}
