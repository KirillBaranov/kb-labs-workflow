/**
 * @module @kb-labs/workflow-engine/cron/scheduler
 * CronScheduler - manages recurring scheduled jobs
 */

import type { RedisClientFactoryResult } from '../redis';
import type { ScheduleEntry, TriggeredJob, ParsedSchedule, CronSchedulerOptions } from './types';
import type { LeaderElection } from './leader-election';

// Re-export for convenience
export type { CronSchedulerOptions } from './types';
import { parseSchedule, getNextRun } from './parser';

/**
 * CronScheduler manages recurring scheduled jobs
 *
 * Architecture:
 * - Stores schedules in Redis sorted set (kb:schedules:active) sorted by nextRun
 * - Stores schedule data in Redis hash (kb:schedule:{scheduleId})
 * - Ticker polls Redis every tickIntervalMs to find due schedules
 * - When schedule is due, creates TriggeredJob and calls onTick callback
 * - Updates schedule with new nextRun and increments runCount
 */
export class CronScheduler {
  private readonly client;
  private tickerInterval: NodeJS.Timeout | null = null;
  private readonly tickIntervalMs: number;
  private readonly lookAheadMs: number;
  private running = false;
  private leaderElection?: LeaderElection;

  constructor(
    private readonly redis: RedisClientFactoryResult,
    options: CronSchedulerOptions = {},
    leaderElection?: LeaderElection
  ) {
    this.client = redis.client;
    this.tickIntervalMs = options.tickIntervalMs ?? 5000; // 5 seconds default
    this.lookAheadMs = options.lookAheadMs ?? 10000; // 10 seconds look-ahead
    this.leaderElection = leaderElection;
  }

  /**
   * Start the scheduler ticker
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.tickerInterval = setInterval(() => {
      this.tick().catch(err => {
        console.error('[CronScheduler] Tick error:', err);
      });
    }, this.tickIntervalMs);
  }

  /**
   * Stop the scheduler ticker
   */
  stop(): void {
    if (this.tickerInterval) {
      clearInterval(this.tickerInterval);
      this.tickerInterval = null;
    }
    this.running = false;
  }

  /**
   * Register a new schedule
   */
  async register(
    scheduleId: string,
    pluginId: string,
    handler: string,
    schedule: string,
    input?: unknown,
    options?: {
      priority?: number;
      timeout?: number;
      retries?: number;
      tags?: string[];
      startAt?: number;
      endAt?: number;
      maxRuns?: number;
    }
  ): Promise<ScheduleEntry> {
    // Parse schedule
    const parsed = parseSchedule(schedule);
    if (!parsed) {
      throw new Error(`Invalid schedule expression: ${schedule}`);
    }

    const now = Date.now();
    const startAt = options?.startAt ?? now;
    const nextRun = getNextRun(parsed, Math.max(now, startAt));

    const entry: ScheduleEntry = {
      scheduleId,
      pluginId,
      handler,
      input,
      schedule: parsed,
      priority: options?.priority,
      timeout: options?.timeout,
      retries: options?.retries,
      tags: options?.tags,
      startAt,
      endAt: options?.endAt,
      maxRuns: options?.maxRuns,
      createdAt: now,
      lastRun: null,
      nextRun,
      runCount: 0,
      status: 'active',
    };

    // Store in Redis
    await this.saveSchedule(entry);

    return entry;
  }

  /**
   * Cancel a schedule
   */
  async cancel(scheduleId: string): Promise<void> {
    const entry = await this.getSchedule(scheduleId);
    if (!entry) {
      return;
    }

    entry.status = 'cancelled';
    await this.saveSchedule(entry);

    // Remove from active sorted set
    await this.client.zrem(this.getActiveKey(), scheduleId);
  }

  /**
   * Pause a schedule
   */
  async pause(scheduleId: string): Promise<void> {
    const entry = await this.getSchedule(scheduleId);
    if (!entry) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    if (entry.status !== 'active') {
      throw new Error(`Cannot pause schedule in status: ${entry.status}`);
    }

    entry.status = 'paused';
    await this.saveSchedule(entry);

    // Remove from active sorted set
    await this.client.zrem(this.getActiveKey(), scheduleId);
  }

  /**
   * Resume a paused schedule
   */
  async resume(scheduleId: string): Promise<void> {
    const entry = await this.getSchedule(scheduleId);
    if (!entry) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    if (entry.status !== 'paused') {
      throw new Error(`Cannot resume schedule in status: ${entry.status}`);
    }

    entry.status = 'active';

    // Recalculate next run
    const now = Date.now();
    entry.nextRun = getNextRun(entry.schedule, now);

    await this.saveSchedule(entry);
  }

  /**
   * Get schedule info
   */
  async getSchedule(scheduleId: string): Promise<ScheduleEntry | null> {
    const key = this.getScheduleKey(scheduleId);
    const data = await this.client.get(key);

    if (!data) {
      return null;
    }

    return JSON.parse(data) as ScheduleEntry;
  }

  /**
   * List all schedules for a plugin
   */
  async listSchedules(pluginId: string): Promise<ScheduleEntry[]> {
    // Get all schedule IDs from active set
    const scheduleIds = await this.client.zrange(this.getActiveKey(), 0, -1);

    const schedules: ScheduleEntry[] = [];

    for (const scheduleId of scheduleIds) {
      const entry = await this.getSchedule(scheduleId as string);
      if (entry && entry.pluginId === pluginId) {
        schedules.push(entry);
      }
    }

    return schedules;
  }

  /**
   * Ticker - check for due schedules and trigger them
   */
  private async tick(): Promise<void> {
    // Skip ticker if leader election is enabled and we're not the leader
    if (this.leaderElection && !this.leaderElection.getIsLeader()) {
      return;
    }

    const now = Date.now();
    const until = now + this.lookAheadMs;

    // Get schedules due within look-ahead window
    const dueScheduleIds = await this.client.zrangebyscore(
      this.getActiveKey(),
      0,
      until
    );

    for (const scheduleId of dueScheduleIds) {
      await this.processDueSchedule(scheduleId as string, now);
    }
  }

  /**
   * Process a due schedule
   */
  private async processDueSchedule(scheduleId: string, now: number): Promise<void> {
    const entry = await this.getSchedule(scheduleId);
    if (!entry) {
      // Schedule was deleted
      await this.client.zrem(this.getActiveKey(), scheduleId);
      return;
    }

    // Check if truly due
    if (entry.nextRun > now) {
      return;
    }

    // Check if expired
    if (entry.endAt && now > entry.endAt) {
      entry.status = 'expired';
      await this.saveSchedule(entry);
      await this.client.zrem(this.getActiveKey(), scheduleId);
      return;
    }

    // Check if max runs reached
    if (entry.maxRuns && entry.runCount >= entry.maxRuns) {
      entry.status = 'completed';
      await this.saveSchedule(entry);
      await this.client.zrem(this.getActiveKey(), scheduleId);
      return;
    }

    // Trigger the job
    const triggered: TriggeredJob = {
      scheduleId: entry.scheduleId,
      pluginId: entry.pluginId,
      handler: entry.handler,
      input: entry.input,
      priority: entry.priority,
      timeout: entry.timeout,
      retries: entry.retries,
      tags: entry.tags,
      scheduledAt: entry.nextRun,
    };

    // Emit triggered job (this will be handled by JobBroker)
    await this.emitTriggeredJob(triggered);

    // Update schedule
    entry.lastRun = entry.nextRun;
    entry.runCount += 1;
    entry.nextRun = getNextRun(entry.schedule, now);

    await this.saveSchedule(entry);
  }

  /**
   * Emit triggered job to Redis pub/sub
   */
  private async emitTriggeredJob(job: TriggeredJob): Promise<void> {
    const channel = 'kb:cron:triggered';
    await this.client.publish(channel, JSON.stringify(job));
  }

  /**
   * Save schedule to Redis
   */
  private async saveSchedule(entry: ScheduleEntry): Promise<void> {
    const key = this.getScheduleKey(entry.scheduleId);

    // Save schedule data
    await this.client.set(key, JSON.stringify(entry));

    // Update sorted set if active
    if (entry.status === 'active') {
      await this.client.zadd(
        this.getActiveKey(),
        entry.nextRun,
        entry.scheduleId
      );
    } else {
      // Remove from sorted set if not active
      await this.client.zrem(this.getActiveKey(), entry.scheduleId);
    }
  }

  /**
   * Redis key for active schedules sorted set
   */
  private getActiveKey(): string {
    return 'kb:schedules:active';
  }

  /**
   * Redis key for schedule data
   */
  private getScheduleKey(scheduleId: string): string {
    return `kb:schedule:${scheduleId}`;
  }
}
