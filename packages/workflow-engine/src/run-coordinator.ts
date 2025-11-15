import { randomUUID } from 'node:crypto'
import { IDEMPOTENCY_TTL_ENV } from '@kb-labs/workflow-constants'
import type {
  JobRun,
  JobSpec,
  StepRun,
  WorkflowRun,
} from '@kb-labs/workflow-contracts'
import type { StateStore } from './state-store'
import type { ConcurrencyManager } from './concurrency-manager'
import type { EngineLogger, CreateRunInput } from './types'
import type { RedisClientFactoryResult } from './redis'

const DEFAULT_IDEMPOTENCY_TTL_MS = 1000 * 60 * 60 * 24 // 24h

function resolveIdempotencyTtlMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) {
    return explicit
  }
  const envValue = process.env[IDEMPOTENCY_TTL_ENV]
  const parsed = envValue ? Number(envValue) : undefined
  if (parsed && Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  return DEFAULT_IDEMPOTENCY_TTL_MS
}

export interface RunCoordinatorOptions {
  idempotencyTtlMs?: number
}

export class RunCoordinator {
  private readonly client
  private readonly keys
  private readonly idempotencyTtlMs: number

  constructor(
    private readonly redis: RedisClientFactoryResult,
    private readonly stateStore: StateStore,
    private readonly concurrencyManager: ConcurrencyManager,
    private readonly logger: EngineLogger,
    options: RunCoordinatorOptions = {},
  ) {
    this.client = redis.client
    this.keys = redis.keys
    this.idempotencyTtlMs = resolveIdempotencyTtlMs(options.idempotencyTtlMs)
  }

  async ensureRun(input: CreateRunInput): Promise<WorkflowRun> {
    if (input.idempotencyKey) {
      const existing = await this.loadByIdempotencyKey(input.idempotencyKey)
      if (existing) {
        this.logger.info('Idempotent workflow run reused', {
          runId: existing.id,
          idempotencyKey: input.idempotencyKey,
        })
        return existing
      }
    }

    const runId = randomUUID()
    const now = new Date().toISOString()

    if (input.concurrencyGroup) {
      const acquired = await this.concurrencyManager.acquire(
        input.concurrencyGroup,
        runId,
      )

      if (!acquired) {
        const active = await this.concurrencyManager.getActiveRun(
          input.concurrencyGroup,
        )
        const message = active
          ? `Concurrency group ${input.concurrencyGroup} already locked by run ${active}`
          : `Failed to acquire concurrency lock for ${input.concurrencyGroup}`
        this.logger.warn(message, {
          concurrencyGroup: input.concurrencyGroup,
          activeRunId: active,
        })
        throw new Error(message)
      }
    }

    const run = this.buildInitialRun(input, runId, now)
    await this.stateStore.saveRun(run)

    if (input.idempotencyKey) {
      await this.registerIdempotencyKey(input.idempotencyKey, run.id)
    }

    this.logger.info('Workflow run created', {
      runId: run.id,
      name: run.name,
      version: run.version,
    })

    return run
  }

  private buildInitialRun(
    input: CreateRunInput,
    runId: string,
    timestamp: string,
  ): WorkflowRun {
    const jobs: JobRun[] = []

    for (const [jobName, jobSpec] of Object.entries(
      input.spec.jobs,
    ) as Array<[string, JobSpec]>) {
      const jobId = `${runId}:${jobName}`
      const needs = Array.isArray(jobSpec.needs) ? [...jobSpec.needs] : []
      const priority = jobSpec.priority ?? 'normal'
      const stepRuns: StepRun[] = jobSpec.steps.map((step, index) => ({
        id: `${jobId}:${index}`,
        runId,
        jobId,
        name: step.name,
        index,
        status: 'queued',
        queuedAt: timestamp,
        attempt: 0,
        timeoutMs: step.timeoutMs,
        continueOnError: step.continueOnError,
        spec: step,
      }))

      jobs.push({
        id: jobId,
        runId,
        jobName,
        status: 'queued',
        runsOn: jobSpec.runsOn,
        queuedAt: timestamp,
        attempt: 0,
        steps: stepRuns,
        concurrency: jobSpec.concurrency,
        retries: jobSpec.retries,
        timeoutMs: jobSpec.timeoutMs,
        artifacts: jobSpec.artifacts,
        env: jobSpec.env,
        secrets: jobSpec.secrets,
        needs,
        pendingDependencies: [...needs],
        blocked: needs.length > 0,
        priority,
      })
    }

    const workflowRun: WorkflowRun = {
      id: runId,
      name: input.spec.name,
      version: input.spec.version,
      status: 'queued',
      createdAt: timestamp,
      queuedAt: timestamp,
      trigger: input.trigger,
      env: input.spec.env,
      secrets: input.spec.secrets,
      jobs,
      metadata: {
        idempotencyKey: input.idempotencyKey,
        concurrencyGroup: input.concurrencyGroup,
      },
      artifacts: [],
    }

    return workflowRun
  }

  private async registerIdempotencyKey(
    key: string,
    runId: string,
  ): Promise<void> {
    const redisKey = this.keys.idempotency(key)
    const result = await this.client.set(
      redisKey,
      runId,
      'PX',
      this.idempotencyTtlMs,
      'NX',
    )

    if (result !== 'OK') {
      const existingRunId = await this.client.get(redisKey)
      if (existingRunId) {
        const existing = await this.stateStore.getRun(existingRunId)
        if (existing) {
          throw new Error(
            `Idempotency key ${key} already associated with run ${existingRunId}`,
          )
        }
      }
      throw new Error(`Failed to register idempotency key ${key}`)
    }
  }

  private async loadByIdempotencyKey(
    key: string,
  ): Promise<WorkflowRun | null> {
    const redisKey = this.keys.idempotency(key)
    const existingRunId = await this.client.get(redisKey)
    if (!existingRunId) {
      return null
    }
    return this.stateStore.getRun(existingRunId)
  }

  async releaseConcurrency(run: WorkflowRun): Promise<void> {
    const group = run.metadata?.concurrencyGroup
    if (!group) {
      return
    }
    await this.concurrencyManager.release(group, run.id)
    this.logger.debug('Released concurrency group', {
      runId: run.id,
      group,
    })
  }
}


