import type {
  WorkflowRun,
  WorkflowSpec,
} from '@kb-labs/workflow-contracts'
import {
  EVENT_NAMES,
  type WorkflowEventName,
} from '@kb-labs/workflow-constants'
import type { ICache } from '@kb-labs/core-platform'
import { StateStore } from './state-store'
import { ConcurrencyManager, type AcquireOptions } from './concurrency-manager'
import {
  RunCoordinator,
  type RunCoordinatorOptions,
} from './run-coordinator'
import {
  Scheduler,
  type SchedulerOptions,
  type JobQueueEntry,
} from './scheduler'
import { EventBusBridge } from './event-bus'
import { WorkflowLoader } from './workflow-loader'
import type { CreateRunInput, EngineLogger, RunContext } from './types'
import { RunSnapshotStorage, type RunSnapshot } from './run-snapshot'

export interface WorkflowEngineOptions {
  scheduler?: SchedulerOptions
  concurrency?: AcquireOptions
  runCoordinator?: RunCoordinatorOptions
  maxWorkflowDepth?: number
  /** Platform cache adapter (REQUIRED) */
  cache?: ICache
  /** Platform event bus adapter (REQUIRED) */
  events?: import('@kb-labs/core-platform').IEventBus
  /** Platform logger (REQUIRED) */
  logger?: import('@kb-labs/core-platform').ILogger
  /** Platform execution backend (OPTIONAL - for plugin step execution) */
  executionBackend?: import('@kb-labs/plugin-execution').ExecutionBackend
}

export class WorkflowEngine {
  readonly loader: WorkflowLoader
  readonly maxWorkflowDepth: number

  private readonly logger: EngineLogger
  private readonly stateStore: StateStore
  private readonly concurrency: ConcurrencyManager
  private readonly runCoordinator: RunCoordinator
  private readonly scheduler: Scheduler
  private readonly events: EventBusBridge
  private readonly snapshotStorage: RunSnapshotStorage

  constructor(private readonly options: WorkflowEngineOptions = {}) {
    // Validate required platform adapters
    if (!options.cache) {
      throw new Error(
        'WorkflowEngine: options.cache is required. ' +
        'Pass platform.cache from @kb-labs/core-platform'
      )
    }
    if (!options.events) {
      throw new Error(
        'WorkflowEngine: options.events is required. ' +
        'Pass platform.events from @kb-labs/core-platform'
      )
    }
    if (!options.logger) {
      throw new Error(
        'WorkflowEngine: options.logger is required. ' +
        'Pass platform.logger from @kb-labs/core-platform'
      )
    }

    this.logger = options.logger

    this.stateStore = new StateStore(options.cache, this.logger)
    this.concurrency = new ConcurrencyManager(
      options.cache,
      this.logger,
      options.concurrency,
    )
    this.runCoordinator = new RunCoordinator(
      options.cache,
      this.stateStore,
      this.concurrency,
      this.logger,
      options.runCoordinator,
    )

    this.scheduler = new Scheduler(options.cache, this.logger, options.scheduler)
    this.events = new EventBusBridge(options.events, this.logger)
    this.loader = new WorkflowLoader(this.logger)
    this.maxWorkflowDepth = options.maxWorkflowDepth ?? 2
    this.snapshotStorage = new RunSnapshotStorage(options.cache, this.logger)
  }

  async dispose(): Promise<void> {
    // Cleanup if needed
  }

  async createRun(input: CreateRunInput): Promise<WorkflowRun> {
    const run = await this.runCoordinator.ensureRun(input)
    await this.events.publish({
      type: EVENT_NAMES.run.created,
      runId: run.id,
      payload: {
        status: run.status,
        name: run.name,
        version: run.version,
      },
    })
    await this.scheduler.scheduleRun(run)
    return run
  }

  async runFromSpec(
    spec: WorkflowSpec,
    input: Omit<CreateRunInput, 'spec'>,
  ): Promise<WorkflowRun> {
    return this.createRun({
      ...input,
      spec,
    })
  }

  async runFromFile(
    filePath: string,
    input: Omit<CreateRunInput, 'spec'>,
  ): Promise<WorkflowRun> {
    const result = await this.loader.fromFile(filePath)
    return this.runFromSpec(result.spec, input)
  }

  async runFromInline(
    spec: unknown,
    input: Omit<CreateRunInput, 'spec'>,
  ): Promise<WorkflowRun> {
    const result = this.loader.fromInline(spec)
    return this.runFromSpec(result.spec, input)
  }

  async getRun(runId: string): Promise<WorkflowRun | null> {
    return this.stateStore.getRun(runId)
  }

  async cancelRun(runId: string): Promise<void> {
    await this.stateStore.updateRun(runId, (draft) => {
      draft.status = 'cancelled'
      draft.finishedAt = new Date().toISOString()
      return draft
    })

    await this.events.publish({
      type: EVENT_NAMES.run.cancelled,
      runId,
      payload: { reason: 'cancelled by parent workflow' },
    })
  }

  async updateRun(
    runId: string,
    mutator: (run: WorkflowRun) => WorkflowRun | void,
  ): Promise<WorkflowRun | null> {
    const updated = await this.stateStore.updateRun(runId, mutator)
    if (updated) {
      await this.publishRunEvent(EVENT_NAMES.run.updated, updated)
    }
    return updated
  }

  async finalizeRun(
    runId: string,
    status: WorkflowRun['status'],
    context: Partial<RunContext> = {},
  ): Promise<WorkflowRun | null> {
    const updated = await this.stateStore.updateRun(runId, (run) => {
      const now = new Date().toISOString()
      run.status = status
      run.finishedAt = now
      run.durationMs = computeDurationMs(run.startedAt ?? run.queuedAt, now)
      if (context.jobs) {
        run.jobs = context.jobs
      }
      if (context.steps) {
        // optional override steps already included in jobs
      }
      return run
    })

    if (updated) {
      await this.runCoordinator.releaseConcurrency(updated)
      await this.publishRunEvent(
        status === 'failed'
          ? EVENT_NAMES.run.failed
          : status === 'cancelled'
            ? EVENT_NAMES.run.cancelled
            : EVENT_NAMES.run.finished,
        updated,
      )
    }

    return updated
  }

  async nextJob(): Promise<JobQueueEntry | null> {
    return this.scheduler.dequeueJob()
  }

  async rescheduleJob(entry: JobQueueEntry, delayMs: number): Promise<void> {
    await this.scheduler.reschedule(entry, delayMs)
  }

  async publishRunEvent(
    type: WorkflowEventName,
    run: WorkflowRun,
  ): Promise<void> {
    await this.events.publish({
      type,
      runId: run.id,
      payload: {
        status: run.status,
        name: run.name,
        version: run.version,
      },
    })
  }

  /**
   * Create a snapshot of the current run state
   */
  async createSnapshot(
    runId: string,
    stepOutputs: Record<string, Record<string, unknown>>,
    env: Record<string, string>,
  ): Promise<RunSnapshot | null> {
    const run = await this.getRun(runId)
    if (!run) {
      this.logger.warn('Cannot create snapshot: run not found', { runId })
      return null
    }

    return this.snapshotStorage.createSnapshot(run, stepOutputs, env)
  }

  /**
   * Get a snapshot for a run
   */
  async getSnapshot(runId: string): Promise<RunSnapshot | null> {
    return this.snapshotStorage.getSnapshot(runId)
  }

  /**
   * Replay a run from a snapshot, optionally starting from a specific step
   */
  async replayRun(
    runId: string,
    options: {
      fromStepId?: string
      stepOutputs?: Record<string, Record<string, unknown>>
      env?: Record<string, string>
    } = {},
  ): Promise<WorkflowRun | null> {
    // Load snapshot
    const snapshot = await this.snapshotStorage.getSnapshot(runId)
    if (!snapshot) {
      this.logger.warn('Cannot replay: snapshot not found', { runId })
      return null
    }

    // Restore run state
    const restoredRun = snapshot.run

    // Restore env if provided
    if (options.env) {
      restoredRun.env = { ...snapshot.env, ...options.env }
    } else {
      restoredRun.env = snapshot.env
    }

    // If fromStepId is specified, mark all steps before it as completed
    if (options.fromStepId) {
      for (const job of restoredRun.jobs) {
        let foundStep = false
        for (const step of job.steps) {
          if (step.id === options.fromStepId) {
            // Found the step to start from
            foundStep = true
            // Reset this step and all following steps
            if (step.status !== 'queued') {
              step.status = 'queued'
              step.startedAt = undefined
              step.finishedAt = undefined
            }
            continue
          }
          if (!foundStep) {
            // Mark previous steps as completed
            if (step.status === 'running' || step.status === 'queued') {
              step.status = 'success'
              step.finishedAt = step.finishedAt ?? new Date().toISOString()
            }
          } else {
            // Reset steps after the target step
            step.status = 'queued'
            step.startedAt = undefined
            step.finishedAt = undefined
          }
        }
      }
    } else {
      // Reset all steps to queued
      for (const job of restoredRun.jobs) {
        for (const step of job.steps) {
          step.status = 'queued'
          step.startedAt = undefined
          step.finishedAt = undefined
        }
      }
    }

    // Update run status
    restoredRun.status = 'running'
    restoredRun.startedAt = restoredRun.startedAt ?? new Date().toISOString()
    restoredRun.finishedAt = undefined

    // Save restored run
    await this.stateStore.saveRun(restoredRun)

    // Schedule the run
    await this.scheduler.scheduleRun(restoredRun)

    this.logger.info('Run replayed from snapshot', {
      runId,
      fromStepId: options.fromStepId,
    })

    return restoredRun
  }

  /**
   * Delete a snapshot
   */
  async deleteSnapshot(runId: string): Promise<void> {
    await this.snapshotStorage.deleteSnapshot(runId)
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





