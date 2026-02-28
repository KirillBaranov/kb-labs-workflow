/**
 * @module @kb-labs/workflow-daemon/api/workflows-api
 * REST API endpoints for managing workflow definitions
 */

import type { FastifyInstance } from 'fastify';
import type { ILogger } from '@kb-labs/core-platform';
import type { WorkflowRunRequest } from '@kb-labs/workflow-contracts';
import type { WorkflowHostService } from '../host/workflow-host-service.js';
import { fail, ok } from './response.js';

export interface RegisterWorkflowsAPIOptions {
  server: FastifyInstance;
  hostService: WorkflowHostService;
  logger: ILogger;
}

/**
 * Register workflow definition management endpoints.
 *
 * Endpoints:
 * - GET /api/v1/workflows - List all workflow definitions
 * - GET /api/v1/workflows/:id - Get workflow definition details
 * - POST /api/v1/workflows/:id/run - Run a workflow
 */
export function registerWorkflowsAPI(options: RegisterWorkflowsAPIOptions): void {
  const { server, hostService, logger } = options;

  // GET /api/v1/workflows - List all workflow definitions
  server.get<{
    Querystring: {
      source?: 'manifest' | 'standalone';
      status?: 'active' | 'inactive';
      tags?: string;
    };
  }>('/api/v1/workflows', async (request, reply) => {
    try {
      const response = await hostService.listWorkflows(request.query);
      return ok(response);
    } catch (error) {
      logger.error('[workflows-api] Error listing workflows', error instanceof Error ? error : undefined);
      return fail(reply, 500, error instanceof Error ? error.message : 'Failed to list workflows');
    }
  });

  // GET /api/v1/workflows/:id - Get workflow definition details
  server.get<{
    Params: { id: string };
  }>('/api/v1/workflows/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      const workflow = await hostService.getWorkflow(id);
      if (!workflow) {
        return fail(reply, 404, 'Workflow not found');
      }
      return ok(workflow);
    } catch (error) {
      logger.error('[workflows-api] Error getting workflow', error instanceof Error ? error : undefined);
      return fail(reply, 500, error instanceof Error ? error.message : 'Failed to get workflow');
    }
  });

  // POST /api/v1/workflows/:id/run - Run a workflow
  server.post<{
    Params: { id: string };
    Body: WorkflowRunRequest;
  }>('/api/v1/workflows/:id/run', async (request, reply) => {
    try {
      const { id } = request.params;
      const response = await hostService.runWorkflow(id, request.body || {});
      return ok(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to run workflow';
      if (message === 'Workflow not found') {
        return fail(reply, 404, message);
      }
      logger.error('[workflows-api] Error running workflow', error instanceof Error ? error : undefined);
      return fail(reply, 500, message);
    }
  });

  logger.info('[workflows-api] Workflows API endpoints registered');
}
