import type { z } from 'zod'
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  WorkflowSpecSchema,
  JobSpecSchema,
  StepSpecSchema,
  RunSchema,
  JobRunSchema,
  StepRunSchema,
  RetryPolicySchema,
  RunTriggerSchema,
  RunMetadataSchema,
  IdempotencyKeySchema,
  ConcurrencyGroupSchema,
  ExecutionResultSchema,
  ResultMetricsSchema,
  ResultErrorSchema,
  JobHooksSchema,
  ArtifactMergeStrategySchema,
  ArtifactMergeSourceSchema,
  ArtifactMergeConfigSchema,
} from './schemas'

export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>
export type JobSpec = z.infer<typeof JobSpecSchema>
export type StepSpec = z.infer<typeof StepSpecSchema>
export type JobHooks = z.infer<typeof JobHooksSchema>
export type ArtifactMergeStrategy = z.infer<typeof ArtifactMergeStrategySchema>
export type ArtifactMergeSource = z.infer<typeof ArtifactMergeSourceSchema>
export type ArtifactMergeConfig = z.infer<typeof ArtifactMergeConfigSchema>

export type RetryPolicy = z.infer<typeof RetryPolicySchema>
export type WorkflowRun = z.infer<typeof RunSchema>
export type JobRun = z.infer<typeof JobRunSchema>
export type StepRun = z.infer<typeof StepRunSchema>
export type RunTrigger = z.infer<typeof RunTriggerSchema>
export type RunMetadata = z.infer<typeof RunMetadataSchema>
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>
export type ConcurrencyGroup = z.infer<typeof ConcurrencyGroupSchema>
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>
export type ResultMetrics = z.infer<typeof ResultMetricsSchema>
export type ResultError = z.infer<typeof ResultErrorSchema>

export interface WorkflowValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export interface WorkflowInvocationSpec {
  type: 'workflow'
  workflowId: string
  mode?: 'wait' | 'fire-and-forget'
  inheritEnv?: boolean
  inputs?: Record<string, unknown>
}

export interface ExpressionContext {
  env: Record<string, string>
  trigger: {
    type: string
    actor?: string
    payload?: Record<string, unknown>
  }
  steps: Record<string, {
    outputs: Record<string, unknown>
  }>
  matrix?: Record<string, unknown>
}


