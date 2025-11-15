import type { JobRun, WorkflowRun } from '@kb-labs/workflow-contracts'
import type { JobPriority } from '@kb-labs/workflow-constants'
import type { RedisClientFactoryResult } from './redis'
import type { EngineLogger } from './types'

export interface JobQueueEntry {
  id: string
  runId: string
  jobId: string
  priority: JobPriority
  enqueuedAt: string
  availableAt: number
  jobName: string
}

export interface SchedulerOptions {
  defaultPriority?: JobPriority
  lookAheadMs?: number
}

export class Scheduler {
  private readonly client
  private readonly keys
  private readonly defaultPriority: JobPriority
  private readonly lookAheadMs: number
  private readonly priorityOrder: JobPriority[] = ['high', 'normal', 'low']

  constructor(
    private readonly redis: RedisClientFactoryResult,
    private readonly logger: EngineLogger,
    options: SchedulerOptions = {},
  ) {
    this.client = redis.client
    this.keys = redis.keys
    this.defaultPriority = options.defaultPriority ?? 'normal'
    this.lookAheadMs = options.lookAheadMs ?? 1000
  }

  async scheduleRun(run: WorkflowRun): Promise<void> {
    for (const job of run.jobs) {
      if (job.blocked) {
        this.logger.debug('Job blocked by dependencies; deferring enqueue', {
          runId: run.id,
          jobId: job.id,
          needs: job.needs,
        })
        continue
      }
      const priority = job.priority ?? this.defaultPriority
      await this.enqueueJob(run.id, job, priority)
    }
  }

  async enqueueJob(
    runId: string,
    job: JobRun,
    priority: JobPriority = this.defaultPriority,
  ): Promise<void> {
    if (job.blocked) {
      this.logger.debug('Skipping enqueue for blocked job', {
        runId,
        jobId: job.id,
        needs: job.pendingDependencies,
      })
      return
    }
    const now = Date.now()
    const entryId = `${runId}:${job.id}:${now}:${Math.random().toString(36).slice(2, 10)}`
    const entry: JobQueueEntry = {
      id: entryId,
      runId,
      jobId: job.id,
      jobName: job.jobName,
      priority,
      enqueuedAt: new Date().toISOString(),
      availableAt: now,
    }
    await this.client.zadd(
      this.keys.jobQueue(priority),
      entry.availableAt,
      JSON.stringify(entry),
    )
    this.logger.debug('Job enqueued', { runId, jobId: job.id, priority })
  }

  async dequeueJob(): Promise<JobQueueEntry | null> {
    for (const priority of this.priorityOrder) {
      const entry = await this.dequeueFromPriority(priority)
      if (entry) {
        return entry
      }
    }
    return null
  }

  async reschedule(entry: JobQueueEntry, delayMs: number): Promise<void> {
    const availableAt = Date.now() + delayMs
    const next: JobQueueEntry = {
      ...entry,
      availableAt,
      enqueuedAt: new Date().toISOString(),
    }
    await this.client.zadd(
      this.keys.jobQueue(entry.priority),
      availableAt,
      JSON.stringify(next),
    )
    this.logger.debug('Job rescheduled', {
      runId: entry.runId,
      jobId: entry.jobId,
      delayMs,
      priority: entry.priority,
    })
  }

  private async dequeueFromPriority(priority: JobPriority): Promise<JobQueueEntry | null> {
    const now = Date.now()
    const key = this.keys.jobQueue(priority)
    const earliest = await this.client.zrangebyscore(
      key,
      0,
      now + this.lookAheadMs,
      'LIMIT',
      0,
      1,
    )
    if (earliest.length === 0) {
      return null
    }

    const raw = earliest[0]
    if (typeof raw !== 'string') {
      return null
    }
    try {
      const entry = JSON.parse(raw) as JobQueueEntry
      const removed = await this.client.zrem(key, raw)
      if (removed === 0) {
        return null
      }
      return entry
    } catch (error) {
      this.logger.error('Failed to parse job queue entry', { error })
      return null
    }
  }

  getDefaultPriority(): JobPriority {
    return this.defaultPriority
  }
}


