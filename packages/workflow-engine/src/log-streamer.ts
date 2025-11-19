/**
 * @module @kb-labs/workflow-engine/log-streamer
 * Live log streaming for workflow runs via Redis pub/sub.
 */

import type { RedisEventBridge } from './events/redis-event-bridge'
import type { RedisClient } from './redis'
import type { EngineLogger } from './types'

export interface LogEvent {
  runId: string
  jobId: string
  stepId: string
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

export interface WorkflowLogStreamerOptions {
  bufferSize?: number // batch events
  flushInterval?: number
}

export class WorkflowLogStreamer {
  constructor(
    private readonly redisEvents: RedisEventBridge,
    private readonly redisClient: RedisClient,
    private readonly logger: EngineLogger,
    private readonly options?: WorkflowLogStreamerOptions,
  ) {}

  async publishLog(event: LogEvent): Promise<void> {
    await this.redisEvents.emit(`workflow:logs:${event.runId}`, {
      id: `log-${Date.now()}-${Math.random()}`,
      type: 'workflow:log.line',
      version: '1.0.0',
      timestamp: event.timestamp,
      payload: event,
      meta: {},
    })
  }

  async publishStepStart(
    runId: string,
    jobId: string,
    stepId: string,
    stepName: string,
  ): Promise<void> {
    await this.redisEvents.emit(`workflow:logs:${runId}`, {
      id: `step-start-${Date.now()}-${Math.random()}`,
      type: 'workflow:log.step-start',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      payload: { runId, jobId, stepId, stepName },
      meta: {},
    })
  }

  async publishStepEnd(
    runId: string,
    jobId: string,
    stepId: string,
    status: string,
  ): Promise<void> {
    await this.redisEvents.emit(`workflow:logs:${runId}`, {
      id: `step-end-${Date.now()}-${Math.random()}`,
      type: 'workflow:log.step-end',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      payload: { runId, jobId, stepId, status },
      meta: {},
    })
  }

  /**
   * Subscribe to logs for a specific run
   * Returns unsubscribe function
   */
  subscribeToLogs(
    runId: string,
    callback: (event: LogEvent) => void,
  ): () => void {
    const channel = `workflow:logs:${runId}`
    let subscribed = true

    // Subscribe to Redis pub/sub channel
    // Note: IORedis subscribe returns a Promise, but we need to handle messages via 'message' event
    const messageHandler = (ch: string, message: string) => {
      if (!subscribed || ch !== channel) {
        return
      }

      try {
        const parsed = JSON.parse(message)
        if (parsed.type === 'workflow:log.line' && parsed.payload) {
          callback(parsed.payload as LogEvent)
        }
      } catch (error) {
        this.logger.warn('Failed to parse log event', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    this.redisClient.on('message', messageHandler)
    this.redisClient.subscribe(channel).catch((error) => {
      this.logger.error('Failed to subscribe to logs', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
    })

    // Return unsubscribe function
    return () => {
      subscribed = false
      this.redisClient.removeListener('message', messageHandler)
      this.redisClient.unsubscribe(channel).catch((error) => {
        this.logger.warn('Failed to unsubscribe from logs', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }
}

