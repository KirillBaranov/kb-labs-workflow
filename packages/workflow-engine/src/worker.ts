import { randomUUID } from 'node:crypto'
import type { RedisClient } from './redis'
import {
  createRedisClient,
  type CreateRedisClientOptions,
  type RedisClientFactoryResult,
} from './redis'
import { Scheduler, type JobQueueEntry, type SchedulerOptions } from './scheduler'
import { StateStore } from './state-store'
import { EventBusBridge } from './event-bus'
import { ConcurrencyManager, type AcquireOptions } from './concurrency-manager'
import type { EngineLogger } from './types'
import pino from 'pino'
import { JobRunner, type JobHandler } from './job-runner'
import type { DiscoveryOptions } from '@kb-labs/cli-core'
import {
  WorkflowJobHandler,
  type WorkflowJobHandlerOptions,
} from './job-handler'
import { loadWorkflowConfig } from '@kb-labs/workflow-runtime'
import { RedisEventBridge } from './events/redis-event-bridge'
import {
  createPluginCommandResolver,
  type PluginCommandResolver,
  type PluginCommandResolverConfig,
} from './plugin-command-resolver'
import type { JobRun } from '@kb-labs/workflow-contracts'

export interface WorkflowWorkerOptions {
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  leaseTtlMs?: number
  maxConcurrentJobs?: number
  workerId?: string
}

export interface CreateWorkflowWorkerOptions
  extends WorkflowWorkerOptions {
  jobHandler?: JobHandler
  logger?: EngineLogger
  redis?: CreateRedisClientOptions
  scheduler?: SchedulerOptions
  concurrency?: AcquireOptions
  commandResolver?: PluginCommandResolver
  commandResolverConfig?: PluginCommandResolverConfig
  jobHandlerOptions?: WorkflowJobHandlerOptions
  engine?: import('./engine').WorkflowEngine
  workspaceRoot?: string
}

export interface WorkflowWorkerMetrics {
  startedAt: string | null
  processedJobs: number
  retriedJobs: number
  failedJobs: number
  abortedJobs: number
  activeJobs: number
  lastJobCompletedAt?: string
}

interface WorkflowWorkerDeps {
  scheduler: Scheduler
  jobRunner: JobRunner
  redis: RedisClientFactoryResult
  logger: EngineLogger
  options: WorkflowWorkerOptions
}

interface ActiveJob {
  entry: JobQueueEntry
  abortController: AbortController
  leaseKey: string
  leaseOwner: string
  heartbeatTimer?: NodeJS.Timeout
  processing: Promise<void>
}

const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000
const DEFAULT_LEASE_TTL_MS = 15_000
const DEFAULT_MAX_CONCURRENT_JOBS = 1

export class WorkflowWorker {
  private readonly scheduler: Scheduler
  private readonly jobRunner: JobRunner
  private readonly redis: RedisClientFactoryResult
  private readonly logger: EngineLogger
  private readonly pollIntervalMs: number
  private readonly heartbeatIntervalMs: number
  private readonly leaseTtlMs: number
  private readonly maxConcurrentJobs: number
  private readonly workerId: string
  private readonly disposeHooks: Array<() => Promise<void> | void> = []
  private startedAt: string | null = null
  private readonly metricsState: {
    processed: number
    retried: number
    failed: number
    aborted: number
    lastCompletedAt?: string
  } = {
    processed: 0,
    retried: 0,
    failed: 0,
    aborted: 0,
  }

  private running = false
  private stopping = false
  private pollPromise: Promise<void> | null = null
  private readonly activeJobs = new Map<string, ActiveJob>()

  constructor(deps: WorkflowWorkerDeps) {
    this.scheduler = deps.scheduler
    this.jobRunner = deps.jobRunner
    this.redis = deps.redis
    this.logger = deps.logger
    this.workerId = deps.options.workerId ?? randomUUID()
    this.pollIntervalMs = deps.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.leaseTtlMs = deps.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    const requestedHeartbeat =
      deps.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatIntervalMs = Math.min(
      Math.max(Math.floor(this.leaseTtlMs / 2), 1_000),
      requestedHeartbeat,
    )
    this.maxConcurrentJobs =
      deps.options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS
  }

  start(): void {
    if (this.running) {
      return
    }
    this.running = true
    this.stopping = false
    this.startedAt = new Date().toISOString()
    this.pollPromise = this.pollLoop()
    this.logger.info('Workflow worker started', {
      workerId: this.workerId,
      pollIntervalMs: this.pollIntervalMs,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      leaseTtlMs: this.leaseTtlMs,
      maxConcurrentJobs: this.maxConcurrentJobs,
    })
  }

  async stop(): Promise<void> {
    if (!this.running && !this.pollPromise) {
      return
    }

    this.logger.info('Stopping workflow worker...', { workerId: this.workerId })
    this.stopping = true
    this.running = false

    if (this.pollPromise) {
      await this.pollPromise.catch((error) => {
        this.logger.error('Worker poll loop failed during stop', {
          workerId: this.workerId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      this.pollPromise = null
    }

    const jobs = Array.from(this.activeJobs.values())
    if (jobs.length > 0) {
      this.logger.info('Aborting active jobs during shutdown', {
        workerId: this.workerId,
        activeJobs: jobs.length,
      })
    }

    for (const active of jobs) {
      if (!active.abortController.signal.aborted) {
        active.abortController.abort(
          new WorkerShutdownError('Worker shutting down'),
        )
      }
    }

    await Promise.allSettled(jobs.map((job) => job.processing))

    this.logger.info('Workflow worker stopped', { workerId: this.workerId })
  }

  async dispose(): Promise<void> {
    await this.stop()
    for (const hook of this.disposeHooks.splice(0)) {
      try {
        await hook()
      } catch (error) {
        this.logger.warn('Dispose hook failed', {
          workerId: this.workerId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    await closeRedis(this.redis.client, this.logger)
  }

  addDisposeHook(hook: () => Promise<void> | void): void {
    this.disposeHooks.push(hook)
  }

  getMetrics(): WorkflowWorkerMetrics {
    return {
      startedAt: this.startedAt,
      processedJobs: this.metricsState.processed,
      retriedJobs: this.metricsState.retried,
      failedJobs: this.metricsState.failed,
      abortedJobs: this.metricsState.aborted,
      activeJobs: this.activeJobs.size,
      lastJobCompletedAt: this.metricsState.lastCompletedAt,
    }
  }

  private async pollLoop(): Promise<void> {
    while (this.running && !this.stopping) {
      try {
        if (this.activeJobs.size >= this.maxConcurrentJobs) {
          await sleep(this.pollIntervalMs)
          continue
        }

        const entry = await this.scheduler.dequeueJob()
        if (!entry) {
          await sleep(this.pollIntervalMs)
          continue
        }

        const lease = await this.tryAcquireLease(entry)
        if (!lease) {
          await this.scheduler.reschedule(entry, this.pollIntervalMs)
          continue
        }

        this.spawnJob(entry, lease)
      } catch (error) {
        this.logger.error('Worker poll loop error', {
          workerId: this.workerId,
          error: error instanceof Error ? error.message : String(error),
        })
        await sleep(this.pollIntervalMs)
      }
    }
  }

  private spawnJob(
    entry: JobQueueEntry,
    lease: { key: string; owner: string },
  ): void {
    const abortController = new AbortController()
    const active: ActiveJob = {
      entry,
      abortController,
      leaseKey: lease.key,
      leaseOwner: lease.owner,
      processing: Promise.resolve(),
    }
    this.activeJobs.set(entry.id, active)

    const refresh = () => this.refreshLease(active)
    const heartbeatTimer = setInterval(refresh, this.heartbeatIntervalMs)
    active.heartbeatTimer = heartbeatTimer

    active.processing = (async () => {
      try {
        await refresh()
        const result = await this.jobRunner.dispatch({
          entry,
          signal: abortController.signal,
          heartbeat: refresh,
        })
        await this.handleJobResult(active, result)
      } catch (error) {
        this.logger.error('Job dispatch failed', {
          workerId: this.workerId,
          jobId: entry.jobId,
          runId: entry.runId,
          error: error instanceof Error ? error.message : String(error),
        })
        await this.scheduler.reschedule(entry, this.pollIntervalMs)
      } finally {
        clearInterval(heartbeatTimer)
        await this.releaseLease(active)
        this.activeJobs.delete(entry.id)
      }
    })()
  }

  private async handleJobResult(
    active: ActiveJob,
    result: Awaited<ReturnType<JobRunner['dispatch']>>,
  ): Promise<void> {
    switch (result.outcome) {
      case 'retry': {
        this.metricsState.retried += 1
        const delay = result.delayMs ?? this.pollIntervalMs
        this.logger.info('Requeueing job for retry', {
          workerId: this.workerId,
          jobId: active.entry.jobId,
          runId: active.entry.runId,
          delayMs: delay,
        })
        await this.scheduler.reschedule(active.entry, delay)
        break
      }
      case 'aborted': {
        this.metricsState.aborted += 1
        const delay = result.delayMs ?? this.pollIntervalMs
        this.logger.info('Job aborted; rescheduling', {
          workerId: this.workerId,
          jobId: active.entry.jobId,
          runId: active.entry.runId,
          delayMs: delay,
        })
        await this.scheduler.reschedule(active.entry, delay)
        break
      }
      case 'skipped': {
        this.logger.debug('Job skipped during dispatch', {
          workerId: this.workerId,
          jobId: active.entry.jobId,
          runId: active.entry.runId,
        })
        break
      }
      case 'completed':
      default: {
        if (result.error) {
          this.metricsState.failed += 1
          this.logger.warn('Job completed with error', {
            workerId: this.workerId,
            jobId: active.entry.jobId,
            runId: active.entry.runId,
            error: result.error,
          })
        } else {
          this.metricsState.processed += 1
          this.metricsState.lastCompletedAt = new Date().toISOString()
          this.logger.info('Job processed successfully', {
            workerId: this.workerId,
            jobId: active.entry.jobId,
            runId: active.entry.runId,
            activeJobs: this.activeJobs.size,
            processedJobs: this.metricsState.processed,
          })
          if (result.releasedJobs && result.releasedJobs.length > 0) {
            await this.scheduleReleasedJobs(active.entry.runId, result.releasedJobs)
          }
        }
      }
    }
  }

  private async tryAcquireLease(
    entry: JobQueueEntry,
  ): Promise<{ key: string; owner: string } | null> {
    const leaseKey = this.redis.keys.lock(`job-lease:${entry.jobId}`)
    const leaseOwner = `${this.workerId}:${randomUUID()}`
    try {
      const result = await (this.redis.client as RedisClient).set(
        leaseKey,
        leaseOwner,
        'PX',
        this.leaseTtlMs,
        'NX',
      )
      if (result === 'OK') {
        return { key: leaseKey, owner: leaseOwner }
      }
      this.logger.debug('Lease already held by another worker', {
        workerId: this.workerId,
        jobId: entry.jobId,
      })
      return null
    } catch (error) {
      this.logger.error('Failed to acquire job lease', {
        workerId: this.workerId,
        jobId: entry.jobId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  private async refreshLease(active: ActiveJob): Promise<void> {
    try {
      const client = this.redis.client as RedisClient
      const current = await client.get(active.leaseKey)
      if (current !== active.leaseOwner) {
        this.logger.warn('Lease lost to another worker', {
          workerId: this.workerId,
          jobId: active.entry.jobId,
        })
        active.abortController.abort(
          new WorkerLeaseLostError('Job lease lost'),
        )
        return
      }
      await client.pexpire(active.leaseKey, this.leaseTtlMs)
      this.logger.debug('Lease heartbeat sent', {
        workerId: this.workerId,
        jobId: active.entry.jobId,
        runId: active.entry.runId,
      })
    } catch (error) {
      this.logger.error('Failed to refresh job lease', {
        workerId: this.workerId,
        jobId: active.entry.jobId,
        error: error instanceof Error ? error.message : String(error),
      })
      active.abortController.abort(
        new WorkerLeaseLostError('Failed to refresh job lease'),
      )
    }
  }

  private async releaseLease(active: ActiveJob): Promise<void> {
    try {
      const client = this.redis.client as RedisClient
      const current = await client.get(active.leaseKey)
      if (current === active.leaseOwner) {
        await client.del(active.leaseKey)
      }
    } catch (error) {
      this.logger.warn('Failed to release lease', {
        workerId: this.workerId,
        jobId: active.entry.jobId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async scheduleReleasedJobs(runId: string, jobs: JobRun[]): Promise<void> {
    for (const job of jobs) {
      try {
        const priority = job.priority ?? this.scheduler.getDefaultPriority()
        await this.scheduler.enqueueJob(runId, job, priority)
        this.logger.info('Released dependent job', {
          runId,
          jobId: job.id,
          jobName: job.jobName,
          priority,
        })
      } catch (error) {
        this.logger.error('Failed to enqueue dependent job', {
          runId,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}

const DEFAULT_DISCOVERY_OPTIONS: DiscoveryOptions = {
  strategies: ['workspace', 'pkg'],
  roots: [process.cwd()],
}

export async function createWorkflowWorker(
  options: CreateWorkflowWorkerOptions,
): Promise<WorkflowWorker> {
  const logger =
    options.logger ??
    pino({
      name: 'workflow-worker',
      level: process.env.LOG_LEVEL ?? 'info',
    })

  const redis = createRedisClient({
    ...(options.redis ?? {}),
    logger,
  })
  const stateStore = new StateStore(redis, logger)
  const events = new EventBusBridge(redis, logger)
  const concurrency = new ConcurrencyManager(
    redis,
    logger,
    options.concurrency,
  )
  const scheduler = new Scheduler(redis, logger, options.scheduler)
  let commandResolver = options.commandResolver
  let resolverOwned = false

  if (!commandResolver) {
    const resolverConfig: PluginCommandResolverConfig = options.commandResolverConfig
      ? {
          ...options.commandResolverConfig,
          logger,
        }
      : {
          discovery: DEFAULT_DISCOVERY_OPTIONS,
          logger,
        }
    commandResolver = await createPluginCommandResolver(resolverConfig)
    resolverOwned = true
  }

  // Load workflow config for budget settings
  let budgetConfig: import('@kb-labs/workflow-runtime').BudgetConfig | undefined
  try {
    const workflowConfig = await loadWorkflowConfig(
      options.workspaceRoot ?? process.cwd(),
    )
    budgetConfig = workflowConfig.budget
  } catch {
    // Config not available, continue without budget
  }

  const jobHandler =
    options.jobHandler ??
    new WorkflowJobHandler({
      logger,
      events,
      resolver: commandResolver,
      options: {
        ...options.jobHandlerOptions,
        eventsBridge:
          options.jobHandlerOptions?.eventsBridge ??
          new RedisEventBridge({
            client: redis.client,
            keys: redis.keys,
            logger,
          }),
        workflowRegistry: options.engine?.workflowRegistry,
        engine: options.engine,
        maxWorkflowDepth: options.engine?.maxWorkflowDepth,
        redisClient: redis.client,
        stateStore,
        budgetConfig,
      },
    })

  const jobRunner = new JobRunner(
    {
      stateStore,
      events,
      concurrency,
      logger,
    },
    jobHandler,
  )

  const worker = new WorkflowWorker({
    scheduler,
    jobRunner,
    redis,
    logger,
    options,
  })

  if (resolverOwned) {
    worker.addDisposeHook(() => commandResolver?.dispose())
  }

  return worker
}

export class WorkerShutdownError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerShutdownError'
  }
}

export class WorkerLeaseLostError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerLeaseLostError'
  }
}

async function closeRedis(
  client: RedisClient,
  logger: EngineLogger,
): Promise<void> {
  try {
    if (typeof (client as any).quit === 'function') {
      await (client as any).quit()
      return
    }
    if (typeof (client as any).disconnect === 'function') {
      ;(client as any).disconnect()
    }
  } catch (error) {
    logger.warn('Failed to close Redis client', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

