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
  /** GET /workflows/jobs - List all jobs */
  JOBS: '/jobs',
  /** GET /workflows/jobs/:jobId - Get job details */
  JOB_DETAIL: '/jobs/:jobId',
  /** POST /workflows/jobs/:jobId/cancel - Cancel a job */
  JOB_CANCEL: '/jobs/:jobId/cancel',
  /** GET /workflows/cron - List cron jobs */
  CRON: '/cron',
} as const
