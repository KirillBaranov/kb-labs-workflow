import pino from 'pino'
import type {
  WorkflowRun,
  WorkflowSpec,
} from '@kb-labs/workflow-contracts'
import {
  EVENT_NAMES,
  type WorkflowEventName,
} from '@kb-labs/workflow-constants'
import {
  createRedisClient,
  type CreateRedisClientOptions,
  type RedisClientFactoryResult,
} from './redis'
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

function createDefaultLogger(): EngineLogger {
  const instance = pino({
    name: 'workflow-engine',
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
      if (meta && meta.error instanceof Error) {
        instance.error(meta, message)
      } else {
        instance.error(meta ?? {}, message)
      }
    },
  }
}

export interface WorkflowEngineOptions {
  redis?: CreateRedisClientOptions
  scheduler?: SchedulerOptions
  concurrency?: AcquireOptions
  runCoordinator?: RunCoordinatorOptions
  logger?: EngineLogger
}

export class WorkflowEngine {
  readonly loader: WorkflowLoader

  private readonly logger: EngineLogger
  private readonly redis: RedisClientFactoryResult
  private readonly stateStore: StateStore
  private readonly concurrency: ConcurrencyManager
  private readonly runCoordinator: RunCoordinator
  private readonly scheduler: Scheduler
  private readonly events: EventBusBridge

  constructor(private readonly options: WorkflowEngineOptions = {}) {
    this.logger = options.logger ?? createDefaultLogger()
    this.redis = createRedisClient(options.redis)
    this.stateStore = new StateStore(this.redis, this.logger)
    this.concurrency = new ConcurrencyManager(
      this.redis,
      this.logger,
      options.concurrency,
    )
    this.runCoordinator = new RunCoordinator(
      this.redis,
      this.stateStore,
      this.concurrency,
      this.logger,
      options.runCoordinator,
    )
    this.scheduler = new Scheduler(this.redis, this.logger, options.scheduler)
    this.events = new EventBusBridge(this.redis, this.logger)
    this.loader = new WorkflowLoader(this.logger)
  }

  async dispose(): Promise<void> {
    const client: any = this.redis.client
    if (typeof client.quit === 'function') {
      await client.quit()
    } else if (typeof client.disconnect === 'function') {
      client.disconnect()
    }
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





