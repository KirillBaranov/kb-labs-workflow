/**
 * @module @kb-labs/workflow-contracts/routes
 * REST API route constants for workflow plugin
 */

/**
 * Base path for all workflow REST endpoints
 */
export const WORKFLOW_BASE_PATH = '/plugins/workflow'

/**
 * Workflow REST API routes
 */
export const WORKFLOW_ROUTES = {
  /** GET /stats - Dashboard statistics */
  STATS: '/stats',
  /** GET /workflows - List all workflow definitions */
  WORKFLOWS: '/workflows',
  /** GET /workflows/:id - Get workflow definition details */
  WORKFLOW_DETAIL: '/workflows/:id',
  /** POST /workflows/:id/run - Run a workflow */
  WORKFLOW_RUN: '/workflows/:id/run',
  /** GET /workflows/:id/runs - Get workflow run history */
  WORKFLOW_RUNS: '/workflows/:id/runs',
  /** GET /jobs - List all jobs */
  JOBS: '/jobs',
  /** GET /jobs/:jobId - Get job details */
  JOB_DETAIL: '/jobs/:jobId',
  /** GET /jobs/:jobId/logs - Get job logs */
  JOB_LOGS: '/jobs/:jobId/logs',
  /** GET /jobs/:jobId/steps - Get job execution steps */
  JOB_STEPS: '/jobs/:jobId/steps',
  /** POST /jobs/:jobId/cancel - Cancel a job */
  JOB_CANCEL: '/jobs/:jobId/cancel',
  /** GET /cron - List cron jobs */
  CRON: '/cron',
} as const
