/**
 * @module @kb-labs/workflow-daemon/api/workflows-api
 * REST API endpoints for managing workflow definitions
 */

import type { FastifyInstance } from 'fastify';
import type { WorkflowService, WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { WorkflowListResponse, WorkflowInfo, WorkflowRunRequest } from '@kb-labs/workflow-contracts';

export interface RegisterWorkflowsAPIOptions {
  server: FastifyInstance;
  workflowService: WorkflowService;
  engine: WorkflowEngine;
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
  const { server, workflowService, engine, logger } = options;

  // GET /api/v1/workflows - List all workflow definitions
  server.get<{
    Querystring: {
      source?: 'manifest' | 'standalone';
      status?: 'active' | 'inactive';
      tags?: string;
    };
  }>('/api/v1/workflows', async (request, reply) => {
    try {
      const { source, status, tags } = request.query;

      // Map REST API status ('active'|'inactive') to internal status
      const internalStatus: 'active' | 'paused' | 'disabled' | undefined = status === 'inactive' ? 'disabled' : status;

      const workflows = await workflowService.listAll({
        source,
        status: internalStatus,
        tags: tags ? tags.split(',') : undefined,
      });

      const workflowInfos: WorkflowInfo[] = workflows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        source: w.source,
        pluginId: w.pluginId,
        // Map internal status to REST API status
        status: w.status === 'active' ? 'active' : 'inactive',
        tags: w.tags,
      }));

      const response: WorkflowListResponse = {
        workflows: workflowInfos,
      };

      return { ok: true, data: response };
    } catch (error) {
      logger.error('[workflows-api] Error listing workflows', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to list workflows',
      };
    }
  });

  // GET /api/v1/workflows/:id - Get workflow definition details
  server.get<{
    Params: { id: string };
  }>('/api/v1/workflows/:id', async (request, reply) => {
    try {
      const { id } = request.params;

      const workflow = await workflowService.get(id);

      if (!workflow) {
        reply.code(404);
        return {
          ok: false,
          error: 'Workflow not found',
        };
      }

      const workflowInfo: WorkflowInfo = {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        source: workflow.source,
        pluginId: workflow.pluginId,
        // Map internal status to REST API status
        status: workflow.status === 'active' ? 'active' : 'inactive',
        tags: workflow.tags,
      };

      return { ok: true, data: workflowInfo };
    } catch (error) {
      logger.error('[workflows-api] Error getting workflow', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to get workflow',
      };
    }
  });

  // POST /api/v1/workflows/:id/run - Run a workflow
  server.post<{
    Params: { id: string };
    Body: WorkflowRunRequest;
  }>('/api/v1/workflows/:id/run', async (request, reply) => {
    try {
      const { id } = request.params;
      const { input, trigger } = request.body || {};

      // Get workflow runtime (includes spec in input field)
      const workflow = await workflowService.get(id);

      if (!workflow) {
        reply.code(404);
        return {
          ok: false,
          error: 'Workflow not found',
        };
      }

      // WorkflowRuntime.input contains the full WorkflowSpec
      const spec = workflow.input as any;

      // Map trigger type to RunTriggerSchema values
      const triggerType = trigger?.type === 'cron' ? 'schedule' : trigger?.type === 'api' ? 'webhook' : 'manual';

      // Execute workflow using runFromSpec (correct WorkflowEngine API)
      const run = await engine.runFromSpec(spec, {
        trigger: {
          type: triggerType,
          actor: trigger?.user,
        },
        env: input && typeof input === 'object' ? (input as Record<string, string>) : undefined,
      });

      return {
        ok: true,
        data: {
          runId: run.id,
          status: run.status,
        },
      };
    } catch (error) {
      logger.error('[workflows-api] Error running workflow', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to run workflow',
      };
    }
  });

  logger.info('[workflows-api] Workflows API endpoints registered');
}
