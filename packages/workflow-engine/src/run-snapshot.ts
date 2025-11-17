import type { WorkflowRun, JobRun, StepRun } from '@kb-labs/workflow-contracts'
import type { RedisClient } from './redis'
import type { EngineLogger } from './types'

export interface RunSnapshot {
  runId: string
  run: WorkflowRun
  stepOutputs: Record<string, Record<string, unknown>>
  env: Record<string, string>
  createdAt: string
  version: string
}

const SNAPSHOT_VERSION = '1.0.0'

export class RunSnapshotStorage {
  constructor(
    private readonly redisClient: RedisClient,
    private readonly logger: EngineLogger,
  ) {}

  private getSnapshotKey(runId: string): string {
    return `workflow:snapshot:${runId}`
  }

  async createSnapshot(
    run: WorkflowRun,
    stepOutputs: Record<string, Record<string, unknown>>,
    env: Record<string, string>,
  ): Promise<RunSnapshot> {
    const snapshot: RunSnapshot = {
      runId: run.id,
      run,
      stepOutputs,
      env,
      createdAt: new Date().toISOString(),
      version: SNAPSHOT_VERSION,
    }

    const key = this.getSnapshotKey(run.id)
    // Store snapshot with 7 days TTL
    await (this.redisClient as any).set(
      key,
      JSON.stringify(snapshot),
      'EX',
      7 * 24 * 60 * 60, // 7 days
    )

    this.logger.info('Snapshot created', { runId: run.id })
    return snapshot
  }

  async getSnapshot(runId: string): Promise<RunSnapshot | null> {
    const key = this.getSnapshotKey(runId)
    const stored = await this.redisClient.get(key)
    if (!stored) {
      return null
    }

    try {
      const snapshot = JSON.parse(stored) as RunSnapshot
      // Validate version
      if (snapshot.version !== SNAPSHOT_VERSION) {
        this.logger.warn('Snapshot version mismatch', {
          runId,
          expected: SNAPSHOT_VERSION,
          actual: snapshot.version,
        })
        // Try to load anyway, but log warning
      }
      return snapshot
    } catch (error) {
      this.logger.error('Failed to parse snapshot', {
        runId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async deleteSnapshot(runId: string): Promise<void> {
    const key = this.getSnapshotKey(runId)
    await this.redisClient.del(key)
    this.logger.debug('Snapshot deleted', { runId })
  }

  async listSnapshots(limit = 100): Promise<string[]> {
    // Note: This is a simple implementation. For production, might want to use
    // a sorted set or separate index for better performance
    const pattern = 'workflow:snapshot:*'
    const keys: string[] = []
    
    // Use SCAN to find all snapshot keys
    let cursor = '0'
    do {
      const [nextCursor, foundKeys] = await (this.redisClient as any).scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      )
      cursor = nextCursor
      keys.push(...foundKeys)
    } while (cursor !== '0')

    // Extract runIds from keys
    const runIds = keys
      .map((key) => key.replace('workflow:snapshot:', ''))
      .slice(0, limit)

    return runIds
  }
}

