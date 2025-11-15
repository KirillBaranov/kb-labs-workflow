import { describe, expect, it, beforeEach } from 'vitest'
import { Scheduler } from '../scheduler'
import { createRedisKeyFactory, type JobPriority } from '@kb-labs/workflow-constants'
import type { RedisClientFactoryResult } from '../redis'
import type { EngineLogger } from '../types'
import type { JobRun, WorkflowRun } from '@kb-labs/workflow-contracts'

class InMemorySortedSetClient {
  private store = new Map<string, Array<{ score: number; member: string }>>()

  async zadd(key: string, score: number, member: string): Promise<number> {
    const entries = this.store.get(key) ?? []
    entries.push({ score, member })
    entries.sort((a, b) => a.score - b.score)
    this.store.set(key, entries)
    return 1
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
    _limitToken: string,
    offset: number,
    count: number,
  ): Promise<string[]> {
    const entries = this.store.get(key) ?? []
    const filtered = entries.filter((entry) => entry.score >= min && entry.score <= max)
    return filtered.slice(offset, offset + count).map((entry) => entry.member)
  }

  async zrem(key: string, member: string): Promise<number> {
    const entries = this.store.get(key) ?? []
    const index = entries.findIndex((entry) => entry.member === member)
    if (index === -1) {
      return 0
    }
    entries.splice(index, 1)
    this.store.set(key, entries)
    return 1
  }
}

function createRedisStub(): RedisClientFactoryResult {
  return {
    client: new InMemorySortedSetClient() as unknown as any,
    keys: createRedisKeyFactory(),
  }
}

function createLogger(): EngineLogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}

function createJob(jobName: string, priority: JobPriority): JobRun {
  return {
    id: `run-1:${jobName}`,
    runId: 'run-1',
    jobName,
    status: 'queued',
    runsOn: 'local',
    queuedAt: new Date().toISOString(),
    attempt: 0,
    steps: [],
    artifacts: undefined,
    env: undefined,
    secrets: undefined,
    priority,
  } as unknown as JobRun
}

describe('Scheduler priority handling', () => {
  let scheduler: Scheduler

  beforeEach(() => {
    scheduler = new Scheduler(createRedisStub(), createLogger())
  })

  it('dequeues jobs by priority order', async () => {
    const run: WorkflowRun = {
      id: 'run-1',
      name: 'test',
      version: '1',
      status: 'queued',
      createdAt: new Date().toISOString(),
      queuedAt: new Date().toISOString(),
      trigger: { type: 'manual' },
      jobs: [
        createJob('normal', 'normal'),
        createJob('high', 'high'),
        createJob('low', 'low'),
      ],
      artifacts: [],
    } as unknown as WorkflowRun

    await scheduler.scheduleRun(run)

    const first = await scheduler.dequeueJob()
    expect(first?.jobId).toContain('high')
    const second = await scheduler.dequeueJob()
    expect(second?.jobId).toContain('normal')
    const third = await scheduler.dequeueJob()
    expect(third?.jobId).toContain('low')
  })

  it('reschedules job preserving priority', async () => {
    const job = createJob('retry', 'high')
    const run = {
      id: 'run-2',
      jobs: [job],
    } as unknown as WorkflowRun
    await scheduler.scheduleRun(run)
    const entry = await scheduler.dequeueJob()
    expect(entry?.priority).toBe('high')
    if (entry) {
      await scheduler.reschedule(entry, 1000)
    }
    const requeued = await scheduler.dequeueJob()
    expect(requeued?.priority).toBe('high')
  })
})

