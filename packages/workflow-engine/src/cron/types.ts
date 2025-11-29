/**
 * @module @kb-labs/plugin-runtime/jobs/cron/types
 * CronScheduler type definitions
 */

/**
 * CronScheduler options
 */
export interface CronSchedulerOptions {
  /** Tick interval in milliseconds (how often to check for due jobs) */
  tickIntervalMs?: number;

  /** Look-ahead window in milliseconds */
  lookAheadMs?: number;
}

/**
 * Parsed schedule representation
 */
export interface ParsedSchedule {
  /** Schedule type */
  type: 'cron' | 'interval';

  /** Original schedule string */
  expression: string;

  /** Cron expression (if type is 'cron') */
  cron?: string;

  /** Interval in milliseconds (if type is 'interval') */
  intervalMs?: number;
}

/**
 * Schedule entry stored in Redis
 */
export interface ScheduleEntry {
  /** Schedule ID */
  scheduleId: string;

  /** Plugin ID */
  pluginId: string;

  /** Handler path */
  handler: string;

  /** Input data */
  input?: unknown;

  /** Parsed schedule */
  schedule: ParsedSchedule;

  /** Priority (1-10, maps to high/normal/low) */
  priority?: number;

  /** Timeout in milliseconds */
  timeout?: number;

  /** Retry attempts */
  retries?: number;

  /** Tags */
  tags?: string[];

  /** Start timestamp */
  startAt?: number;

  /** End timestamp */
  endAt?: number;

  /** Max runs */
  maxRuns?: number;

  /** Created timestamp */
  createdAt: number;

  /** Last run timestamp */
  lastRun: number | null;

  /** Next run timestamp */
  nextRun: number;

  /** Run count */
  runCount: number;

  /** Status */
  status: 'active' | 'paused' | 'expired' | 'completed' | 'cancelled';
}

/**
 * Cron job that was triggered and ready to execute
 */
export interface TriggeredJob {
  /** Schedule ID */
  scheduleId: string;

  /** Plugin ID */
  pluginId: string;

  /** Handler path */
  handler: string;

  /** Input data */
  input?: unknown;

  /** Priority */
  priority?: number;

  /** Timeout */
  timeout?: number;

  /** Retries */
  retries?: number;

  /** Tags */
  tags?: string[];

  /** Scheduled run time */
  scheduledAt: number;
}

/**
 * Leader election options
 */
export interface LeaderElectionOptions {
  /** Lease TTL in milliseconds (default: 10000) */
  leaseTTL?: number;

  /** Heartbeat interval in milliseconds (default: 5000) */
  heartbeatInterval?: number;

  /** Redis key for leader election (default: 'kb:cron:leader') */
  leaderKey?: string;
}

/**
 * Leader election metrics
 */
export interface LeaderElectionMetrics {
  /** Is this instance the current leader (0 or 1) */
  'cron.leader.active': 0 | 1;

  /** Number of leadership transitions */
  'cron.leader.change_count': number;

  /** Time until lease expires in milliseconds */
  'cron.leader.lease_remaining_ms': number;

  /** Number of rapid leader changes (flapping) */
  'cron.leader.flap_count': number;

  /** Time taken to acquire lease in milliseconds */
  'cron.leader.lease_acquisition_time_ms': number;
}
