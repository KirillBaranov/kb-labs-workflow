/**
 * @module @kb-labs/workflow-engine/events/redis-event-bridge
 * Redis Streams-backed event bridge for workflow runs.
 */

import { randomUUID } from 'node:crypto'
import type { RedisClient } from '../redis'
import type { EngineLogger } from '../types'
import type { RedisKeyFactory } from '@kb-labs/workflow-constants'
import type { PluginEventEnvelope } from '@kb-labs/plugin-runtime'

const DEFAULT_TTL_SECONDS = 14 * 24 * 60 * 60 // 14 days
const DEFAULT_FLUSH_INTERVAL_MS = 100
const DEFAULT_MAX_BATCH_SIZE = 100
const DEFAULT_MAX_BUFFER_SIZE = 10_000
const DEFAULT_RATE_LIMIT_PER_SECOND = 1_000

type QueuedEvent = {
  runId: string
  event: PluginEventEnvelope
}

export interface RedisEventBridgeOptions {
  client: RedisClient
  keys: RedisKeyFactory
  logger: EngineLogger
  ttlSeconds?: number
  flushIntervalMs?: number
  maxBatchSize?: number
  maxBufferSize?: number
  rateLimitPerSecond?: number
}

interface RateCounter {
  windowStart: number
  count: number
}

export interface ReadEventsResult {
  events: Array<{ id: string; event: PluginEventEnvelope }>
  cursor: string | null
}

export class RedisEventBridge {
  private readonly client: RedisClient
  private readonly keys: RedisKeyFactory
  private readonly logger: EngineLogger
  private readonly ttlSeconds: number
  private readonly flushIntervalMs: number
  private readonly maxBatchSize: number
  private readonly maxBufferSize: number
  private readonly rateLimitPerSecond: number

  private readonly queue: QueuedEvent[] = []
  private readonly rateCounters = new Map<string, RateCounter>()

  private flushTimer: NodeJS.Timeout | null = null
  private flushing = false
  private lastErrorAt = 0

  constructor(options: RedisEventBridgeOptions) {
    this.client = options.client
    this.keys = options.keys
    this.logger = options.logger
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE
    this.maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE
    this.rateLimitPerSecond =
      options.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND
  }

  async emit(runId: string, event: PluginEventEnvelope): Promise<void> {
    if (!this.allow(runId)) {
      this.logger.warn('Workflow event rate limit exceeded', {
        runId,
        type: event.type,
      })
      return
    }

    const enriched: PluginEventEnvelope = {
      ...event,
      id: event.id ?? randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    }

    if (this.queue.length >= this.maxBufferSize) {
      this.queue.shift()
      this.logger.warn('Workflow event buffer reached capacity; dropping oldest event', {
        runId,
        type: enriched.type,
      })
    }

    this.queue.push({ runId, event: enriched })
    this.scheduleFlush()
  }

  async flush(force = false): Promise<void> {
    if ((this.flushing && !force) || this.queue.length === 0) {
      return
    }

    this.flushing = true
    const batch = this.queue.splice(0, this.maxBatchSize)

    try {
      const pipeline = this.client.pipeline()
      const uniqueRuns = new Set<string>()

      for (const entry of batch) {
        const key = this.keys.runEvents(entry.runId)
        uniqueRuns.add(key)
        pipeline.xadd(
          key,
          '*',
          'event',
          JSON.stringify(entry.event),
        )
      }

      for (const key of uniqueRuns) {
        pipeline.expire(key, this.ttlSeconds)
      }

      await pipeline.exec()
    } catch (error) {
      this.lastErrorAt = Date.now()
      this.logger.error('Failed to flush workflow events to Redis', {
        error: error instanceof Error ? error.message : String(error),
      })
      // requeue events at the front
      this.queue.unshift(...batch)
    } finally {
      this.flushing = false
      if (this.queue.length > 0) {
        this.scheduleFlush()
      }
    }
  }

  async read(
    runId: string,
    cursor: string | null = null,
    count = 100,
  ): Promise<ReadEventsResult> {
    const key = this.keys.runEvents(runId)
    const start = cursor ? `(${cursor}` : '-'
    const raw = await this.client.xrange(key, start, '+', 'COUNT', count)

    const events: Array<{ id: string; event: PluginEventEnvelope }> = []

    for (const entry of raw) {
      const [id, fields] = entry
      const payloadIndex = fields.findIndex((value) => value === 'event')
      if (payloadIndex === -1 || payloadIndex === fields.length - 1) {
        continue
      }
      const payload = fields[payloadIndex + 1]
      if (typeof payload !== 'string') {
        continue
      }
      try {
        const parsed = JSON.parse(payload) as PluginEventEnvelope
        parsed.meta = {
          ...parsed.meta,
          streamId: id,
        }
        events.push({ id, event: parsed })
      } catch (error) {
        this.logger.warn('Failed to parse workflow event payload', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const nextCursor = events.length > 0 ? events[events.length - 1]?.id ?? null : null
    return { events, cursor: nextCursor }
  }

  async export(runId: string): Promise<PluginEventEnvelope[]> {
    const aggregated: PluginEventEnvelope[] = []
    let cursor: string | null = null

    while (true) {
      const { events, cursor: next } = await this.read(runId, cursor, 500)
      if (events.length === 0) {
        break
      }
      for (const entry of events) {
        aggregated.push(entry.event)
      }
      cursor = next
    }

    return aggregated
  }

  private allow(runId: string): boolean {
    const bucket = this.rateCounters.get(runId)
    const now = Date.now()
    const windowStart = now - (now % 1000)

    if (!bucket || bucket.windowStart !== windowStart) {
      this.rateCounters.set(runId, { windowStart, count: 1 })
      return true
    }

    if (bucket.count >= this.rateLimitPerSecond) {
      return false
    }

    bucket.count++
    return true
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return
    }

    const delay =
      this.lastErrorAt && Date.now() - this.lastErrorAt < 1_000
        ? Math.max(this.flushIntervalMs, 500)
        : this.flushIntervalMs

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delay).unref?.()
  }
}


