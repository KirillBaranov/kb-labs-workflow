import type { WorkflowRun, JobRun, StepRun } from '@kb-labs/workflow-contracts'
import type { RedisClient } from './redis'
import type { EngineLogger } from './types'
import type { BudgetConfig } from '@kb-labs/workflow-runtime'

export interface CostCalculation {
  stepId: string
  jobId: string
  runId: string
  cost: number
  unit: string
  metadata?: Record<string, unknown>
}

export interface BudgetStatus {
  current: number
  limit?: number
  period: string
  exceeded: boolean
  action: 'warn' | 'fail' | 'cancel'
}

/**
 * Extension point for custom cost calculators
 */
export interface CostCalculator {
  /**
   * Calculate cost for a step execution
   * @param step - Step run information
   * @param job - Job run information
   * @param run - Workflow run information
   * @returns Cost calculation or null if no cost
   */
  calculate(
    step: StepRun,
    job: JobRun,
    run: WorkflowRun,
  ): Promise<CostCalculation | null>
}

/**
 * Simple default cost calculator
 * Uses duration-based calculation with configurable rates
 */
export class DefaultCostCalculator implements CostCalculator {
  constructor(
    private readonly rates: {
      local?: number // cost per second
      sandbox?: number // cost per second
    } = {},
  ) {}

  async calculate(
    step: StepRun,
    job: JobRun,
    run: WorkflowRun,
  ): Promise<CostCalculation | null> {
    if (!step.durationMs || step.durationMs === 0) {
      return null
    }

    const durationSeconds = step.durationMs / 1000
    const rate = job.runsOn === 'sandbox' ? this.rates.sandbox ?? 0.01 : this.rates.local ?? 0.001
    const cost = durationSeconds * rate

    return {
      stepId: step.id,
      jobId: job.id,
      runId: run.id,
      cost,
      unit: 'credits',
      metadata: {
        durationMs: step.durationMs,
        runsOn: job.runsOn,
        rate,
      },
    }
  }
}

/**
 * Budget tracker for workflow runs
 * Tracks costs and enforces budget limits
 */
export class BudgetTracker {
  private readonly calculator: CostCalculator
  private readonly config: BudgetConfig
  private readonly logger: EngineLogger

  constructor(
    config: BudgetConfig,
    logger: EngineLogger,
    calculator?: CostCalculator,
  ) {
    this.config = config
    this.logger = logger
    this.calculator = calculator ?? new DefaultCostCalculator()
  }

  /**
   * Record cost for a step
   */
  async recordCost(
    redisClient: RedisClient,
    calculation: CostCalculation,
  ): Promise<void> {
    const key = this.getBudgetKey(calculation.runId)
    const current = await this.getCurrentCost(redisClient, calculation.runId)
    const newTotal = current + calculation.cost

    // Store in Redis with period-based expiration
    const ttl = this.getPeriodTTL()
    await (redisClient as any).set(
      key,
      JSON.stringify({ total: newTotal, lastUpdated: new Date().toISOString() }),
      'EX',
      ttl,
    )

    this.logger.debug('Cost recorded', {
      runId: calculation.runId,
      stepId: calculation.stepId,
      cost: calculation.cost,
      total: newTotal,
    })

    // Check budget and take action if needed
    await this.checkBudget(redisClient, calculation.runId, newTotal)
  }

  /**
   * Get current cost for a run
   */
  async getCurrentCost(
    redisClient: RedisClient,
    runId: string,
  ): Promise<number> {
    const key = this.getBudgetKey(runId)
    const stored = await redisClient.get(key)
    if (!stored) {
      return 0
    }

    try {
      const data = JSON.parse(stored) as { total: number }
      return data.total ?? 0
    } catch {
      return 0
    }
  }

  /**
   * Get budget status
   */
  async getBudgetStatus(
    redisClient: RedisClient,
    runId: string,
  ): Promise<BudgetStatus> {
    const current = await this.getCurrentCost(redisClient, runId)
    const limit = this.config.limit
    const exceeded = limit !== undefined && current >= limit

    return {
      current,
      limit,
      period: this.config.period,
      exceeded,
      action: this.config.action,
    }
  }

  /**
   * Calculate cost for a step using the configured calculator
   */
  async calculateCost(
    step: StepRun,
    job: JobRun,
    run: WorkflowRun,
  ): Promise<CostCalculation | null> {
    return this.calculator.calculate(step, job, run)
  }

  /**
   * Check budget and take action if exceeded
   */
  private async checkBudget(
    redisClient: RedisClient,
    runId: string,
    currentCost: number,
  ): Promise<void> {
    if (!this.config.limit) {
      return // No limit set
    }

    if (currentCost < this.config.limit) {
      return // Within budget
    }

    const status = await this.getBudgetStatus(redisClient, runId)

    switch (this.config.action) {
      case 'warn':
        this.logger.warn('Budget limit exceeded', {
          runId,
          current: currentCost,
          limit: this.config.limit,
        })
        break

      case 'fail':
        this.logger.error('Budget limit exceeded - failing run', {
          runId,
          current: currentCost,
          limit: this.config.limit,
        })
        // Publish event to fail the run
        // This would be handled by the engine
        break

      case 'cancel':
        this.logger.error('Budget limit exceeded - cancelling run', {
          runId,
          current: currentCost,
          limit: this.config.limit,
        })
        // Publish event to cancel the run
        // This would be handled by the engine
        break
    }
  }

  private getBudgetKey(runId: string): string {
    const period = this.config.period === 'run' ? runId : this.config.period
    return `workflow:budget:${period}:${runId}`
  }

  private getPeriodTTL(): number {
    // TTL in seconds based on period
    switch (this.config.period) {
      case 'run':
        return 7 * 24 * 60 * 60 // 7 days
      case 'day':
        return 24 * 60 * 60 // 24 hours
      case 'week':
        return 7 * 24 * 60 * 60 // 7 days
      case 'month':
        return 30 * 24 * 60 * 60 // 30 days
      default:
        return 7 * 24 * 60 * 60
    }
  }
}

