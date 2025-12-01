import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  LocalRunner,
  SandboxRunner,
  type StepExecutionResult,
  type StepExecutionRequest,
  type RuntimeLogger,
  type PluginCommandResolution,
} from '@kb-labs/workflow-runtime'
import { createFileSystemArtifactClient, type ArtifactClient } from '@kb-labs/workflow-artifacts'
import type {
  StepRun,
  StepSpec,
  JobRun,
  WorkflowRun,
  ExpressionContext,
} from '@kb-labs/workflow-contracts'
import {
  evaluateExpression,
  interpolateString,
  parseWorkflowUses,
} from '@kb-labs/workflow-contracts'
import { EVENT_NAMES, type StepState } from '@kb-labs/workflow-constants'
import type { WorkflowRegistry } from '@kb-labs/workflow-runtime'
import type { EngineLogger } from './types'
import type { PluginCommandResolver } from './plugin-command-resolver'
import type { EventBusBridge } from './event-bus'
import type { JobHandler, JobHandlerResult, JobExecutionContext } from './job-runner'
import type { WorkflowEngine } from './engine'
import {
  createDefaultSecretProvider,
  type SecretProvider,
} from './secrets'
import {
  combineSignals,
  createTimeoutSignal,
  getAbortReason,
  signalReason,
} from './abort-utils'
import {
  createPluginContext,
  createNoopAnalyticsEmitter,
  createNoopEventBridge,
  JobRunnerPresenter,
  type JobRunnerPresenterEvent,
  type PluginContext,
  type PluginEventEnvelope,
  OperationTracker,
} from '@kb-labs/plugin-runtime'
import type { RedisEventBridge } from './events/redis-event-bridge'
import { WorkflowLogStreamer } from './log-streamer'
import type { RedisClient } from './redis'
import { ApprovalStepHandler } from './approval-step-handler'
import { ArtifactMerger } from './artifact-merger'
import { BudgetTracker } from './budget-tracker'
import type { StateStore } from './state-store'
import type { BudgetConfig } from '@kb-labs/workflow-runtime'
import { createOutput } from '@kb-labs/core-sys/output'

export interface WorkflowJobHandlerOptions {
  artifactsRoot?: string
  defaultWorkspace?: string
  secretProvider?: SecretProvider
  eventsBridge?: RedisEventBridge
  redisClient?: RedisClient
  workflowRegistry?: WorkflowRegistry
  engine?: WorkflowEngine
  maxWorkflowDepth?: number
  workflowSpec?: import('@kb-labs/workflow-contracts').WorkflowSpec
  stateStore?: StateStore
  restoredStepOutputs?: Record<string, Record<string, unknown>>
  restoredEnv?: Record<string, string>
  budgetConfig?: BudgetConfig
}

interface StepLogPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  meta?: Record<string, unknown>
}

interface StepOutcome {
  status: Extract<StepState, 'success' | 'failed' | 'cancelled'>
  result: StepExecutionResult
}

const DEFAULT_ARTIFACTS_ROOT = path.resolve(process.cwd(), '.kb/workflows/artifacts')
const DEFAULT_WORKSPACE = process.cwd()
const PRESENTER_EVENT_VERSION = '1.0.0'

export class WorkflowJobHandler implements JobHandler {
  private readonly logger: EngineLogger
  private readonly events: EventBusBridge
  private readonly resolver: PluginCommandResolver
  private readonly options: WorkflowJobHandlerOptions
  private readonly localRunner: LocalRunner
  private readonly sandboxRunner: SandboxRunner
  private readonly secretProvider: SecretProvider
  private readonly redisEvents?: RedisEventBridge
  private readonly logStreamer?: WorkflowLogStreamer
  private readonly workflowRegistry?: WorkflowRegistry
  private readonly engine?: WorkflowEngine
  private readonly maxDepth: number
  private readonly stepOutputs = new Map<string, Record<string, unknown>>()
  private readonly workflowSpec?: import('@kb-labs/workflow-contracts').WorkflowSpec
  private readonly approvalHandler?: ApprovalStepHandler
  private readonly budgetTracker?: BudgetTracker

  /**
   * Get current step outputs map (for snapshot creation)
   */
  getStepOutputs(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {}
    for (const [stepId, outputs] of this.stepOutputs.entries()) {
      result[stepId] = outputs
    }
    return result
  }

  /**
   * Restore step outputs from snapshot (for replay)
   */
  restoreStepOutputs(outputs: Record<string, Record<string, unknown>>): void {
    this.stepOutputs.clear()
    for (const [stepId, stepOutputs] of Object.entries(outputs)) {
      this.stepOutputs.set(stepId, stepOutputs)
    }
  }

  constructor(
    deps: {
      logger: EngineLogger
      events: EventBusBridge
      resolver: PluginCommandResolver
      options?: WorkflowJobHandlerOptions
    },
  ) {
    this.logger = deps.logger
    this.events = deps.events
    this.resolver = deps.resolver
    this.options = deps.options ?? {}
    this.workflowRegistry = this.options.workflowRegistry
    this.engine = this.options.engine
    this.maxDepth = this.options.maxWorkflowDepth ?? 2
    this.workflowSpec = this.options.workflowSpec
    this.localRunner = new LocalRunner()
    this.sandboxRunner = new SandboxRunner({
      resolveCommand: async (commandRef, request) => {
        const resolution = await this.resolver.resolve(commandRef)
        if (isPluginStep(request.spec)) {
          const { pluginContext, adapterContext } = this.createPluginExecutionContext(request, resolution)
          resolution.contextOverrides = {
            ...(resolution.contextOverrides ?? {}),
            pluginContext,
            adapterContext,
            adapterMeta: {
              type: 'cli',
              signature: 'command',
              version: '1.0.0',
            },
          }
        }
        return resolution
      },
    })
    this.secretProvider =
      this.options.secretProvider ?? createDefaultSecretProvider()
    this.redisEvents = this.options.eventsBridge
    if (this.redisEvents && this.options.redisClient) {
      this.logStreamer = new WorkflowLogStreamer(
        this.redisEvents,
        this.options.redisClient,
        this.logger,
      )
    }
    if (this.options.redisClient) {
      this.approvalHandler = new ApprovalStepHandler({
        redisClient: this.options.redisClient,
        logger: this.logger,
      })
    }

    // Restore step outputs if provided (for replay)
    if (this.options.restoredStepOutputs) {
      this.restoreStepOutputs(this.options.restoredStepOutputs)
    }

    // Initialize budget tracker if configured
    if (this.options.budgetConfig?.enabled && this.options.redisClient) {
      this.budgetTracker = new BudgetTracker(
        this.options.budgetConfig,
        this.logger,
      )
    }
  }

  private buildExpressionContext(
    run: WorkflowRun,
    job: JobRun,
    currentStepIndex: number,
  ): ExpressionContext {
    // Steps до текущего индекса
    const stepsContext: Record<string, { outputs: Record<string, unknown> }> =
      {}
    for (const step of job.steps.slice(0, currentStepIndex)) {
      if (step.spec.id) {
        stepsContext[step.spec.id] = {
          outputs: this.stepOutputs.get(step.spec.id) ?? {},
        }
      }
    }

    return {
      env: mergeEnv(run.env, job.env),
      trigger: {
        type: run.trigger.type,
        actor: run.trigger.actor,
        payload: run.trigger.payload,
      },
      steps: stepsContext,
    }
  }

  private async shouldExecuteStep(
    step: StepRun,
    context: ExpressionContext,
  ): Promise<{ execute: boolean; reason?: string }> {
    const ifExpr = step.spec.if
    if (!ifExpr) {
      return { execute: true }
    }

    try {
      const result = evaluateExpression(ifExpr, context)
      if (result) {
        return { execute: true }
      }
      return { execute: false, reason: `condition not met: ${ifExpr}` }
    } catch (error) {
      // Expression evaluation failed
      const message =
        error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid if expression "${ifExpr}": ${message}`)
    }
  }

  private interpolateWith(
    withParams: Record<string, unknown> | undefined,
    context: ExpressionContext,
  ): Record<string, unknown> {
    if (!withParams) {
      return {}
    }

    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(withParams)) {
      if (typeof value === 'string') {
        result[key] = interpolateString(value, context)
      } else {
        result[key] = value
      }
    }
    return result
  }

  private async executeHooks(
    context: JobExecutionContext,
    hooks: StepSpec[],
    phase: string,
  ): Promise<void> {
    for (const hookSpec of hooks) {
      // Guard: hooks не могут иметь вложенные hooks
      if ('hooks' in hookSpec && hookSpec.hooks) {
        this.logger.warn('Hooks cannot contain nested hooks, ignoring', {
          phase,
          stepName: hookSpec.name,
        })
        continue
      }

      // Execute hook как обычный step (но не сохраняем в job.steps)
      this.logger.debug(`Executing ${phase} hook: ${hookSpec.name}`)

      // Build expression context for hook
      const exprContext = this.buildExpressionContext(
        context.run,
        context.job,
        -1, // hooks don't have step index
      )

      // Check conditional execution
      if (hookSpec.if) {
        const should = await this.shouldExecuteStep(
          { spec: hookSpec } as StepRun,
          exprContext,
        )
        if (!should.execute) {
          this.logger.debug(`Hook "${hookSpec.name}" skipped: ${should.reason}`)
          continue
        }
      }

      // Interpolate with parameters
      const interpolatedWith = this.interpolateWith(hookSpec.with, exprContext)
      const hookSpecWithInterpolated = {
        ...hookSpec,
        with: interpolatedWith,
      }

      // Create a temporary step run for hook execution
      const hookStepRun: StepRun = {
        id: `hook-${phase}-${hookSpec.name}-${Date.now()}`,
        runId: context.run.id,
        jobId: context.job.id,
        name: hookSpec.name,
        index: -1,
        status: 'running',
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        spec: hookSpecWithInterpolated,
        attempt: 1,
      }

      try {
        // Execute hook step
        const outcome = await this.executeStep(context, {
          run: context.run,
          job: context.job,
          step: hookStepRun,
          artifacts: this.createArtifactClient(context),
        })

        if (outcome.status === 'failed') {
          this.logger.warn(`Hook "${hookSpec.name}" failed`, {
            phase,
            error: outcome.result.status === 'success' ? undefined : outcome.result.error,
          })
          // Hooks failures don't fail the job, but we log them
        } else {
          this.logger.debug(`Hook "${hookSpec.name}" completed successfully`, { phase })
        }
      } catch (error) {
        this.logger.warn(`Hook "${hookSpec.name}" threw an error`, {
          phase,
          error: error instanceof Error ? error.message : String(error),
        })
        // Hooks errors don't fail the job
      }
    }
  }

  async execute(context: JobExecutionContext): Promise<JobHandlerResult> {
    const artifacts = this.createArtifactClient(context)
    const errors: Array<{ stepId: string; error: JobHandlerResult['error'] }> = []

    let currentJob: JobRun = context.job
    let currentRun: WorkflowRun = context.run

    // Merge artifacts from other runs if configured
    const jobSpecForMerge = this.workflowSpec?.jobs?.[currentJob.jobName]
    const mergeConfig = (jobSpecForMerge?.artifacts as any)?.merge
    if (mergeConfig && this.options.stateStore) {
      try {
        const merger = new ArtifactMerger({
          stateStore: this.options.stateStore,
          logger: this.logger,
          artifactsRoot: this.options.artifactsRoot ?? DEFAULT_ARTIFACTS_ROOT,
        })
        await merger.mergeArtifacts(
          mergeConfig,
          artifacts,
          context.run.id,
        )
      } catch (error) {
        this.logger.warn('Failed to merge artifacts', {
          runId: context.run.id,
          jobId: context.job.id,
          error: error instanceof Error ? error.message : String(error),
        })
        // Continue execution even if merge fails
      }
    }

    await this.ensureConsumedArtifacts(context, artifacts)

    // 1. Execute pre hooks
    const jobSpec = this.workflowSpec?.jobs?.[currentJob.jobName]
    if (jobSpec?.hooks?.pre) {
      await this.executeHooks(context, jobSpec.hooks.pre, 'pre')
    }

    // 2. Execute main steps
    let mainResult: JobHandlerResult
    try {
      mainResult = await this.executeMainSteps(context, artifacts)
    } catch (error) {
      // Execute onFailure hooks
      if (jobSpec?.hooks?.onFailure) {
        await this.executeHooks(context, jobSpec.hooks.onFailure, 'onFailure')
      }
      throw error
    }

    // 3. Execute success/failure hooks
    if (mainResult.status === 'success' && jobSpec?.hooks?.onSuccess) {
      await this.executeHooks(context, jobSpec.hooks.onSuccess, 'onSuccess')
    } else if (mainResult.status === 'failed' && jobSpec?.hooks?.onFailure) {
      await this.executeHooks(context, jobSpec.hooks.onFailure, 'onFailure')
    }

    // 4. Execute post hooks (always)
    if (jobSpec?.hooks?.post) {
      await this.executeHooks(context, jobSpec.hooks.post, 'post')
    }

    return mainResult
  }

  private async executeMainSteps(
    context: JobExecutionContext,
    artifacts: ArtifactClient,
  ): Promise<JobHandlerResult> {
    const errors: Array<{ stepId: string; error: JobHandlerResult['error'] }> = []

    let currentJob: JobRun = context.job
    let currentRun: WorkflowRun = context.run

    const orderedSteps = [...currentJob.steps].sort((a, b) => a.index - b.index)

    for (const step of orderedSteps) {
      if (context.signal.aborted) {
        return this.handleAbort(context, step)
      }

      await context.heartbeat()

      // Check conditional execution
      const exprContext = this.buildExpressionContext(
        currentRun,
        currentJob,
        step.index,
      )
      const should = await this.shouldExecuteStep(step, exprContext)

      if (!should.execute) {
        // Skip step
        await context.state.updateStep(step.id, (draft) => {
          draft.status = 'skipped'
          draft.skipReason = should.reason
          return draft
        })
        this.emitLog(context, step.id, {
          level: 'info',
          message: `Step "${step.name}" skipped: ${should.reason}`,
        })
        continue
      }

      const updateToRunning = await context.state.updateStep(
        step.id,
        (draft) => {
          const now = new Date().toISOString()
          draft.status = 'running'
          draft.startedAt = draft.startedAt ?? now
          draft.durationMs = undefined
          draft.error = undefined
          draft.outputs = undefined
          draft.attempt = (draft.attempt ?? 0) + 1
          return draft
        },
      )

      if (!updateToRunning) {
        this.logger.warn('Failed to transition step to running state', {
          runId: currentRun.id,
          jobId: currentJob.id,
          stepId: step.id,
        })
        continue
      }

      this.emitLog(context, step.id, {
        level: 'info',
        message: `Step "${step.name}" started`,
        meta: { attempt: updateToRunning.attempt },
      })

      // Interpolate with parameters
      const interpolatedWith = this.interpolateWith(
        updateToRunning.spec.with,
        exprContext,
      )
      const stepSpecWithInterpolated = {
        ...updateToRunning.spec,
        with: interpolatedWith,
      }

      const outcome = await this.executeStep(context, {
        run: currentRun,
        job: currentJob,
        step: { ...updateToRunning, spec: stepSpecWithInterpolated },
        artifacts,
      })

      await context.heartbeat()

      const finishedAt = new Date().toISOString()

      let updatedStep: StepRun | undefined
      await context.state.updateStep(step.id, (draft) => {
        draft.status = outcome.status
        draft.finishedAt = finishedAt
        draft.durationMs = computeDurationMs(draft.startedAt ?? draft.queuedAt, finishedAt)
        if (outcome.result.status === 'success') {
          draft.outputs = outcome.result.outputs
          draft.error = undefined
          // Store outputs in stepOutputs map for context
          if (updateToRunning.spec.id && outcome.result.outputs) {
            this.stepOutputs.set(updateToRunning.spec.id, outcome.result.outputs)
          }
        } else {
          draft.outputs = undefined
          if (outcome.result.error) {
            draft.error = outcome.result.error
          }
        }
        updatedStep = draft
        return draft
      })

      // Record cost if budget tracking is enabled
      if (
        this.budgetTracker &&
        this.options.redisClient &&
        updatedStep &&
        updatedStep.durationMs
      ) {
        try {
          const calculation = await this.budgetTracker.calculateCost(
            updatedStep,
            currentJob,
            currentRun,
          )
          if (calculation) {
            await this.budgetTracker.recordCost(
              this.options.redisClient,
              calculation,
            )
          }
        } catch (error) {
          // Don't fail the step if budget tracking fails
          this.logger.warn('Failed to record budget cost', {
            runId: currentRun.id,
            stepId: updatedStep.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      const refreshed = await context.state.reload()
      if (refreshed) {
        currentRun = refreshed.run
        currentJob = refreshed.job
      }

      if (outcome.status === 'failed') {
        const stepError =
          outcome.result.status === 'success'
            ? undefined
            : outcome.result.error
        errors.push({
          stepId: step.id,
          error: stepError ?? {
            message: `Step ${step.name} failed`,
            code: 'STEP_FAILED',
            details: { stepId: step.id },
          },
        })

        this.emitLog(context, step.id, {
          level: 'error',
          message: `Step "${step.name}" failed`,
          meta: stepError ?? { reason: 'unknown' },
        })

        if (updateToRunning.continueOnError) {
          this.logger.warn('Continuing workflow despite step failure (continueOnError=true)', {
            runId: currentRun.id,
            jobId: currentJob.id,
            stepId: step.id,
          })
          continue
        }

        return {
          status: 'failed',
          error: errors[errors.length - 1]?.error,
        }
      }

      if (outcome.status === 'cancelled') {
        this.emitLog(context, step.id, {
          level: 'warn',
          message: `Step "${step.name}" cancelled`,
        })
        const cancellationError =
          outcome.result.status === 'success'
            ? undefined
            : outcome.result.error
        return {
          status: 'cancelled',
          error: cancellationError ?? {
            message: `Step ${step.name} cancelled`,
          },
        }
      }

      this.emitLog(context, step.id, {
        level: 'info',
        message: `Step "${step.name}" completed`,
      })
    }

    if (errors.length > 0) {
      return {
        status: 'failed',
        error: errors[errors.length - 1]?.error,
      }
    }

    await this.captureProducedArtifacts(context, artifacts)

    if (errors.length > 0) {
      return {
        status: 'failed',
        error: errors[errors.length - 1]?.error,
      }
    }

    return {
      status: 'success',
    }
  }

  private async executeStep(
    context: JobExecutionContext,
    runtime: {
      run: WorkflowRun
      job: JobRun
      step: StepRun
      artifacts: ArtifactClient
    },
  ): Promise<StepOutcome> {
    const spec = this.findStepSpec(runtime.job, runtime.step)
    if (!spec) {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message: `Step specification not found for ${runtime.step.name}`,
            code: 'STEP_SPEC_NOT_FOUND',
          },
        },
      }
    }

    // Publish step start
    if (this.logStreamer) {
      await this.logStreamer
        .publishStepStart(
          runtime.run.id,
          runtime.job.id,
          runtime.step.id,
          runtime.step.name,
        )
        .catch((error) => {
          this.logger.warn('Failed to publish step start', {
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }

    // Check if workflow step
    if (spec.uses?.startsWith('workflow:')) {
      const outcome = await this.executeWorkflowStep(context, runtime)
      // Publish step end
      if (this.logStreamer) {
        await this.logStreamer
          .publishStepEnd(
            runtime.run.id,
            runtime.job.id,
            runtime.step.id,
            outcome.status,
          )
          .catch((error) => {
            this.logger.warn('Failed to publish step end', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
      }
      return outcome
    }

    // Check if approval step
    if (spec.uses === 'builtin:approval') {
      if (!this.approvalHandler) {
        return {
          status: 'failed',
          result: {
            status: 'failed',
            error: {
              message: 'Approval handler not available (Redis client required)',
              code: 'APPROVAL_HANDLER_UNAVAILABLE',
            },
          },
        }
      }

      const executionRequest = {
        spec,
        context: {
          runId: runtime.run.id,
          jobId: runtime.job.id,
          stepId: runtime.step.id,
          attempt: runtime.step.attempt,
          env: mergeEnv(runtime.run.env, runtime.job.env, spec.env),
          secrets: await this.resolveSecrets(runtime.run, runtime.job, spec),
          artifacts: runtime.artifacts,
          logger: this.createStepLogger(context, runtime),
        },
        workspace: resolveWorkspace(spec, this.options.defaultWorkspace ?? DEFAULT_WORKSPACE),
        signal: context.signal,
      }

      try {
        const approvalRequest = await this.approvalHandler.createApprovalRequest(executionRequest)
        this.logger.info('Waiting for approval', {
          runId: runtime.run.id,
          stepId: runtime.step.id,
          message: approvalRequest.message,
        })

        const result = await this.approvalHandler.waitForApproval(
          executionRequest,
          approvalRequest,
        )

        const outcome: StepOutcome = {
          status: result.status,
          result,
        }

        // Publish step end
        if (this.logStreamer) {
          await this.logStreamer
            .publishStepEnd(
              runtime.run.id,
              runtime.job.id,
              runtime.step.id,
              outcome.status,
            )
            .catch((error) => {
              this.logger.warn('Failed to publish step end', {
                error: error instanceof Error ? error.message : String(error),
              })
            })
        }

        return outcome
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Approval step failed'
        const outcome: StepOutcome = {
          status: 'failed',
          result: {
            status: 'failed',
            error: {
              message,
              code: 'APPROVAL_STEP_ERROR',
            },
          },
        }
        // Publish step end
        if (this.logStreamer) {
          await this.logStreamer
            .publishStepEnd(
              runtime.run.id,
              runtime.job.id,
              runtime.step.id,
              outcome.status,
            )
            .catch((error) => {
              this.logger.warn('Failed to publish step end', {
                error: error instanceof Error ? error.message : String(error),
              })
            })
        }
        return outcome
      }
    }

    const secrets = await this.resolveSecrets(runtime.run, runtime.job, spec)

    const timeoutHandle =
      typeof spec.timeoutMs === 'number' && spec.timeoutMs > 0
        ? createTimeoutSignal(
            spec.timeoutMs,
            () => new StepTimeoutError(runtime.step.id, spec.timeoutMs ?? 0),
          )
        : null

    const composite = combineSignals(
      timeoutHandle ? [context.signal, timeoutHandle.signal] : [context.signal],
    )
    const stepSignal = composite.signal

    try {
      const executionRequest = {
        spec,
        context: {
          runId: runtime.run.id,
          jobId: runtime.job.id,
          stepId: runtime.step.id,
          attempt: runtime.step.attempt,
          env: mergeEnv(runtime.run.env, runtime.job.env, spec.env),
          secrets,
          artifacts: runtime.artifacts,
        logger: this.createStepLogger(context, runtime),
        },
        workspace: resolveWorkspace(spec, this.options.defaultWorkspace ?? DEFAULT_WORKSPACE),
        signal: stepSignal,
      }

      let result: StepExecutionResult
      try {
        if (isPluginStep(spec)) {
          result = await this.sandboxRunner.execute(executionRequest)
        } else {
          result = await this.localRunner.execute(executionRequest)
        }
      } catch (error) {
        if (stepSignal.aborted) {
          const reason = getAbortReason(stepSignal)
          if (reason instanceof StepTimeoutError) {
            return buildStepTimeoutOutcome(reason)
          }
          return {
            status: 'cancelled',
            result: {
              status: 'cancelled',
              error: {
                message:
                  signalReason(stepSignal) ?? 'Step cancelled during execution',
                code: 'STEP_CANCELLED',
              },
            },
          }
        }

        const message = error instanceof Error ? error.message : 'Step execution failed'
        const outcome: StepOutcome = {
          status: 'failed',
          result: {
            status: 'failed',
            error: {
              message,
              code: 'STEP_EXECUTION_CRASHED',
            },
          },
        }
        // Publish step end
        if (this.logStreamer) {
          await this.logStreamer
            .publishStepEnd(
              runtime.run.id,
              runtime.job.id,
              runtime.step.id,
              outcome.status,
            )
            .catch((error) => {
              this.logger.warn('Failed to publish step end', {
                error: error instanceof Error ? error.message : String(error),
              })
            })
        }
        return outcome
      }

      const abortReason = getAbortReason(stepSignal)
      if (abortReason instanceof StepTimeoutError) {
        const outcome = buildStepTimeoutOutcome(abortReason)
        // Publish step end
        if (this.logStreamer) {
          await this.logStreamer
            .publishStepEnd(
              runtime.run.id,
              runtime.job.id,
              runtime.step.id,
              outcome.status,
            )
            .catch((error) => {
              this.logger.warn('Failed to publish step end', {
                error: error instanceof Error ? error.message : String(error),
              })
            })
        }
        return outcome
      }

      const outcome: StepOutcome = {
        status: result.status,
        result,
      }

      // Publish step end
      if (this.logStreamer) {
        await this.logStreamer
          .publishStepEnd(
            runtime.run.id,
            runtime.job.id,
            runtime.step.id,
            outcome.status,
          )
          .catch((error) => {
            this.logger.warn('Failed to publish step end', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
      }

      return outcome
    } finally {
      timeoutHandle?.cancel()
      composite.dispose()
    }
  }

  private async executeWorkflowStep(
    context: JobExecutionContext,
    runtime: {
      run: WorkflowRun
      job: JobRun
      step: StepRun
    },
  ): Promise<StepOutcome> {
    if (!this.workflowRegistry || !this.engine) {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message:
              'Workflow registry not configured for nested workflows',
            code: 'WORKFLOW_REGISTRY_NOT_CONFIGURED',
          },
        },
      }
    }

    const spec = runtime.step.spec
    const workflowInvocation = parseWorkflowUses(spec.uses ?? '')
    if (!workflowInvocation) {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message: 'Invalid workflow uses',
            code: 'INVALID_WORKFLOW_USES',
          },
        },
      }
    }

    const workflowId = workflowInvocation.workflowId

    // Resolve workflow
    const resolved = await this.workflowRegistry.resolve(workflowId)
    if (!resolved) {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message: `Workflow '${workflowId}' not found in registry`,
            code: 'WORKFLOW_NOT_FOUND',
            details: { workflowId },
          },
        },
      }
    }

    // Depth guard
    const currentDepth = runtime.run.metadata?.workflowDepth ?? 0
    if (currentDepth + 1 > this.maxDepth) {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message: `Maximum workflow depth ${this.maxDepth} exceeded`,
            code: 'WORKFLOW_DEPTH_EXCEEDED',
            details: { maxDepth: this.maxDepth, currentDepth },
          },
        },
      }
    }

    // Check mode
    const withParams = spec.with ?? {}
    const mode = (withParams.mode as string) ?? workflowInvocation.mode ?? 'wait'
    if (mode === 'fire-and-forget') {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message: 'fire-and-forget mode not supported in MVP',
            code: 'UNSUPPORTED_MODE',
            details: { mode },
          },
        },
      }
    }

    // Create child run
    const inheritEnv =
      (withParams.inheritEnv as boolean) ??
      workflowInvocation.inheritEnv ??
      true

    const childEnv = inheritEnv
      ? mergeEnv(runtime.run.env, runtime.job.env)
      : {}

    // Merge inputs into env
    const inputs = (withParams.inputs as Record<string, unknown>) ??
      workflowInvocation.inputs ??
      {}
    for (const [key, value] of Object.entries(inputs)) {
      childEnv[key] = String(value)
    }

    let childRun: WorkflowRun
    try {
      childRun = await this.engine.runFromFile(resolved.filePath, {
        trigger: {
          type: 'workflow',
          parentRunId: runtime.run.id,
          parentJobId: runtime.job.id,
          parentStepId: runtime.step.id,
          invokedByWorkflowId: runtime.run.metadata?.workflowId,
        },
        env: childEnv,
        metadata: {
          workflowId: resolved.id,
          workflowDepth: currentDepth + 1,
          parentRunId: runtime.run.id,
          parentJobId: runtime.job.id,
          parentStepId: runtime.step.id,
        },
        // НЕ передаём idempotencyKey и concurrencyGroup
      })
    } catch (error) {
      return {
        status: 'failed',
        result: {
          status: 'failed',
          error: {
            message:
              error instanceof Error
                ? error.message
                : 'Failed to create child workflow run',
            code: 'WORKFLOW_SPAWN_ERROR',
            details: { workflowId },
          },
        },
      }
    }

    // Wait for completion (polling)
    const pollInterval = 1000 // 1s
    let childStatus: WorkflowRun | null

    while (true) {
      // Check parent abort
      if (context.signal.aborted) {
        // Cancel child
        await this.engine.cancelRun(childRun.id)
        return {
          status: 'cancelled',
          result: {
            status: 'cancelled',
            error: {
              message: 'Parent workflow cancelled, child workflow aborted',
              code: 'PARENT_CANCELLED',
              details: { childRunId: childRun.id },
            },
          },
        }
      }

      childStatus = await this.engine.getRun(childRun.id)
      if (!childStatus) {
        return {
          status: 'failed',
          result: {
            status: 'failed',
            error: {
              message: 'Child workflow run not found',
              code: 'CHILD_RUN_NOT_FOUND',
              details: { childRunId: childRun.id },
            },
          },
        }
      }

      // Terminal states
      if (['success', 'failed', 'cancelled'].includes(childStatus.status)) {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    }

    // Return result
    if (childStatus.status === 'success') {
      return {
        status: 'success',
        result: {
          status: 'success',
          outputs: {
            childRunId: childRun.id,
            childResult: childStatus.result,
          },
        },
      }
    }

    if (childStatus.status === 'cancelled') {
      return {
        status: 'cancelled',
        result: {
          status: 'cancelled',
          error: {
            message: 'Child workflow was cancelled',
            code: 'CHILD_WORKFLOW_CANCELLED',
            details: { childRunId: childRun.id },
          },
        },
      }
    }

    // failed
    return {
      status: 'failed',
      result: {
        status: 'failed',
        error: {
          message: 'Child workflow failed',
          code: 'CHILD_WORKFLOW_FAILED',
          details: {
            childRunId: childRun.id,
            childError: childStatus.result?.error,
          },
        },
      },
    }
  }

  private findStepSpec(job: JobRun, stepRun: StepRun): StepSpec | null {
    const candidate = job.steps.find((step) => step.id === stepRun.id)
    return candidate?.spec ?? null
  }

  private handleAbort(
    context: JobExecutionContext,
    step: StepRun,
  ): JobHandlerResult {
    this.emitLog(context, step.id, {
      level: 'warn',
      message: `Job aborted before executing step "${step.name}"`,
      meta: { reason: context.signal.reason },
    })
    return {
      status: 'cancelled',
      error: {
        message: 'Job aborted by worker',
        code: 'JOB_ABORTED',
      },
      retryable: true,
    }
  }

  private createArtifactClient(context: JobExecutionContext): ArtifactClient {
    const root =
      this.options.artifactsRoot ?? DEFAULT_ARTIFACTS_ROOT
    const jobRoot = path.join(root, context.run.id, context.job.jobName)
    return createFileSystemArtifactClient(jobRoot)
  }

  private async ensureConsumedArtifacts(
    context: JobExecutionContext,
    artifacts: ArtifactClient,
  ): Promise<void> {
    const consumeList = context.job.artifacts?.consume ?? []
    if (consumeList.length === 0) {
      return
    }

    for (const artifactPath of consumeList) {
      if (!artifactPath) {
        continue
      }
      try {
        if (typeof artifacts.list === 'function') {
          const references = await artifacts.list()
          const found = references?.some((ref) => ref.path === artifactPath)
          if (found) {
            continue
          }
        }
        await artifacts.consume(artifactPath)
      } catch (error) {
        this.logger.warn('Consumed artifact not available', {
          runId: context.run.id,
          jobId: context.job.id,
          artifact: artifactPath,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private async captureProducedArtifacts(
    context: JobExecutionContext,
    artifacts: ArtifactClient,
  ): Promise<void> {
    const produceList = context.job.artifacts?.produce ?? []
    if (produceList.length === 0) {
      return
    }

    let producedPaths: string[] = []
    if (typeof artifacts.list === 'function') {
      try {
        const references = await artifacts.list()
        const wanted = new Set(produceList)
        producedPaths = references
          ?.filter((ref) => ref.path && wanted.has(ref.path))
          .map((ref) => ref.path)
          ?? []
      } catch (error) {
        this.logger.warn('Failed to list produced artifacts', {
          runId: context.run.id,
          jobId: context.job.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const finalPaths = producedPaths.length > 0 ? producedPaths : produceList

    if (finalPaths.length === 0) {
      return
    }

    await context.state.updateRun((draft) => {
      const existing = new Set(draft.artifacts ?? [])
      for (const relativePath of finalPaths) {
        const normalized = path.join(context.job.jobName, relativePath)
        existing.add(normalized)
      }
      draft.artifacts = Array.from(existing)
      return draft
    })
  }

  private createStepLogger(
    context: JobExecutionContext,
    runtime: { run: WorkflowRun; job: JobRun; step: StepRun },
  ) {
    return {
      debug: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'debug', message, meta })
      },
      info: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'info', message, meta })
      },
      warn: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'warn', message, meta })
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        this.emitLog(context, runtime.step.id, { level: 'error', message, meta })
      },
    }
  }

  private emitLog(
    context: JobExecutionContext,
    stepId: string,
    payload: StepLogPayload,
  ) {
    this.events
      .publish({
        type: EVENT_NAMES.log.appended,
        runId: context.run.id,
        jobId: context.job.id,
        stepId,
        payload: {
          ...payload,
          timestamp: new Date().toISOString(),
        },
      })
      .catch((error) => {
        this.logger.warn('Failed to publish workflow log event', {
          error: error instanceof Error ? error.message : String(error),
        })
      })

    // Stream logs via Redis pub/sub
    if (this.logStreamer) {
      this.logStreamer
        .publishLog({
          runId: context.run.id,
          jobId: context.job.id,
          stepId,
          timestamp: new Date().toISOString(),
          level: payload.level,
          message: payload.message,
          meta: payload.meta,
        })
        .catch((error) => {
          this.logger.warn('Failed to stream workflow log', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  private createPluginExecutionContext(
    request: StepExecutionRequest,
    resolution: PluginCommandResolution,
  ) {
    const presenter = new JobRunnerPresenter({
      runId: request.context.runId,
      stepId: request.context.stepId,
      buffer: false,
      onEvent: (event) => this.forwardPresenterEvent(request, event),
    })

    const analyticsEmitter = createNoopAnalyticsEmitter();
    const operationTracker = new OperationTracker();

    const pluginContext = createPluginContext('workflow', {
      requestId: `${request.context.runId}:${request.context.jobId}:${request.context.stepId}`,
      pluginId: resolution.manifest.id,
      pluginVersion: resolution.manifest.version,
      presenter,
      analytics: analyticsEmitter,
      events: createNoopEventBridge(),
      capabilities: [],
      metadata: {
        runId: request.context.runId,
        jobId: request.context.jobId,
        stepId: request.context.stepId,
        attempt: request.context.attempt,
      },
      getTrackedOperations: () => operationTracker.toArray(),
    })

    // Convert spec.with to flags and argv for CLI handlers
    const input = request.spec.with ?? {}
    const flags: Record<string, any> = {}
    const argv: string[] = []

    // Convert input object to flags
    // All keys from input become flags (matching CLI command flag structure)
    for (const [key, value] of Object.entries(input)) {
      // Convert value to appropriate type
      if (value === true || value === 'true' || value === '1') {
        flags[key] = true
      } else if (value === false || value === 'false' || value === '0') {
        flags[key] = false
      } else if (value != null && value !== '') {
        // Keep original value type (string, number, etc.)
        flags[key] = value
      }
      // Note: argv is not used by CLI handlers, they use flags directly
    }

    // Create adapterContext for CLI handlers
    const output = createOutput({
      verbosity: 'normal',
      mode: 'tty',
    });

    const adapterContext = {
      type: 'cli' as const,
      output,
      presenter: {
        write: (text: string) => presenter.message(text),
        error: (text: string) => presenter.message(text, { level: 'error' }),
        info: (text: string) => presenter.message(text, { level: 'info' }),
        json: (data: any) => presenter.json(data),
      },
      cwd: request.workspace ?? this.options.defaultWorkspace ?? DEFAULT_WORKSPACE,
      flags,
      argv,
      requestId: request.context.runId,
      workdir: request.workspace ?? this.options.defaultWorkspace ?? DEFAULT_WORKSPACE,
      outdir: request.workspace ?? this.options.defaultWorkspace ?? DEFAULT_WORKSPACE,
      pluginId: resolution.manifest.id,
      pluginVersion: resolution.manifest.version,
      traceId: request.context.trace?.traceId ?? request.context.runId,
      spanId: request.context.trace?.spanId,
      parentSpanId: request.context.trace?.parentSpanId,
      debug: false,
    }

    return {
      pluginContext,
      adapterContext,
    }
  }

  private forwardPresenterEvent(
    request: StepExecutionRequest,
    event: JobRunnerPresenterEvent,
  ): void {
    const logger = request.context.logger
    switch (event.type) {
      case 'message': {
        const level = event.options?.level ?? 'info'
        const text = event.text ?? ''
        if (!text) {
          return
        }
        this.logWithLevel(logger, level, text, event.options?.meta)
        break
      }
      case 'progress': {
        const update = event.update
        const status = update.status ? `[${update.status}]` : ''
        const percent =
          typeof update.percent === 'number'
            ? ` ${update.percent.toFixed(
                Number.isInteger(update.percent) ? 0 : 1,
              )}%`
            : ''
        const message = update.message ? ` - ${update.message}` : ''
        const line = `${update.stage}${status}${percent}${message}`
        logger.info(line, update.meta)
        break
      }
      case 'json': {
        const serialized = this.safeSerializePayload(event.data)
        if (serialized) {
          logger.info(serialized)
        }
        break
      }
      case 'error': {
        const message = this.formatPresenterError(event.error)
        logger.error(message, event.meta)
        break
      }
      default:
        break
    }

    if (!this.redisEvents) {
      return
    }

    const envelope = this.buildPresenterEventEnvelope(request, event)
    if (!envelope) {
      return
    }

    void this.redisEvents
      .emit(request.context.runId, envelope)
      .catch((error: unknown) => {
        logger.warn('Failed to emit workflow presenter event', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  private logWithLevel(
    logger: RuntimeLogger,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    switch (level) {
      case 'debug':
        logger.debug(message, meta)
        break
      case 'warn':
        logger.warn(message, meta)
        break
      case 'error':
        logger.error(message, meta)
        break
      default:
        logger.info(message, meta)
        break
    }
  }

  private safeSerializePayload(payload: unknown): string | null {
    if (payload == null) {
      return null
    }
    try {
      return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    } catch {
      return null
    }
  }

  private buildPresenterEventEnvelope(
    request: StepExecutionRequest,
    event: JobRunnerPresenterEvent,
  ): PluginEventEnvelope | null {
    const timestamp = event.timestamp ?? new Date().toISOString()
    const baseMeta: Record<string, unknown> = {
      host: 'workflow',
      runId: request.context.runId,
      jobId: request.context.jobId,
      stepId: request.context.stepId,
      attempt: request.context.attempt,
    }

    let payload: Record<string, unknown> | null = null
    let type: string | null = null

    switch (event.type) {
      case 'message': {
        const text = event.text ?? ''
        if (!text) {
          break
        }
        const level = event.options?.level ?? 'info'
        payload = {
          text,
          level,
          meta: event.options?.meta ?? null,
        }
        baseMeta.level = level
        type = 'workflow:presenter.message'
        break
      }
      case 'progress': {
        if (!event.update) {
          break
        }
        payload = {
          ...event.update,
        }
        if (event.update.status) {
          baseMeta.status = event.update.status
        }
        if (typeof event.update.percent === 'number') {
          baseMeta.percent = event.update.percent
        }
        if (event.update.stage) {
          baseMeta.stage = event.update.stage
        }
        type = 'workflow:presenter.progress'
        break
      }
      case 'json': {
        const serialized = this.safeSerializePayload(event.data)
        if (!serialized) {
          break
        }
        payload = {
          data: serialized,
        }
        type = 'workflow:presenter.json'
        break
      }
      case 'error': {
        const message = this.formatPresenterError(event.error)
        payload = {
          message,
          meta: event.meta ?? null,
        }
        type = 'workflow:presenter.error'
        break
      }
      default:
        break
    }

    if (!type || !payload) {
      return null
    }

    return {
      id: `${request.context.runId}:${request.context.jobId}:${timestamp}:${type}`,
      type,
      version: PRESENTER_EVENT_VERSION,
      timestamp,
      payload,
      meta: {
        ...baseMeta,
      },
    }
  }

  private formatPresenterError(error: unknown): string {
    if (error instanceof Error) {
      return error.stack ?? error.message
    }
    if (typeof error === 'string') {
      return error
    }
    try {
      return JSON.stringify(error, null, 2)
    } catch {
      return String(error)
    }
  }

  private async resolveSecrets(
    run: WorkflowRun,
    job: JobRun,
    spec: StepSpec,
  ): Promise<Record<string, string>> {
    const names = new Set<string>()
    ;[run.secrets, job.secrets, spec.secrets].forEach((collection) => {
      if (!collection) {
        return
      }
      for (const name of collection) {
        if (typeof name === 'string' && name.length > 0) {
          names.add(name)
        }
      }
    })

    if (names.size === 0) {
      return {}
    }

    try {
      return await this.secretProvider.resolve(Array.from(names))
    } catch (error) {
      this.logger.warn('Failed to resolve secrets', {
        error: error instanceof Error ? error.message : String(error),
      })
      return {}
    }
  }
}

function computeDurationMs(
  startedAt: string | undefined,
  finishedAt: string,
): number | undefined {
  if (!startedAt) {
    return undefined
  }
  const start = Date.parse(startedAt)
  const end = Date.parse(finishedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined
  }
  return Math.max(0, end - start)
}

function mergeEnv(
  runEnv?: Record<string, unknown>,
  jobEnv?: Record<string, unknown>,
  stepEnv?: Record<string, unknown>,
): Record<string, string> {
  return {
    ...toStringRecord(runEnv),
    ...toStringRecord(jobEnv),
    ...toStringRecord(stepEnv),
  }
}

function toStringRecord(source?: Record<string, unknown>): Record<string, string> {
  if (!source) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value != null ? String(value) : '']),
  )
}

function isPluginStep(spec: StepSpec): boolean {
  return typeof spec.uses === 'string' && spec.uses.startsWith('plugin:')
}

function resolveWorkspace(spec: StepSpec, defaultWorkspace: string): string {
  const withBlock = (spec.with ?? {}) as Record<string, unknown>
  const workspace = withBlock.workspace ?? withBlock.cwd
  if (typeof workspace === 'string' && workspace.trim().length > 0) {
    return path.resolve(workspace)
  }
  return defaultWorkspace
}

function buildStepTimeoutOutcome(error: StepTimeoutError): StepOutcome {
  return {
    status: 'failed',
    result: {
      status: 'failed',
      error: {
        message: error.message,
        code: 'STEP_TIMEOUT',
        details: {
          timeoutMs: error.timeoutMs,
          stepId: error.stepId,
        },
      },
    },
  }
}

class StepTimeoutError extends Error {
  constructor(public readonly stepId: string, public readonly timeoutMs: number) {
    super(`Step ${stepId} exceeded timeout of ${timeoutMs}ms`)
    this.name = 'StepTimeoutError'
  }
}

