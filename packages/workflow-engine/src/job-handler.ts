import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  LocalRunner,
  SandboxRunner,
  type StepExecutionResult,
  type StepExecutionRequest,
  type RuntimeLogger,
  type PluginCommandResolution,
} from '@kb-labs/workflow-runtime'
import { createFileSystemArtifactClient, type ArtifactClient } from '@kb-labs/workflow-artifacts'
import type { StepRun, StepSpec, JobRun, WorkflowRun } from '@kb-labs/workflow-contracts'
import { EVENT_NAMES, type StepState } from '@kb-labs/workflow-constants'
import type { EngineLogger } from './types'
import type { PluginCommandResolver } from './plugin-command-resolver'
import type { EventBusBridge } from './event-bus'
import type { JobHandler, JobHandlerResult, JobExecutionContext } from './job-runner'
import {
  createDefaultSecretProvider,
  type SecretProvider,
} from './secrets'
import {
  combineSignals,
  createTimeoutSignal,
  getAbortReason,
  signalReason,
} from './abort-utils'
import {
  createPluginContext,
  createNoopAnalyticsEmitter,
  createNoopEventBridge,
  JobRunnerPresenter,
  type JobRunnerPresenterEvent,
  type PluginContext,
  type PluginEventEnvelope,
  OperationTracker,
} from '@kb-labs/plugin-runtime'
import type { RedisEventBridge } from './events/redis-event-bridge'

export interface WorkflowJobHandlerOptions {
  artifactsRoot?: string
  defaultWorkspace?: string
  secretProvider?: SecretProvider
  eventsBridge?: RedisEventBridge
}

interface StepLogPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

interface StepOutcome {
  status: Extract<StepState, 'success' | 'failed' | 'cancelled'>
  result: StepExecutionResult
}

const DEFAULT_ARTIFACTS_ROOT = path.resolve(process.cwd(), '.kb/workflows/artifacts')
const DEFAULT_WORKSPACE = process.cwd()
const PRESENTER_EVENT_VERSION = '1.0.0'

export class WorkflowJobHandler implements JobHandler {
  private readonly logger: EngineLogger
  private readonly events: EventBusBridge
  private readonly resolver: PluginCommandResolver
  private readonly options: WorkflowJobHandlerOptions
  private readonly localRunner: LocalRunner
  private readonly sandboxRunner: SandboxRunner
  private readonly secretProvider: SecretProvider
  private readonly redisEvents?: RedisEventBridge

  constructor(
    deps: {
      logger: EngineLogger
      events: EventBusBridge
      resolver: PluginCommandResolver
      options?: WorkflowJobHandlerOptions
    },
  ) {
    this.logger = deps.logger
    this.events = deps.events
    this.resolver = deps.resolver
    this.options = deps.options ?? {}
    this.localRunner = new LocalRunner()
    this.sandboxRunner = new SandboxRunner({
      resolveCommand: async (commandRef, request) => {
        const resolution = await this.resolver.resolve(commandRef)
        if (isPluginStep(request.spec)) {
          const pluginContext = this.createPluginExecutionContext(request, resolution)
          resolution.contextOverrides = {
            ...(resolution.contextOverrides ?? {}),
            pluginContext,
          }
        }
        return resolution
      },
    })
    this.secretProvider =
      this.options.secretProvider ?? createDefaultSecretProvider()
    this.redisEvents = this.options.eventsBridge
  }

  async execute(context: JobExecutionContext): Promise<JobHandlerResult> {
    const artifacts = this.createArtifactClient(context)
    const errors: Array<{ stepId: string; error: JobHandlerResult['error'] }> = []

    let currentJob: JobRun = context.job
    let currentRun: WorkflowRun = context.run

    await this.ensureConsumedArtifacts(context, artifacts)

    const orderedSteps = [...currentJob.steps].sort((a, b) => a.index - b.index)

    for (const step of orderedSteps) {
      if (context.signal.aborted) {
        return this.handleAbort(context, step)
      }

      await context.heartbeat()

      const updateToRunning = await context.state.updateStep(
        step.id,
        (draft) => {
          const now = new Date().toISOString()
          draft.status = 'running'
          draft.startedAt = draft.startedAt ?? now
          draft.durationMs = undefined
          draft.error = undefined
          draft.outputs = undefined
          draft.attempt = (draft.attempt ?? 0) + 1
          return draft
        },
      )

      if (!updateToRunning) {
        this.logger.warn('Failed to transition step to running state', {
          runId: currentRun.id,
          jobId: currentJob.id,
          stepId: step.id,
        })
        continue
      }

      this.emitLog(context, step.id, {
        level: 'info',
        message: `Step "${step.name}" started`,
        meta: { attempt: updateToRunning.attempt },
      })

      const outcome = await this.executeStep(context, {
        run: currentRun,
        job: currentJob,
        step: updateToRunning,
        artifacts,
      })

      await context.heartbeat()

      const finishedAt = new Date().toISOString()

      await context.state.updateStep(step.id, (draft) => {
        draft.status = outcome.status
        draft.finishedAt = finishedAt
        draft.durationMs = computeDurationMs(draft.startedAt ?? draft.queuedAt, finishedAt)
        if (outcome.result.status === 'success') {
          draft.outputs = outcome.result.outputs
          draft.error = undefined
        } else {
          draft.outputs = undefined
          if (outcome.result.error) {
            draft.error = outcome.result.error
          }
        }
        return draft
      })

      const refreshed = await context.state.reload()
      if (refreshed) {
        currentRun = refreshed.run
        currentJob = refreshed.job
      }

      if (outcome.status === 'failed') {
        const stepError =
          outcome.result.status === 'success'
            ? undefined
            : outcome.result.error
        errors.push({
          stepId: step.id,
          error: stepError ?? {
            message: `Step ${step.name} failed`,
            code: 'STEP_FAILED',
            details: { stepId: step.id },
          },
        })

        this.emitLog(context, step.id, {
          level: 'error',
          message: `Step "${step.name}" failed`,
          meta: stepError ?? { reason: 'unknown' },
        })

        if (updateToRunning.continueOnError) {
          this.logger.warn('Continuing workflow despite step failure (continueOnError=true)', {
            runId: currentRun.id,
            jobId: currentJob.id,
            stepId: step.id,
          })
          continue
        }

        return {
          status: 'failed',
          error: errors[errors.length - 1]?.error,
        }
      }

      if (outcome.status === 'cancelled') {
        this.emitLog(context, step.id, {
          level: 'warn',
          message: `Step "${step.name}" cancelled`,
        })
        const cancellationError =
          outcome.result.status === 'success'
            ? undefined
            : outcome.result.error
        return {
          status: 'cancelled',
          error: cancellationError ?? {
            message: `Step ${step.name} cancelled`,
          },
        }
      }

      this.emitLog(context, step.id, {
        level: 'info',
        message: `Step "${step.name}" completed`,
      })
    }

    if (errors.length > 0) {
      return {
        status: 'failed',
        error: errors[errors.length - 1]?.error,
      }
    }

    await this.captureProducedArtifacts(context, artifacts)

    return {
      status: 'success',
    }
  }

  private async executeStep(
    context: JobExecutionContext,
    runtime: {
      run: WorkflowRun
      job: JobRun
      step: StepRun
      artifacts: ArtifactClient
    },
  ): Promise<StepOutcome> {
    const spec = this.findStepSpec(runtime.job, runtime.step)
    if (!spec) {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message: `Step specification not found for ${runtime.step.name}`,
            code: 'STEP_SPEC_NOT_FOUND',
          },
        },
      }
    }

    const secrets = await this.resolveSecrets(runtime.run, runtime.job, spec)

    const timeoutHandle =
      typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0
        ? createTimeoutSignal(
            spec.timeoutMs,
            () => new StepTimeoutError(runtime.step.id, spec.timeoutMs ?? 0),
          )
        : null

    const composite = combineSignals(
      timeoutHandle ? [context.signal, timeoutHandle.signal] : [context.signal],
    )
    const stepSignal = composite.signal

    try {
      const executionRequest = {
        spec,
        context: {
          runId: runtime.run.id,
          jobId: runtime.job.id,
          stepId: runtime.step.id,
          attempt: runtime.step.attempt,
          env: mergeEnv(runtime.run.env, runtime.job.env, spec.env),
          secrets,
          artifacts: runtime.artifacts,
        logger: this.createStepLogger(context, runtime),
        },
        workspace: resolveWorkspace(spec, this.options.defaultWorkspace ?? DEFAULT_WORKSPACE),
        signal: stepSignal,
      }

      let result: StepExecutionResult
      try {
        if (isPluginStep(spec)) {
          result = await this.sandboxRunner.execute(executionRequest)
        } else {
          result = await this.localRunner.execute(executionRequest)
        }
      } catch (error) {
        if (stepSignal.aborted) {
          const reason = getAbortReason(stepSignal)
          if (reason instanceof StepTimeoutError) {
            return buildStepTimeoutOutcome(reason)
          }
          return {
            status: 'cancelled',
            result: {
              status: 'cancelled',
              error: {
                message:
                  signalReason(stepSignal) ?? 'Step cancelled during execution',
                code: 'STEP_CANCELLED',
              },
            },
          }
        }

        const message = error instanceof Error ? error.message : 'Step execution failed'
        return {
          status: 'failed',
          result: {
            status: 'failed',
            error: {
              message,
              code: 'STEP_EXECUTION_CRASHED',
            },
          },
        }
      }

      const abortReason = getAbortReason(stepSignal)
      if (abortReason instanceof StepTimeoutError) {
        return buildStepTimeoutOutcome(abortReason)
      }

      return {
        status: result.status,
        result,
      }
    } finally {
      timeoutHandle?.cancel()
      composite.dispose()
    }
  }

  private findStepSpec(job: JobRun, stepRun: StepRun): StepSpec | null {
    const candidate = job.steps.find((step) => step.id === stepRun.id)
    return candidate?.spec ?? null
  }

  private handleAbort(
    context: JobExecutionContext,
    step: StepRun,
  ): JobHandlerResult {
    this.emitLog(context, step.id, {
      level: 'warn',
      message: `Job aborted before executing step "${step.name}"`,
      meta: { reason: context.signal.reason },
    })
    return {
      status: 'cancelled',
      error: {
        message: 'Job aborted by worker',
        code: 'JOB_ABORTED',
      },
      retryable: true,
    }
  }

  private createArtifactClient(context: JobExecutionContext): ArtifactClient {
    const root =
      this.options.artifactsRoot ?? DEFAULT_ARTIFACTS_ROOT
    const jobRoot = path.join(root, context.run.id, context.job.jobName)
    return createFileSystemArtifactClient(jobRoot)
  }

  private async ensureConsumedArtifacts(
    context: JobExecutionContext,
    artifacts: ArtifactClient,
  ): Promise<void> {
    const consumeList = context.job.artifacts?.consume ?? []
    if (consumeList.length === 0) {
      return
    }

    for (const artifactPath of consumeList) {
      if (!artifactPath) {
        continue
      }
      try {
        if (typeof artifacts.list === 'function') {
          const references = await artifacts.list()
          const found = references?.some((ref) => ref.path === artifactPath)
          if (found) {
            continue
          }
        }
        await artifacts.consume(artifactPath)
      } catch (error) {
        this.logger.warn('Consumed artifact not available', {
          runId: context.run.id,
          jobId: context.job.id,
          artifact: artifactPath,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async captureProducedArtifacts(
    context: JobExecutionContext,
    artifacts: ArtifactClient,
  ): Promise<void> {
    const produceList = context.job.artifacts?.produce ?? []
    if (produceList.length === 0) {
      return
    }

    let producedPaths: string[] = []
    if (typeof artifacts.list === 'function') {
      try {
        const references = await artifacts.list()
        const wanted = new Set(produceList)
        producedPaths = references
          ?.filter((ref) => ref.path && wanted.has(ref.path))
          .map((ref) => ref.path)
          ?? []
      } catch (error) {
        this.logger.warn('Failed to list produced artifacts', {
          runId: context.run.id,
          jobId: context.job.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const finalPaths = producedPaths.length > 0 ? producedPaths : produceList

    if (finalPaths.length === 0) {
      return
    }

    await context.state.updateRun((draft) => {
      const existing = new Set(draft.artifacts ?? [])
      for (const relativePath of finalPaths) {
        const normalized = path.join(context.job.jobName, relativePath)
        existing.add(normalized)
      }
      draft.artifacts = Array.from(existing)
      return draft
    })
  }

  private createStepLogger(
    context: JobExecutionContext,
    runtime: { run: WorkflowRun; job: JobRun; step: StepRun },
  ) {
    return {
      debug: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'debug', message, meta })
      },
      info: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'info', message, meta })
      },
      warn: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'warn', message, meta })
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'error', message, meta })
      },
    }
  }

  private emitLog(
    context: JobExecutionContext,
    stepId: string,
    payload: StepLogPayload,
  ) {
    this.events
      .publish({
        type: EVENT_NAMES.log.appended,
        runId: context.run.id,
        jobId: context.job.id,
        stepId,
        payload: {
          ...payload,
          timestamp: new Date().toISOString(),
        },
      })
      .catch((error) => {
        this.logger.warn('Failed to publish workflow log event', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private createPluginExecutionContext(
    request: StepExecutionRequest,
    resolution: PluginCommandResolution,
  ) {
    const presenter = new JobRunnerPresenter({
      runId: request.context.runId,
      stepId: request.context.stepId,
      buffer: false,
      onEvent: (event) => this.forwardPresenterEvent(request, event),
    })

    const analyticsEmitter = createNoopAnalyticsEmitter();
    const operationTracker = new OperationTracker();

    const pluginContext = createPluginContext('workflow', {
      requestId: `${request.context.runId}:${request.context.jobId}:${request.context.stepId}`,
      pluginId: resolution.manifest.id,
      pluginVersion: resolution.manifest.version,
      presenter,
      analytics: analyticsEmitter,
      events: createNoopEventBridge(),
      capabilities: [],
      metadata: {
        runId: request.context.runId,
        jobId: request.context.jobId,
        stepId: request.context.stepId,
        attempt: request.context.attempt,
      },
      getTrackedOperations: () => operationTracker.toArray(),
    })

    return pluginContext;
  }

  private forwardPresenterEvent(
    request: StepExecutionRequest,
    event: JobRunnerPresenterEvent,
  ): void {
    const logger = request.context.logger
    switch (event.type) {
      case 'message': {
        const level = event.options?.level ?? 'info'
        const text = event.text ?? ''
        if (!text) {
          return
        }
        this.logWithLevel(logger, level, text, event.options?.meta)
        break
      }
      case 'progress': {
        const update = event.update
        const status = update.status ? `[${update.status}]` : ''
        const percent =
          typeof update.percent === 'number'
            ? ` ${update.percent.toFixed(
                Number.isInteger(update.percent) ? 0 : 1,
              )}%`
            : ''
        const message = update.message ? ` - ${update.message}` : ''
        const line = `${update.stage}${status}${percent}${message}`
        logger.info(line, update.meta)
        break
      }
      case 'json': {
        const serialized = this.safeSerializePayload(event.data)
        if (serialized) {
          logger.info(serialized)
        }
        break
      }
      case 'error': {
        const message = this.formatPresenterError(event.error)
        logger.error(message, event.meta)
        break
      }
      default:
        break
    }

    if (!this.redisEvents) {
      return
    }

    const envelope = this.buildPresenterEventEnvelope(request, event)
    if (!envelope) {
      return
    }

    void this.redisEvents
      .emit(request.context.runId, envelope)
      .catch((error: unknown) => {
        logger.warn('Failed to emit workflow presenter event', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private logWithLevel(
    logger: RuntimeLogger,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    switch (level) {
      case 'debug':
        logger.debug(message, meta)
        break
      case 'warn':
        logger.warn(message, meta)
        break
      case 'error':
        logger.error(message, meta)
        break
      default:
        logger.info(message, meta)
        break
    }
  }

  private safeSerializePayload(payload: unknown): string | null {
    if (payload == null) {
      return null
    }
    try {
      return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    } catch {
      return null
    }
  }

  private buildPresenterEventEnvelope(
    request: StepExecutionRequest,
    event: JobRunnerPresenterEvent,
  ): PluginEventEnvelope | null {
    const timestamp = event.timestamp ?? new Date().toISOString()
    const baseMeta: Record<string, unknown> = {
      host: 'workflow',
      runId: request.context.runId,
      jobId: request.context.jobId,
      stepId: request.context.stepId,
      attempt: request.context.attempt,
    }

    let payload: Record<string, unknown> | null = null
    let type: string | null = null

    switch (event.type) {
      case 'message': {
        const text = event.text ?? ''
        if (!text) {
          break
        }
        const level = event.options?.level ?? 'info'
        payload = {
          text,
          level,
          meta: event.options?.meta ?? null,
        }
        baseMeta.level = level
        type = 'workflow:presenter.message'
        break
      }
      case 'progress': {
        if (!event.update) {
          break
        }
        payload = {
          ...event.update,
        }
        if (event.update.status) {
          baseMeta.status = event.update.status
        }
        if (typeof event.update.percent === 'number') {
          baseMeta.percent = event.update.percent
        }
        if (event.update.stage) {
          baseMeta.stage = event.update.stage
        }
        type = 'workflow:presenter.progress'
        break
      }
      case 'json': {
        const serialized = this.safeSerializePayload(event.data)
        if (!serialized) {
          break
        }
        payload = {
          data: serialized,
        }
        type = 'workflow:presenter.json'
        break
      }
      case 'error': {
        const message = this.formatPresenterError(event.error)
        payload = {
          message,
          meta: event.meta ?? null,
        }
        type = 'workflow:presenter.error'
        break
      }
      default:
        break
    }

    if (!type || !payload) {
      return null
    }

    return {
      id: `${request.context.runId}:${request.context.jobId}:${timestamp}:${type}`,
      type,
      version: PRESENTER_EVENT_VERSION,
      timestamp,
      payload,
      meta: {
        ...baseMeta,
      },
    }
  }

  private formatPresenterError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message
    }
    if (typeof error === 'string') {
      return error
    }
    try {
      return JSON.stringify(error, null, 2)
    } catch {
      return String(error)
    }
  }

  private async resolveSecrets(
    run: WorkflowRun,
    job: JobRun,
    spec: StepSpec,
  ): Promise<Record<string, string>> {
    const names = new Set<string>()
    ;[run.secrets, job.secrets, spec.secrets].forEach((collection) => {
      if (!collection) {
        return
      }
      for (const name of collection) {
        if (typeof name === 'string' && name.length > 0) {
          names.add(name)
        }
      }
    })

    if (names.size === 0) {
      return {}
    }

    try {
      return await this.secretProvider.resolve(Array.from(names))
    } catch (error) {
      this.logger.warn('Failed to resolve secrets', {
        error: error instanceof Error ? error.message : String(error),
      })
      return {}
    }
  }
}

function computeDurationMs(
  startedAt: string | undefined,
  finishedAt: string,
): number | undefined {
  if (!startedAt) {
    return undefined
  }
  const start = Date.parse(startedAt)
  const end = Date.parse(finishedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined
  }
  return Math.max(0, end - start)
}

function mergeEnv(
  runEnv?: Record<string, unknown>,
  jobEnv?: Record<string, unknown>,
  stepEnv?: Record<string, unknown>,
): Record<string, string> {
  return {
    ...toStringRecord(runEnv),
    ...toStringRecord(jobEnv),
    ...toStringRecord(stepEnv),
  }
}

function toStringRecord(source?: Record<string, unknown>): Record<string, string> {
  if (!source) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value != null ? String(value) : '']),
  )
}

function isPluginStep(spec: StepSpec): boolean {
  return typeof spec.uses === 'string' && spec.uses.startsWith('plugin:')
}

function resolveWorkspace(spec: StepSpec, defaultWorkspace: string): string {
  const withBlock = (spec.with ?? {}) as Record<string, unknown>
  const workspace = withBlock.workspace ?? withBlock.cwd
  if (typeof workspace === 'string' && workspace.trim().length > 0) {
    return path.resolve(workspace)
  }
  return defaultWorkspace
}

function buildStepTimeoutOutcome(error: StepTimeoutError): StepOutcome {
  return {
    status: 'failed',
    result: {
      status: 'failed',
      error: {
        message: error.message,
        code: 'STEP_TIMEOUT',
        details: {
          timeoutMs: error.timeoutMs,
          stepId: error.stepId,
        },
      },
    },
  }
}

class StepTimeoutError extends Error {
  constructor(public readonly stepId: string, public readonly timeoutMs: number) {
    super(`Step ${stepId} exceeded timeout of ${timeoutMs}ms`)
    this.name = 'StepTimeoutError'
  }
}

