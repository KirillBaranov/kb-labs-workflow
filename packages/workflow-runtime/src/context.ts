import pino from 'pino'
import type {
  ArtifactClient,
  RuntimeEvents,
  RuntimeLogger,
  RuntimeTrace,
  StepContext,
} from './types'

export interface CreateStepContextInput {
  runId: string
  jobId: string
  stepId: string
  attempt?: number
  env?: Record<string, string>
  secrets?: Record<string, string>
  artifacts?: ArtifactClient
  events?: RuntimeEvents
  logger?: RuntimeLogger
  trace?: RuntimeTrace
}

function normalizeLogger(logger?: RuntimeLogger): RuntimeLogger {
  if (logger) {
    return logger
  }

  const instance = pino({
    name: 'workflow-step',
    level: process.env.LOG_LEVEL ?? 'info',
  })

  return {
    debug(message, meta) {
      instance.debug(meta ?? {}, message)
    },
    info(message, meta) {
      instance.info(meta ?? {}, message)
    },
    warn(message, meta) {
      instance.warn(meta ?? {}, message)
    },
    error(message, meta) {
      instance.error(meta ?? {}, message)
    },
  }
}

export function createStepContext(
  input: CreateStepContextInput,
): StepContext {
  return {
    runId: input.runId,
    jobId: input.jobId,
    stepId: input.stepId,
    attempt: input.attempt ?? 0,
    env: { ...process.env, ...(input.env ?? {}) } as Record<string, string>,
    secrets: input.secrets ?? {},
    artifacts: input.artifacts,
    events: input.events,
    logger: normalizeLogger(input.logger),
    trace: input.trace,
  }
}





