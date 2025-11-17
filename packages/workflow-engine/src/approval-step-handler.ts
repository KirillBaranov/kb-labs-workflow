import type { StepSpec } from '@kb-labs/workflow-contracts'
import type { StepExecutionRequest, StepExecutionResult } from '@kb-labs/workflow-runtime'
import type { RedisClient } from './redis'
import type { EngineLogger } from './types'

export interface ApprovalRequest {
  runId: string
  jobId: string
  stepId: string
  message: string
  timeout: number // seconds
  approvers?: string[]
  createdAt: string
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  approvedBy?: string
  approvedAt?: string
  rejectedBy?: string
  rejectedAt?: string
}

export interface ApprovalStepHandlerOptions {
  redisClient: RedisClient
  logger: EngineLogger
  defaultTimeout?: number // seconds, default: 3600 (1 hour)
}

export class ApprovalStepHandler {
  private readonly redisClient: RedisClient
  private readonly logger: EngineLogger
  private readonly defaultTimeout: number

  constructor(options: ApprovalStepHandlerOptions) {
    this.redisClient = options.redisClient
    this.logger = options.logger
    this.defaultTimeout = options.defaultTimeout ?? 3600
  }

  private getApprovalKey(runId: string, stepId: string): string {
    return `workflow:approval:${runId}:${stepId}`
  }

  async createApprovalRequest(
    request: StepExecutionRequest,
  ): Promise<ApprovalRequest> {
    const { spec, context } = request
    const withBlock = (spec.with ?? {}) as Record<string, unknown>

    const message =
      (typeof withBlock.message === 'string' ? withBlock.message : null) ??
      `Approval required for step "${spec.name}"`

    const timeout =
      typeof withBlock.timeout === 'number'
        ? withBlock.timeout
        : typeof withBlock.timeout === 'string'
          ? parseInt(withBlock.timeout, 10)
          : this.defaultTimeout

    const approvers =
      Array.isArray(withBlock.approvers)
        ? (withBlock.approvers as string[])
        : typeof withBlock.approvers === 'string'
          ? [withBlock.approvers]
          : undefined

    const approvalRequest: ApprovalRequest = {
      runId: context.runId,
      jobId: context.jobId,
      stepId: context.stepId,
      message,
      timeout,
      approvers,
      createdAt: new Date().toISOString(),
      status: 'pending',
    }

    const key = this.getApprovalKey(context.runId, context.stepId)
    // Use set with EX option for expiration
    await (this.redisClient as any).set(key, JSON.stringify(approvalRequest), 'EX', timeout)

    this.logger.info('Approval request created', {
      runId: context.runId,
      stepId: context.stepId,
      message,
      timeout,
    })

    return approvalRequest
  }

  async waitForApproval(
    request: StepExecutionRequest,
    approvalRequest: ApprovalRequest,
  ): Promise<StepExecutionResult> {
    const { context } = request
    const key = this.getApprovalKey(context.runId, context.stepId)

    // Poll for approval status
    const pollInterval = 1000 // 1 second
    const startTime = Date.now()
    const timeoutMs = approvalRequest.timeout * 1000

    while (Date.now() - startTime < timeoutMs) {
      // Check if step was cancelled
      if (request.signal?.aborted) {
        await this.redisClient.del(key)
        return {
          status: 'cancelled',
          error: {
            message: 'Approval step cancelled',
            code: 'STEP_CANCELLED',
          },
        }
      }

      // Check approval status
      const stored = await this.redisClient.get(key)
      if (!stored) {
        // Timeout or deleted
        return {
          status: 'failed',
          error: {
            message: `Approval request timed out after ${approvalRequest.timeout} seconds`,
            code: 'APPROVAL_TIMEOUT',
            details: {
              timeout: approvalRequest.timeout,
            },
          },
        }
      }

      const current: ApprovalRequest = JSON.parse(stored)
      if (current.status === 'approved') {
        await this.redisClient.del(key)
        this.logger.info('Approval granted', {
          runId: context.runId,
          stepId: context.stepId,
          approvedBy: current.approvedBy,
        })
        return {
          status: 'success',
          outputs: {
            approvedBy: current.approvedBy,
            approvedAt: current.approvedAt,
          },
        }
      }

      if (current.status === 'rejected') {
        await this.redisClient.del(key)
        this.logger.info('Approval rejected', {
          runId: context.runId,
          stepId: context.stepId,
          rejectedBy: current.rejectedBy,
        })
        return {
          status: 'failed',
          error: {
            message: `Approval rejected by ${current.rejectedBy ?? 'unknown'}`,
            code: 'APPROVAL_REJECTED',
            details: {
              rejectedBy: current.rejectedBy,
              rejectedAt: current.rejectedAt,
            },
          },
        }
      }

      // Still pending, wait and poll again
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    // Timeout
    await this.redisClient.del(key)
    return {
      status: 'failed',
      error: {
        message: `Approval request timed out after ${approvalRequest.timeout} seconds`,
        code: 'APPROVAL_TIMEOUT',
        details: {
          timeout: approvalRequest.timeout,
        },
      },
    }
  }

  async approve(
    runId: string,
    stepId: string,
    approvedBy: string,
  ): Promise<boolean> {
    const key = this.getApprovalKey(runId, stepId)
    const stored = await this.redisClient.get(key)
    if (!stored) {
      return false
    }

    const request: ApprovalRequest = JSON.parse(stored)
    if (request.status !== 'pending') {
      return false
    }

    request.status = 'approved'
    request.approvedBy = approvedBy
    request.approvedAt = new Date().toISOString()

    await (this.redisClient as any).set(key, JSON.stringify(request), 'EX', request.timeout)

    this.logger.info('Approval granted', { runId, stepId, approvedBy })
    return true
  }

  async reject(
    runId: string,
    stepId: string,
    rejectedBy: string,
  ): Promise<boolean> {
    const key = this.getApprovalKey(runId, stepId)
    const stored = await this.redisClient.get(key)
    if (!stored) {
      return false
    }

    const request: ApprovalRequest = JSON.parse(stored)
    if (request.status !== 'pending') {
      return false
    }

    request.status = 'rejected'
    request.rejectedBy = rejectedBy
    request.rejectedAt = new Date().toISOString()

    await (this.redisClient as any).set(key, JSON.stringify(request), 'EX', request.timeout)

    this.logger.info('Approval rejected', { runId, stepId, rejectedBy })
    return true
  }

  async getApprovalRequest(
    runId: string,
    stepId: string,
  ): Promise<ApprovalRequest | null> {
    const key = this.getApprovalKey(runId, stepId)
    const stored = await this.redisClient.get(key)
    if (!stored) {
      return null
    }
    return JSON.parse(stored) as ApprovalRequest
  }
}

