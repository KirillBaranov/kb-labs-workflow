import {
  WORKFLOW_REDIS_CHANNEL,
  type WorkflowEventName,
} from '@kb-labs/workflow-constants'
import type { RedisClientFactoryResult } from './redis'
import type { EngineLogger } from './types'

export interface WorkflowEvent<TPayload = Record<string, unknown>> {
  type: WorkflowEventName
  runId: string
  jobId?: string
  stepId?: string
  payload?: TPayload
  timestamp?: string
}

export class EventBusBridge {
  private readonly client
  private readonly channel = WORKFLOW_REDIS_CHANNEL

  constructor(
    private readonly redis: RedisClientFactoryResult,
    private readonly logger: EngineLogger,
  ) {
    this.client = redis.client
  }

  async publish<TPayload = Record<string, unknown>>(
    event: WorkflowEvent<TPayload>,
  ): Promise<void> {
    const payload = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    }
    await this.client.publish(this.channel, JSON.stringify(payload))
    this.logger.debug('Workflow event published', {
      channel: this.channel,
      type: event.type,
      runId: event.runId,
    })
  }
}


