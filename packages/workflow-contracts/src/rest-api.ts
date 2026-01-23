/**
 * @module @kb-labs/workflow-contracts/rest-api
 * REST API types for Workflow Service HTTP endpoints
 */

import { z } from 'zod'

/**
 * Job submission request (POST /api/jobs)
 */
export interface JobSubmissionRequest {
  /** Job type (pluginId:jobId format) */
  type: string;
  /** Job payload (passed to handler) */
  payload?: unknown;
  /** Priority (1-10, default 5) */
  priority?: number;
  /** Max retry attempts (default 3) */
  maxRetries?: number;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Scheduled run time (ISO string or Date) */
  runAt?: string | Date;
  /** Idempotency key (prevents duplicate submissions) */
  idempotencyKey?: string;
}

/**
 * Job submission response (POST /api/jobs)
 */
export interface JobSubmissionResponse {
  /** Generated job ID */
  jobId: string;
}

/**
 * Job status info (GET /api/jobs/:id)
 */
export interface JobStatusInfo {
  /** Job ID */
  id: string;
  /** Job type */
  type: string;
  /** Current status */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Tenant ID */
  tenantId?: string;
  /** Priority */
  priority?: number;
  /** Created timestamp */
  createdAt?: Date | string;
  /** Started timestamp */
  startedAt?: Date | string;
  /** Finished timestamp */
  finishedAt?: Date | string;
  /** Retry attempt number */
  attempt?: number;
  /** Max retries */
  maxRetries?: number;
  /** Result (if completed) */
  result?: unknown;
  /** Error (if failed) */
  error?: string;
  /** Progress (0-100) */
  progress?: number;
  /** Progress message */
  progressMessage?: string;
}

/**
 * Job list filter (GET /api/jobs)
 */
export interface JobListFilter {
  /** Filter by job type pattern */
  type?: string;
  /** Filter by status */
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Pagination limit */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/**
 * Job list response (GET /api/jobs)
 */
export interface JobListResponse {
  /** List of jobs */
  jobs: JobStatusInfo[];
}

/**
 * Job cancel response (POST /api/jobs/:id/cancel)
 */
export interface JobCancelResponse {
  /** True if job was cancelled */
  cancelled: boolean;
}

/**
 * Cron job registration request (POST /api/cron)
 */
export interface CronRegistrationRequest {
  /** Cron job ID (unique per plugin) */
  id: string;
  /** Cron schedule expression */
  schedule: string;
  /** Job type to execute (pluginId:jobId) */
  jobType: string;
  /** Job payload */
  payload?: unknown;
  /** Timezone (default: UTC) */
  timezone?: string;
  /** Enabled flag (default: true) */
  enabled?: boolean;
}

/**
 * Cron job info (GET /api/cron)
 */
export interface CronInfo {
  /** Cron job ID */
  id: string;
  /** Cron schedule expression */
  schedule: string;
  /** Job type */
  jobType: string;
  /** Timezone */
  timezone?: string;
  /** Enabled flag */
  enabled: boolean;
  /** Last run time */
  lastRun?: Date | string;
  /** Next run time */
  nextRun?: Date | string;
  /** Plugin ID (if plugin-provided) */
  pluginId?: string;
}

/**
 * Cron list response (GET /api/cron)
 */
export interface CronListResponse {
  /** List of cron jobs */
  crons: CronInfo[];
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Job status enum schema
 */
export const JobStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])

/**
 * Job status info schema (GET /api/v1/jobs/:jobId)
 */
export const JobStatusInfoSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: JobStatusSchema,
  tenantId: z.string().optional(),
  priority: z.number().optional(),
  createdAt: z.union([z.string(), z.date()]).optional(),
  startedAt: z.union([z.string(), z.date()]).optional(),
  finishedAt: z.union([z.string(), z.date()]).optional(),
  attempt: z.number().optional(),
  maxRetries: z.number().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  progress: z.number().min(0).max(100).optional(),
  progressMessage: z.string().optional(),
})

/**
 * Job list response schema (GET /api/v1/jobs)
 */
export const JobListResponseSchema = z.object({
  jobs: z.array(JobStatusInfoSchema),
})

/**
 * Job cancel response schema (POST /api/v1/jobs/:jobId/cancel)
 */
export const JobCancelResponseSchema = z.object({
  cancelled: z.boolean(),
})

/**
 * Cron info schema (GET /api/v1/cron)
 */
export const CronInfoSchema = z.object({
  id: z.string(),
  schedule: z.string(),
  jobType: z.string(),
  timezone: z.string().optional(),
  enabled: z.boolean(),
  lastRun: z.union([z.string(), z.date()]).optional(),
  nextRun: z.union([z.string(), z.date()]).optional(),
  pluginId: z.string().optional(),
})

/**
 * Cron list response schema (GET /api/v1/cron)
 */
export const CronListResponseSchema = z.object({
  crons: z.array(CronInfoSchema),
})
