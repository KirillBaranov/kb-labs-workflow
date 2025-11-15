import { z } from 'zod'
import {
  RUN_STATES,
  JOB_STATES,
  STEP_STATES,
  type RunState,
  type JobState,
  type StepState,
} from '@kb-labs/workflow-constants'

type NonEmptyTuple<T> = [T, ...T[]]

const RUN_STATE_VALUES = RUN_STATES as unknown as NonEmptyTuple<RunState>
const JOB_STATE_VALUES = JOB_STATES as unknown as NonEmptyTuple<JobState>
const STEP_STATE_VALUES = STEP_STATES as unknown as NonEmptyTuple<StepState>

export const RunStateSchema = z.enum(RUN_STATE_VALUES)
export const JobStateSchema = z.enum(JOB_STATE_VALUES)
export const StepStateSchema = z.enum(STEP_STATE_VALUES)

export const IdempotencyKeySchema = z.string().min(1).max(256)
export const ConcurrencyGroupSchema = z.string().min(1).max(256)

export const RetryModeSchema = z.enum(['exp', 'lin'])

export const RetryPolicySchema = z.object({
  max: z.number().int().nonnegative(),
  backoff: RetryModeSchema.default('exp'),
  initialIntervalMs: z.number().int().positive().default(1000),
  maxIntervalMs: z.number().int().positive().optional(),
})

export const TimeoutSchema = z.number().int().positive().max(1000 * 60 * 60 * 24) // <= 24h

export const StepSpecSchema = z.object({
  name: z.string().min(1),
  uses: z
    .union([
      z.literal('builtin:shell'),
      z.string().regex(/^[a-zA-Z0-9@/_:+#.-]+$/),
    ])
    .optional(),
  with: z.record(z.string(), z.unknown()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  timeoutMs: TimeoutSchema.optional(),
  continueOnError: z.boolean().optional(),
})

export const JobConcurrencySchema = z.object({
  group: ConcurrencyGroupSchema,
  cancelInProgress: z.boolean().optional(),
})

export const JobArtifactsSchema = z
  .object({
    produce: z.array(z.string().min(1)).optional(),
    consume: z.array(z.string().min(1)).optional(),
  })
  .optional()

export const JobSpecSchema = z.object({
  runsOn: z.enum(['local', 'sandbox']),
  concurrency: JobConcurrencySchema.optional(),
  steps: z.array(StepSpecSchema).min(1),
  artifacts: JobArtifactsSchema,
  timeoutMs: TimeoutSchema.optional(),
  retries: RetryPolicySchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  needs: z.array(z.string().min(1)).optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
})

export const WorkflowTriggerSchema = z
  .object({
    manual: z.boolean().optional(),
    push: z.boolean().optional(),
    webhook: z
      .union([
        z.boolean(),
        z.object({
          secret: z.string().min(1).optional(),
          path: z.string().min(1).optional(),
          headers: z.record(z.string(), z.string()).optional(),
        }),
      ])
      .optional(),
    schedule: z
      .object({
        cron: z.string().min(1),
        timezone: z.string().min(1).optional(),
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.manual || value.push || !!value.webhook || !!value.schedule,
    {
      message: 'At least one trigger must be defined',
      path: ['manual'],
    },
  )

export const WorkflowSpecSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    on: WorkflowTriggerSchema,
    env: z.record(z.string(), z.string()).optional(),
    secrets: z.array(z.string().min(1)).optional(),
    jobs: z.record(z.string().min(1), JobSpecSchema),
  })
  .refine(
    (value) =>
      Object.keys(value.jobs).length > 0 &&
      Object.keys(value.jobs).every((key) => key.trim().length > 0),
    {
      message: 'At least one job must be defined with a non-empty id',
      path: ['jobs'],
    },
  )

export const StepRunErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const StepRunSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  jobId: z.string().min(1),
  name: z.string().min(1),
  index: z.number().int().nonnegative(),
  status: StepStateSchema,
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().default(0),
  timeoutMs: TimeoutSchema.optional(),
  continueOnError: z.boolean().optional(),
  error: StepRunErrorSchema.optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  spec: StepSpecSchema,
})

export const JobRunSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  jobName: z.string().min(1),
  status: JobStateSchema,
  runsOn: z.enum(['local', 'sandbox']),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().default(0),
  concurrency: JobConcurrencySchema.optional(),
  retries: RetryPolicySchema.optional(),
  timeoutMs: TimeoutSchema.optional(),
  artifacts: JobArtifactsSchema,
  error: StepRunErrorSchema.optional(),
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  needs: z.array(z.string().min(1)).optional(),
  pendingDependencies: z.array(z.string().min(1)).optional(),
  blocked: z.boolean().optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  steps: z.array(StepRunSchema),
})

export const RunTriggerSchema = z.object({
  type: z.enum(['manual', 'webhook', 'push', 'schedule']),
  actor: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})

export const RunMetadataSchema = z.object({
  idempotencyKey: IdempotencyKeySchema.optional(),
  concurrencyGroup: ConcurrencyGroupSchema.optional(),
})

export const ResultErrorSchema = z.object({
  message: z.string().min(1),
  code: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const ResultMetricsSchema = z.object({
  timeMs: z.number().int().nonnegative().optional(),
  cpuMs: z.number().int().nonnegative().optional(),
  memMb: z.number().nonnegative().optional(),
  jobsTotal: z.number().int().nonnegative().optional(),
  jobsSucceeded: z.number().int().nonnegative().optional(),
  jobsFailed: z.number().int().nonnegative().optional(),
  jobsCancelled: z.number().int().nonnegative().optional(),
  stepsTotal: z.number().int().nonnegative().optional(),
  stepsFailed: z.number().int().nonnegative().optional(),
  stepsCancelled: z.number().int().nonnegative().optional(),
})

export const ExecutionResultSchema = z.object({
  status: RunStateSchema,
  summary: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  metrics: ResultMetricsSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: ResultErrorSchema.optional(),
})

export const RunSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  status: RunStateSchema,
  createdAt: z.string().datetime(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  trigger: RunTriggerSchema,
  env: z.record(z.string(), z.string()).optional(),
  secrets: z.array(z.string().min(1)).optional(),
  jobs: z.array(JobRunSchema),
  artifacts: z.array(z.string()).optional(),
  metadata: RunMetadataSchema.optional(),
  result: ExecutionResultSchema.optional(),
})



