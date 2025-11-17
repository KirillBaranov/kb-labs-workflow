import type {
  WorkflowSpec,
  WorkflowRun,
  JobRun,
  StepRun,
  RunTrigger,
  IdempotencyKey,
  ConcurrencyGroup,
} from '@kb-labs/workflow-contracts'
import type { RedisClientFactoryResult } from './redis'

export interface EngineLogger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface WorkflowLoaderResult {
  spec: WorkflowSpec
  source: string
}

export interface RunContext {
  run: WorkflowRun
  jobs: JobRun[]
  steps: StepRun[]
}

export interface CreateRunInput {
  spec: WorkflowSpec
  trigger: RunTrigger
  idempotencyKey?: IdempotencyKey
  concurrencyGroup?: ConcurrencyGroup
  metadata?: Record<string, unknown>
  env?: Record<string, string>
}

export interface RunCoordinatorDeps {
  redis: RedisClientFactoryResult
  logger: EngineLogger
}

export interface ConcurrencyManagerDeps {
  redis: RedisClientFactoryResult
  logger: EngineLogger
}

export interface SchedulerDeps {
  redis: RedisClientFactoryResult
  logger: EngineLogger
}

export interface EventBusBridgeDeps {
  redis: RedisClientFactoryResult
  logger: EngineLogger
}



