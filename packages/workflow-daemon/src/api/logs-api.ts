/**
 * @module @kb-labs/workflow-daemon/api/logs-api
 * REST API endpoint for job logs
 */

import type { FastifyInstance } from 'fastify';
import type { JobBroker } from '../job-broker.js';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobLogsResponse } from '@kb-labs/workflow-contracts';

export interface RegisterLogsAPIOptions {
  server: FastifyInstance;
  jobBroker: JobBroker;
  logger: ILogger;
}

/**
 * Register job logs endpoints.
 *
 * Endpoints:
 * - GET /api/v1/jobs/:jobId/logs - Get job execution logs
 */
export function registerLogsAPI(options: RegisterLogsAPIOptions): void {
  const { server, jobBroker, logger } = options;

  // GET /api/v1/jobs/:jobId/logs - Get job logs
  server.get<{
    Params: { jobId: string };
    Querystring: { limit?: number; offset?: number; level?: string };
  }>('/api/v1/jobs/:jobId/logs', async (request, reply) => {
    try {
      const { jobId } = request.params;
      const { limit = 100, offset = 0, level = 'all' } = request.query;

      logger.info(`[logs-api] Fetching logs for job ${jobId}`, { limit, offset, level });

      // Get logs from job broker
      const logs = await jobBroker.getJobLogs(jobId, { limit, offset, level });

      const response: JobLogsResponse = {
        jobId,
        logs,
        total: logs.length,
        hasMore: logs.length === limit,
      };

      return { ok: true, data: response };
    } catch (error) {
      logger.error('[logs-api] Error fetching job logs', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch job logs',
      };
    }
  });

  logger.info('[logs-api] Job logs API endpoint registered');
}
