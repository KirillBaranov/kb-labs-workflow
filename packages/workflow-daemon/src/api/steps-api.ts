/**
 * @module @kb-labs/workflow-daemon/api/steps-api
 * REST API endpoint for job steps and progress
 */

import type { FastifyInstance } from 'fastify';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobStepsResponse, JobStepInfo } from '@kb-labs/workflow-contracts';

export interface RegisterStepsAPIOptions {
  server: FastifyInstance;
  engine: WorkflowEngine;
  logger: ILogger;
}

/**
 * Register job steps/progress endpoints.
 *
 * Endpoints:
 * - GET /api/v1/jobs/:jobId/steps - Get job execution steps and progress
 */
export function registerStepsAPI(options: RegisterStepsAPIOptions): void {
  const { server, engine, logger } = options;

  // GET /api/v1/jobs/:jobId/steps - Get job steps
  server.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId/steps', async (request, reply) => {
    try {
      const { jobId } = request.params;

      logger.info(`[steps-api] Fetching steps for job ${jobId}`);

      // Get workflow run from engine
      const run = await engine.getRun(jobId);

      if (!run) {
        reply.code(404);
        return { ok: false, error: 'Job not found' };
      }

      const steps: JobStepInfo[] =
        run.steps?.map((step) => ({
          name: step.name,
          handler: step.handler,
          status: step.status,
          progress: step.progress,
          startedAt: step.startedAt?.toISOString(),
          finishedAt: step.finishedAt?.toISOString(),
          durationMs: step.durationMs,
          error: step.error,
          output: step.output,
        })) || [];

      const response: JobStepsResponse = {
        jobId,
        workflowName: run.workflowName,
        status: run.status,
        steps,
        currentStep: run.currentStepIndex,
      };

      return { ok: true, data: response };
    } catch (error) {
      logger.error('[steps-api] Error fetching job steps', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch job steps',
      };
    }
  });

  logger.info('[steps-api] Job steps API endpoint registered');
}
