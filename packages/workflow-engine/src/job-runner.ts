import type {
  ExecutionResult,
  JobRun,
  StepRun,
  WorkflowRun,
} from '@kb-labs/workflow-contracts'
import {
  EVENT_NAMES,
  type JobState,
  type RunState,
} from '@kb-labs/workflow-constants'
import type { EngineLogger } from './types'
import type { StateStore } from './state-store'
import type { EventBusBridge } from './event-bus'
import type { ConcurrencyManager } from './concurrency-manager'
import type { JobQueueEntry } from './scheduler'
import { shouldRetry } from './retry'
import {
  combineSignals,
  createTimeoutSignal,
  signalReason,
  getAbortReason,
} from './abort-utils'

export interface JobHandlerResult {
  status: Extract<JobState, 'success' | 'failed' | 'cancelled'>
  error?: {
    message: string
    code?: string
    details?: Record<string, unknown>
  }
  /**
   * Set to false to disable retry even if job policy allows it.
   */
  retryable?: boolean
}

export interface JobStateAdapter {
  reload(): Promise<{ run: WorkflowRun; job: JobRun } | null>
  updateJob(mutator: (job: JobRun) => JobRun | void): Promise<JobRun | null>
  updateStep(
    stepId: string,
    mutator: (step: StepRun) => StepRun | void,
  ): Promise<StepRun | null>
  updateRun(
    mutator: (run: WorkflowRun) => WorkflowRun | void,
  ): Promise<WorkflowRun | null>
}

export interface JobExecutionContext {
  run: WorkflowRun
  job: JobRun
  signal: AbortSignal
  heartbeat: () => Promise<void>
  logger: EngineLogger
  state: JobStateAdapter
}

export interface JobHandler {
  execute(context: JobExecutionContext): Promise<JobHandlerResult>
}

export type JobDispatchOutcome =
  | 'completed'
  | 'retry'
  | 'aborted'
  | 'skipped'

export interface JobDispatchResult {
  outcome: JobDispatchOutcome
  /**
   * Delay before the job should be requeued (used for retries and aborted jobs).
   */
  delayMs?: number
  error?: JobHandlerResult['error']
  releasedJobs?: JobRun[]
}

export interface JobDispatchRequest {
  entry: JobQueueEntry
  signal: AbortSignal
  heartbeat: () => Promise<void>
  /**
   * Optional timestamp override (mainly for testing).
   */
  now?: Date
}

export interface JobRunnerDeps {
  stateStore: StateStore
  events: EventBusBridge
  concurrency: ConcurrencyManager
  logger: EngineLogger
}

const FINAL_JOB_STATES: JobState[] = ['success', 'failed', 'cancelled', 'skipped']

export class JobRunner {
  private readonly stateStore: StateStore
  private readonly events: EventBusBridge
  private readonly concurrency: ConcurrencyManager
  private readonly logger: EngineLogger
  private readonly handler: JobHandler

  constructor(deps: JobRunnerDeps, handler: JobHandler) {
    this.stateStore = deps.stateStore
    this.events = deps.events
    this.concurrency = deps.concurrency
    this.logger = deps.logger
    this.handler = handler
  }

  async dispatch(request: JobDispatchRequest): Promise<JobDispatchResult> {
    if (request.signal.aborted) {
      return this.handlePreDispatchAbort(request, request.signal)
    }

    const snapshot = await this.loadJobSnapshot(
      request.entry.runId,
      request.entry.jobId,
    )
    if (!snapshot) {
      this.logger.warn('Job snapshot not found; skipping', {
        runId: request.entry.runId,
        jobId: request.entry.jobId,
      })
      return { outcome: 'skipped', releasedJobs: [] }
    }

    let { run, job } = snapshot

    if (!this.isDispatchable(job)) {
      this.logger.warn('Job is not dispatchable; skipping', {
        runId: run.id,
        jobId: job.id,
        status: job.status,
      })
      return { outcome: 'skipped', releasedJobs: [] }
    }

    const timeoutHandle =
      typeof job.timeoutMs === 'number' && job.timeoutMs > 0
        ? createTimeoutSignal(
            job.timeoutMs,
            () => new JobTimeoutError(job.id, job.timeoutMs ?? 0),
          )
        : null

    const composite = combineSignals(
      timeoutHandle ? [request.signal, timeoutHandle.signal] : [request.signal],
    )
    const jobSignal = composite.signal

    if (jobSignal.aborted) {
      timeoutHandle?.cancel()
      composite.dispose()
      return this.handlePreDispatchAbort(request, jobSignal)
    }

    const startTimestamp = (request.now ?? new Date()).toISOString()
    const runningJob = await this.markJobRunning(run.id, job.id, startTimestamp)
    if (!runningJob) {
      timeoutHandle?.cancel()
      composite.dispose()
      this.logger.warn('Failed to transition job to running state; skipping', {
        runId: run.id,
        jobId: job.id,
      })
      return { outcome: 'skipped', releasedJobs: [] }
    }

    job = runningJob
    run = (await this.stateStore.getRun(run.id)) ?? run

    await this.ensureRunStarted(run.id, startTimestamp)
    await this.publishJobEvent(EVENT_NAMES.job.started, run.id, job.id, {
      attempt: job.attempt,
    })

    const context: JobExecutionContext = {
      run,
      job,
      signal: jobSignal,
      heartbeat: request.heartbeat,
      logger: this.logger,
      state: this.createStateAdapter(run.id, job.id),
    }

    let handlerResult: JobHandlerResult

    try {
      handlerResult = await this.handler.execute(context)
    } catch (error) {
      const aborted = jobSignal.aborted
      const reason = signalReason(jobSignal)
      this.logger.error('Job handler threw an error', {
        runId: run.id,
        jobId: job.id,
        aborted,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })

      if (aborted && !(getAbortReason(jobSignal) instanceof JobTimeoutError)) {
        await this.resetJobToQueued(run.id, job.id, {
          incrementAttempt: false,
          reason: buildError(reason ?? 'Job aborted', 'JOB_ABORTED'),
          now: request.now,
        })
        timeoutHandle?.cancel()
        composite.dispose()
        return { outcome: 'aborted', releasedJobs: [] }
      }

      handlerResult = {
        status: 'failed',
        error: buildError(
          error instanceof Error ? error.message : 'Unknown job error',
          error instanceof Error && 'code' in error
            ? String((error as { code?: unknown }).code)
            : 'JOB_HANDLER_ERROR',
        ),
      }
    }

    if (jobSignal.aborted) {
      const abortReason = getAbortReason(jobSignal)
      if (abortReason instanceof JobTimeoutError) {
        handlerResult = {
          status: 'failed',
          error: buildError(
            abortReason.message,
            'JOB_TIMEOUT',
            { timeoutMs: abortReason.timeoutMs },
          ),
        }
      } else {
        await this.resetJobToQueued(run.id, job.id, {
          incrementAttempt: false,
          reason: buildError(
            signalReason(jobSignal) ?? 'Job aborted',
            'JOB_ABORTED',
          ),
          now: request.now,
        })
        timeoutHandle?.cancel()
        composite.dispose()
        return { outcome: 'aborted', releasedJobs: [] }
      }
    }

    const outcome = await this.completeJob(run, job, handlerResult, request)

    timeoutHandle?.cancel()
    composite.dispose()
    return outcome
  }

  private async completeJob(
    run: WorkflowRun,
    job: JobRun,
    handlerResult: JobHandlerResult,
    request: JobDispatchRequest,
  ): Promise<JobDispatchResult> {
    switch (handlerResult.status) {
      case 'success': {
        await this.finalizeJob(run.id, job.id, 'success', {
          now: request.now,
        })
        await this.publishJobEvent(EVENT_NAMES.job.succeeded, run.id, job.id, {
          attempt: job.attempt,
        })
        const releasedJobs = await this.stateStore.releaseBlockedJobs(
          run.id,
          job.jobName,
        )
        await this.maybeFinalizeRun(run.id, { now: request.now })
        return { outcome: 'completed', releasedJobs }
      }
      case 'cancelled': {
        await this.finalizeJob(run.id, job.id, 'cancelled', {
          now: request.now,
          error: handlerResult.error,
        })
        await this.publishJobEvent(EVENT_NAMES.job.cancelled, run.id, job.id, {
          attempt: job.attempt,
        })
        await this.maybeFinalizeRun(run.id, { now: request.now })
        return { outcome: 'completed', error: handlerResult.error, releasedJobs: [] }
      }
      case 'failed':
      default: {
        const attempt = job.attempt ?? 0
        const retryDecision = shouldRetry(attempt, job.retries)
        const canRetry =
          retryDecision.shouldRetry && handlerResult.retryable !== false

        if (canRetry) {
          const resetJob = await this.resetJobToQueued(run.id, job.id, {
            incrementAttempt: true,
            reason: handlerResult.error,
            now: request.now,
          })

          if (resetJob) {
            await this.publishJobEvent(EVENT_NAMES.job.queued, run.id, job.id, {
              attempt: resetJob.attempt,
              retryDelayMs: retryDecision.nextDelayMs ?? 0,
            })
          }

          return {
            outcome: 'retry',
            delayMs: retryDecision.nextDelayMs ?? 0,
            error: handlerResult.error,
            releasedJobs: [],
          }
        }

        await this.finalizeJob(run.id, job.id, 'failed', {
          now: request.now,
          error: handlerResult.error,
        })
        await this.publishJobEvent(EVENT_NAMES.job.failed, run.id, job.id, {
          attempt,
          error: handlerResult.error,
        })
        await this.maybeFinalizeRun(run.id, {
          now: request.now,
          runStatus: 'failed',
        })

        return { outcome: 'completed', error: handlerResult.error, releasedJobs: [] }
      }
    }
  }

  private async handlePreDispatchAbort(
    request: JobDispatchRequest,
    signal: AbortSignal,
  ): Promise<JobDispatchResult> {
    this.logger.warn('Job dispatch aborted before start', {
      runId: request.entry.runId,
      jobId: request.entry.jobId,
      reason: signalReason(signal),
    })
    await this.resetJobToQueued(request.entry.runId, request.entry.jobId, {
      incrementAttempt: false,
      reason: buildError('Job aborted before start', 'JOB_ABORTED'),
      now: request.now,
    })
    return { outcome: 'aborted', releasedJobs: [] }
  }

  private createStateAdapter(runId: string, jobId: string): JobStateAdapter {
    return {
      reload: async () => this.loadJobSnapshot(runId, jobId),
      updateJob: (mutator) => this.stateStore.updateJob(runId, jobId, mutator),
      updateStep: (stepId, mutator) =>
        this.stateStore.updateStep(runId, jobId, stepId, mutator),
      updateRun: (mutator) => this.stateStore.updateRun(runId, mutator),
    }
  }

  private async loadJobSnapshot(
    runId: string,
    jobId: string,
  ): Promise<{ run: WorkflowRun; job: JobRun } | null> {
    const run = await this.stateStore.getRun(runId)
    if (!run) {
      return null
    }
    const job = run.jobs.find((candidate) => candidate.id === jobId)
    if (!job) {
      return null
    }
    return { run, job }
  }

  private isDispatchable(job: JobRun): boolean {
    if (job.status === 'queued') {
      return true
    }
    if (job.status === 'running') {
      // Allow rescheduling of previously running job (recovering from crash)
      return true
    }
    return false
  }

  private async markJobRunning(
    runId: string,
    jobId: string,
    startedAt: string,
  ): Promise<JobRun | null> {
    return this.stateStore.updateJob(runId, jobId, (draft) => {
      draft.status = 'running'
      draft.startedAt = draft.startedAt ?? startedAt
      draft.finishedAt = undefined
      draft.durationMs = undefined
      draft.error = undefined
      return draft
    })
  }

  private async ensureRunStarted(runId: string, startedAt: string): Promise<void> {
    let shouldPublish = false
    await this.stateStore.updateRun(runId, (draft) => {
      if (draft.status === 'queued') {
        draft.status = 'running'
        shouldPublish = true
      }
      if (!draft.startedAt) {
        draft.startedAt = startedAt
      }
      return draft
    })
    if (shouldPublish) {
      await this.publishRunEvent(EVENT_NAMES.run.started, runId)
    }
  }

  private async finalizeJob(
    runId: string,
    jobId: string,
    status: Extract<JobState, 'success' | 'failed' | 'cancelled'>,
    options: { now?: Date; error?: JobHandlerResult['error'] },
  ): Promise<JobRun | null> {
    const finishedAt = (options.now ?? new Date()).toISOString()
    return this.stateStore.updateJob(runId, jobId, (draft) => {
      draft.status = status
      draft.finishedAt = finishedAt
      draft.durationMs = computeDurationMs(
        draft.startedAt ?? draft.queuedAt,
        finishedAt,
      )
      draft.error = options.error
      return draft
    })
  }

  private async resetJobToQueued(
    runId: string,
    jobId: string,
    options: {
      incrementAttempt: boolean
      reason?: JobHandlerResult['error']
      now?: Date
    },
  ): Promise<JobRun | null> {
    const timestamp = (options.now ?? new Date()).toISOString()
    return this.stateStore.updateJob(runId, jobId, (draft) => {
      if (options.incrementAttempt) {
        draft.attempt = (draft.attempt ?? 0) + 1
      }
      draft.status = 'queued'
      draft.queuedAt = timestamp
      draft.startedAt = undefined
      draft.finishedAt = undefined
      draft.durationMs = undefined
      draft.error = options.reason
      draft.steps = draft.steps.map((step) =>
        resetStep(step, timestamp),
      )
      return draft
    })
  }

  private async maybeFinalizeRun(
    runId: string,
    options: { now?: Date; runStatus?: RunState },
  ): Promise<void> {
    const run = await this.stateStore.getRun(runId)
    if (!run) {
      return
    }

    const allFinal = run.jobs.every((job) =>
      FINAL_JOB_STATES.includes(job.status),
    )
    if (!allFinal) {
      return
    }

    const derivedStatus = options.runStatus ?? deriveRunStatus(run)
    const finishedAt = (options.now ?? new Date()).toISOString()

    const updatedRun = await this.stateStore.updateRun(runId, (draft) => {
      draft.status = derivedStatus
      draft.finishedAt = finishedAt
      draft.durationMs = computeDurationMs(
        draft.startedAt ?? draft.queuedAt,
        finishedAt,
      )
      draft.result = buildRunResult(draft, derivedStatus, finishedAt)
      return draft
    })

    if (updatedRun?.metadata?.concurrencyGroup) {
      await this.concurrency.release(
        updatedRun.metadata.concurrencyGroup,
        updatedRun.id,
      )
    }

    const eventType =
      derivedStatus === 'failed'
        ? EVENT_NAMES.run.failed
        : derivedStatus === 'cancelled'
          ? EVENT_NAMES.run.cancelled
          : EVENT_NAMES.run.finished

    await this.publishRunEvent(eventType, runId, {
      status: derivedStatus,
    })
  }

  private async publishJobEvent(
    type: (typeof EVENT_NAMES)['job'][keyof (typeof EVENT_NAMES)['job']],
    runId: string,
    jobId: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.events.publish({
      type,
      runId,
      jobId,
      payload,
    })
  }

  private async publishRunEvent(
    type: RunEventName,
    runId: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    await this.events.publish({
      type,
      runId,
      payload,
    })
  }
}

type RunEventName = (typeof EVENT_NAMES)['run'][keyof (typeof EVENT_NAMES)['run']]

function buildError(
  message: string,
  code?: string,
  details?: Record<string, unknown>,
): JobHandlerResult['error'] {
  return {
    message,
    code,
    details,
  }
}

function resetStep(step: StepRun, timestamp: string): StepRun {
  return {
    ...step,
    status: 'queued',
    queuedAt: timestamp,
    startedAt: undefined,
    finishedAt: undefined,
    durationMs: undefined,
    attempt: 0,
    error: undefined,
  }
}

function buildRunResult(
  run: WorkflowRun,
  status: RunState,
  finishedAt: string,
): ExecutionResult {
  const jobs = run.jobs ?? []
  const jobsTotal = jobs.length
  const jobsSucceeded = jobs.filter((job) => job.status === 'success').length
  const jobsFailed = jobs.filter((job) => job.status === 'failed').length
  const jobsCancelled = jobs.filter((job) => job.status === 'cancelled').length

  const steps = jobs.flatMap((job) => job.steps ?? [])
  const stepsTotal = steps.length
  const stepsFailed = steps.filter((step) => step.status === 'failed').length
  const stepsCancelled = steps.filter((step) => step.status === 'cancelled').length

  const timeMs =
    run.startedAt != null
      ? computeDurationMs(run.startedAt, finishedAt)
      : run.durationMs

  const error = findFirstError(run)

  const summary = buildRunSummary(run.name, status, timeMs, jobsFailed, jobsCancelled)

  const metrics: ExecutionResult['metrics'] = {
    timeMs: timeMs ?? undefined,
    jobsTotal,
    jobsSucceeded,
    jobsFailed,
    jobsCancelled,
    stepsTotal,
    stepsFailed,
    stepsCancelled,
  }

  return {
    status,
    summary,
    startedAt: run.startedAt,
    completedAt: finishedAt,
    metrics,
    details: {
      jobsCancelled,
      stepsCancelled,
    },
    error,
  }
}

function buildRunSummary(
  name: string,
  status: RunState,
  timeMs: number | undefined,
  jobsFailed: number,
  jobsCancelled: number,
): string {
  const durationPart =
    typeof timeMs === 'number' ? ` in ${formatDuration(timeMs)}` : ''
  const base = `Workflow "${name}"`

  switch (status) {
    case 'success':
      return `${base} completed successfully${durationPart}.`
    case 'failed':
      return `${base} failed${durationPart} (${jobsFailed} job${jobsFailed === 1 ? '' : 's'} failed).`
    case 'cancelled':
      return `${base} was cancelled${durationPart}${jobsCancelled > 0 ? ` (${jobsCancelled} job${jobsCancelled === 1 ? '' : 's'} cancelled)` : ''}.`
    default:
      return `${base} finished with status ${status}${durationPart}.`
  }
}

function findFirstError(run: WorkflowRun): ExecutionResult['error'] | undefined {
  for (const job of run.jobs) {
    if (job.error) {
      return {
        message: job.error.message,
        code: job.error.code,
        details: {
          ...job.error.details,
          jobId: job.id,
          jobName: job.jobName,
        },
      }
    }
    for (const step of job.steps) {
      if (step.error) {
        return {
          message: step.error.message,
          code: step.error.code,
          details: {
            ...step.error.details,
            jobId: job.id,
            jobName: job.jobName,
            stepId: step.id,
            stepName: step.name,
          },
        }
      }
    }
  }
  return undefined
}

function formatDuration(timeMs: number): string {
  if (timeMs < 1000) {
    return `${timeMs}ms`
  }
  const seconds = timeMs / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  if (minutes < 60) {
    return `${minutes}m${remainingSeconds > 0 ? ` ${remainingSeconds}s` : ''}`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ''}`
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

function deriveRunStatus(run: WorkflowRun): RunState {
  const hasFailedJob = run.jobs.some((job) => job.status === 'failed')
  if (hasFailedJob) {
    return 'failed'
  }
  const hasCancelledJob = run.jobs.some((job) => job.status === 'cancelled')
  if (hasCancelledJob) {
    return 'cancelled'
  }
  const allSucceeded = run.jobs.every((job) => job.status === 'success')
  if (allSucceeded) {
    return 'success'
  }
  return run.status
}

export class JobTimeoutError extends Error {
  constructor(public readonly jobId: string, public readonly timeoutMs: number) {
    super(`Job ${jobId} exceeded timeout of ${timeoutMs}ms`)
    this.name = 'JobTimeoutError'
  }
}
