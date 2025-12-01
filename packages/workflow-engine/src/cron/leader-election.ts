/**
 * @module @kb-labs/workflow-engine/cron/leader-election
 * LeaderElection - Redis lease-based leader election for distributed cron scheduler
 */

import type { RedisClientFactoryResult } from '../redis';
import type { LeaderElectionOptions, LeaderElectionMetrics } from './types';

/**
 * LeaderElection manages distributed leader election using Redis lease pattern
 *
 * Architecture:
 * - Uses Redis SET key value PX ttl NX for atomic leader election
 * - Invariant: heartbeatInterval < leaseTTL/2 (guaranteed lease renewal)
 * - Default: leaseTTL=10000ms, heartbeatInterval=5000ms
 * - Tracks leadership changes and flapping for monitoring
 * - Logs every leadership transition for debugging
 *
 * Algorithm:
 * 1. Try to acquire lease with SET key workerId PX ttl NX
 * 2. If successful → become leader
 * 3. Every heartbeatInterval:
 *    - If leader → extend lease with PEXPIRE
 *    - If not leader → try to acquire again
 * 4. Track metrics and log transitions
 */
export class LeaderElection {
  private readonly client;
  private readonly workerId: string;
  private readonly leaseTTL: number;
  private readonly heartbeatInterval: number;
  private readonly leaderKey: string;

  private isLeader = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private running = false;

  // Metrics
  private leaderChangeCount = 0;
  private flapCount = 0;
  private lastLeaderChange = 0;
  private leaseAcquisitionTimeMs = 0;
  private leaseExpiresAt = 0;

  constructor(
    private readonly redis: RedisClientFactoryResult,
    workerId: string,
    options: LeaderElectionOptions = {}
  ) {
    this.client = redis.client;
    this.workerId = workerId;
    this.leaseTTL = options.leaseTTL ?? 10000; // 10 seconds
    this.heartbeatInterval = options.heartbeatInterval ?? 5000; // 5 seconds
    this.leaderKey = options.leaderKey ?? 'kb:cron:leader';

    // Validate invariant: heartbeatInterval < leaseTTL/2
    if (this.heartbeatInterval >= this.leaseTTL / 2) {
      throw new Error(
        `Invariant violated: heartbeatInterval (${this.heartbeatInterval}ms) must be < leaseTTL/2 (${this.leaseTTL / 2}ms)`
      );
    }
  }

  /**
   * Start leader election process
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;

    // Immediately try to become leader
    await this.tryBecomeLeader();

    // Start heartbeat loop
    this.heartbeatTimer = setInterval(() => {
      this.tryBecomeLeader().catch(err => {
        console.error('[LeaderElection] Heartbeat error:', err);
      });
    }, this.heartbeatInterval);
  }

  /**
   * Stop leader election process
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Release leadership if we're the leader
    if (this.isLeader) {
      await this.releaseLease();
    }
  }

  /**
   * Check if this instance is currently the leader
   */
  getIsLeader(): boolean {
    return this.isLeader;
  }

  /**
   * Get current metrics
   */
  getMetrics(): LeaderElectionMetrics {
    const now = Date.now();
    const leaseRemaining = this.isLeader
      ? Math.max(0, this.leaseExpiresAt - now)
      : 0;

    return {
      'cron.leader.active': this.isLeader ? 1 : 0,
      'cron.leader.change_count': this.leaderChangeCount,
      'cron.leader.lease_remaining_ms': leaseRemaining,
      'cron.leader.flap_count': this.flapCount,
      'cron.leader.lease_acquisition_time_ms': this.leaseAcquisitionTimeMs,
    };
  }

  /**
   * Try to become leader or extend lease
   */
  private async tryBecomeLeader(): Promise<void> {
    const startTime = Date.now();

    try {
      // Try to acquire lease with NX (only if not exists)
      const result = await this.client.set(
        this.leaderKey,
        this.workerId,
        'PX', // milliseconds
        this.leaseTTL,
        'NX' // only if key doesn't exist
      );

      if (result === 'OK') {
        // Successfully acquired lease
        this.leaseAcquisitionTimeMs = Date.now() - startTime;
        this.leaseExpiresAt = Date.now() + this.leaseTTL;

        if (!this.isLeader) {
          // Became leader
          this.transitionToLeader();
        }
      } else {
        // Key exists, check if we're still the leader
        const currentLeader = await this.client.get(this.leaderKey);

        if (currentLeader === this.workerId) {
          // We're still the leader, extend the lease
          const extended = await this.client.pexpire(this.leaderKey, this.leaseTTL);

          if (extended === 1) {
            this.leaseExpiresAt = Date.now() + this.leaseTTL;
          } else {
            // Lease was lost (key expired between GET and PEXPIRE)
            if (this.isLeader) {
              this.transitionFromLeader();
            }
          }
        } else {
          // Another instance is the leader
          if (this.isLeader) {
            this.transitionFromLeader();
          }
        }
      }
    } catch (error) {
      console.error('[LeaderElection] Error in tryBecomeLeader:', error);

      // On error, assume we lost leadership
      if (this.isLeader) {
        this.transitionFromLeader();
      }
    }
  }

  /**
   * Transition to leader state
   */
  private transitionToLeader(): void {
    const now = Date.now();

    this.isLeader = true;
    this.leaderChangeCount++;

    // Detect flapping (leader change within 30 seconds)
    if (now - this.lastLeaderChange < 30000) {
      this.flapCount++;
    }

    this.lastLeaderChange = now;

    console.log(
      `[LeaderElection] ${this.workerId} became LEADER (change #${this.leaderChangeCount}, flap #${this.flapCount})`
    );
  }

  /**
   * Transition from leader state
   */
  private transitionFromLeader(): void {
    const now = Date.now();

    this.isLeader = false;
    this.leaderChangeCount++;

    // Detect flapping
    if (now - this.lastLeaderChange < 30000) {
      this.flapCount++;
    }

    this.lastLeaderChange = now;

    console.log(
      `[LeaderElection] ${this.workerId} lost LEADER status (change #${this.leaderChangeCount}, flap #${this.flapCount})`
    );
  }

  /**
   * Release lease (called on stop)
   */
  private async releaseLease(): Promise<void> {
    try {
      // Only delete if we're still the leader
      const currentLeader = await this.client.get(this.leaderKey);

      if (currentLeader === this.workerId) {
        await this.client.del(this.leaderKey);
        console.log(`[LeaderElection] ${this.workerId} released leader lease`);
      }
    } catch (error) {
      console.error('[LeaderElection] Error releasing lease:', error);
    }

    this.isLeader = false;
  }
}
