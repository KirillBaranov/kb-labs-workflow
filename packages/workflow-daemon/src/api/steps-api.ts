/**
 * @module @kb-labs/workflow-daemon/api/steps-api
 * REST API endpoint for job steps and progress
 */

import type { FastifyInstance } from 'fastify';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobStepsResponse, JobStepInfo } from '@kb-labs/workflow-contracts';
import type { StepState, RunState } from '@kb-labs/workflow-constants';

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

      // Flatten all steps from all jobs into a single array
      // WorkflowRun structure: run.jobs[].steps[]
      const steps: JobStepInfo[] = [];
      let currentStepIndex: number | undefined;
      let stepCounter = 0;

      for (const job of run.jobs || []) {
        for (const step of job.steps || []) {
          // Track current running step
          if (step.status === 'running' && currentStepIndex === undefined) {
            currentStepIndex = stepCounter;
          }

          steps.push({
            name: step.name,
            handler: step.spec?.uses,
            status: mapStepStatus(step.status),
            startedAt: step.startedAt,
            finishedAt: step.finishedAt,
            durationMs: step.durationMs,
            error: step.error?.message,
            output: step.outputs,
          });

          stepCounter++;
        }
      }

      const response: JobStepsResponse = {
        jobId,
        workflowName: run.name,
        status: mapRunStatus(run.status),
        steps,
        currentStep: currentStepIndex,
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

/**
 * Map StepState (workflow-constants) to JobStepInfo status
 */
function mapStepStatus(status: StepState): JobStepInfo['status'] {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'running':
      return 'running';
    case 'success':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

/**
 * Map RunState (workflow-constants) to JobStepsResponse status
 */
function mapRunStatus(status: RunState): JobStepsResponse['status'] {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'running':
      return 'running';
    case 'success':
      return 'completed';
    case 'failed':
    case 'dlq': // Dead Letter Queue - treat as failed
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}
