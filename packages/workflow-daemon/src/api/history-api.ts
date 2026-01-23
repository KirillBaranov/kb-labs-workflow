/**
 * @module @kb-labs/workflow-daemon/api/history-api
 * REST API endpoint for workflow run history
 */

import type { FastifyInstance } from 'fastify';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { WorkflowRunHistoryResponse, WorkflowRunSummary } from '@kb-labs/workflow-contracts';

export interface RegisterHistoryAPIOptions {
  server: FastifyInstance;
  engine: WorkflowEngine;
  logger: ILogger;
}

/**
 * Register workflow run history endpoints.
 *
 * Endpoints:
 * - GET /api/v1/workflows/:workflowId/runs - Get workflow run history
 */
export function registerHistoryAPI(options: RegisterHistoryAPIOptions): void {
  const { server, engine, logger } = options;

  // GET /api/v1/workflows/:workflowId/runs - Get workflow run history
  server.get<{
    Params: { workflowId: string };
    Querystring: { limit?: number; offset?: number; status?: string };
  }>('/api/v1/workflows/:workflowId/runs', async (request, reply) => {
    try {
      const { workflowId } = request.params;
      const { limit = 50, offset = 0, status } = request.query;

      logger.info(`[history-api] Fetching run history for workflow ${workflowId}`);

      // Get all runs from engine
      const allRuns = await engine.listRuns();

      // Filter by workflowId
      let runs = allRuns.filter((run) => run.workflowName === workflowId);

      // Filter by status if provided
      if (status) {
        runs = runs.filter((run) => run.status === status);
      }

      // Sort by startedAt descending (most recent first)
      runs.sort((a, b) => {
        const aTime = a.startedAt?.getTime() || 0;
        const bTime = b.startedAt?.getTime() || 0;
        return bTime - aTime;
      });

      // Calculate total before pagination
      const total = runs.length;

      // Paginate
      const paginatedRuns = runs.slice(offset, offset + limit);

      // Map to summary format
      const history: WorkflowRunSummary[] = paginatedRuns.map((run) => ({
        jobId: run.id,
        workflowId: run.workflowName,
        status: run.status,
        startedAt: run.startedAt?.toISOString(),
        finishedAt: run.finishedAt?.toISOString(),
        durationMs: run.durationMs,
        totalSteps: run.steps?.length || 0,
        completedSteps: run.steps?.filter((s) => s.status === 'completed').length || 0,
        error: run.error,
      }));

      const response: WorkflowRunHistoryResponse = {
        workflowId,
        runs: history,
        total,
        limit,
        offset,
      };

      return { ok: true, data: response };
    } catch (error) {
      logger.error('[history-api] Error fetching run history', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch run history',
      };
    }
  });

  logger.info('[history-api] Workflow run history API endpoint registered');
}
