/**
 * @module @kb-labs/workflow-runtime/runners/sandbox-runner
 *
 * V3 SandboxRunner - executes plugin handlers using platform ExecutionBackend.
 *
 * This runner is for steps that specify `uses: "plugin:..."` or `uses: "command:..."`.
 * It delegates execution to the platform's unified ExecutionBackend instead of
 * implementing custom plugin execution logic.
 *
 * ## Integration Pattern (REST API-style)
 *
 * Instead of direct plugin discovery and loading, we:
 * 1. Accept ExecutionBackend from platform (via options)
 * 2. Build ExecutionRequest with PluginContextDescriptor
 * 3. Call backend.execute() - platform handles the rest
 *
 * This matches the REST API pattern where execution is delegated to the platform layer.
 *
 * @example
 * ```typescript
 * const runner = new SandboxRunner({
 *   backend: platform.executionBackend,
 *   cliApi, // For plugin resolution
 * });
 *
 * const result = await runner.execute({
 *   spec: { uses: 'plugin:release-manager/create-release', with: { version: '1.0.0' } },
 *   context: stepContext,
 * });
 * ```
 */

import { randomUUID } from 'node:crypto'
import type { StepSpec } from '@kb-labs/workflow-contracts'
import type {
  ExecutionBackend,
  ExecutionRequest,
  PluginContextDescriptor,
  HostContext,
} from '@kb-labs/plugin-execution'
import type { CliAPI } from '@kb-labs/cli-api'
import type {
  Runner,
  StepExecutionRequest,
  StepExecutionResult,
} from '../types'

export interface SandboxRunnerOptions {
  /**
   * Platform ExecutionBackend (REQUIRED).
   * Obtained from platform.executionBackend.
   */
  backend: ExecutionBackend

  /**
   * CLI API for plugin resolution (REQUIRED).
   * Needed to resolve plugin IDs to plugin roots and handler paths.
   */
  cliApi: CliAPI

  /**
   * Workspace root directory.
   * Default: process.cwd()
   */
  workspaceRoot?: string

  /**
   * Default timeout for plugin execution (ms).
   * Default: 120000 (2 minutes)
   */
  defaultTimeout?: number
}

interface PluginCommandResolution {
  pluginId: string
  pluginVersion: string
  pluginRoot: string
  handler: string
  input: unknown
}

/**
 * SandboxRunner - V3 implementation using platform ExecutionBackend.
 *
 * Executes plugin handlers through the unified execution layer.
 * Supports both `uses: "plugin:id/handler"` and `uses: "command:name"` syntax.
 */
export class SandboxRunner implements Runner {
  private readonly backend: ExecutionBackend
  private readonly cliApi: CliAPI
  private readonly workspaceRoot: string
  private readonly defaultTimeout: number

  constructor(options: SandboxRunnerOptions) {
    this.backend = options.backend
    this.cliApi = options.cliApi
    this.workspaceRoot = options.workspaceRoot ?? process.cwd()
    this.defaultTimeout = options.defaultTimeout ?? 120000 // 2 minutes
  }

  async execute(request: StepExecutionRequest): Promise<StepExecutionResult> {
    const { spec, context, workspace, signal } = request

    // Early cancellation check
    if (signal?.aborted) {
      return buildCancelledResult(signal)
    }

    // Validate step has uses field
    if (!spec.uses) {
      context.logger.error('SandboxRunner requires step.uses field', {
        stepId: context.stepId,
      })
      return {
        status: 'failed',
        error: {
          message: 'Sandbox runner requires "uses" field to specify plugin handler',
          code: 'INVALID_STEP',
        },
      }
    }

    // Resolve plugin command
    let resolution: PluginCommandResolution
    try {
      resolution = await this.resolveCommand(spec, request)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to resolve plugin command'
      context.logger.error('Plugin command resolution failed', {
        stepId: context.stepId,
        uses: spec.uses,
        error: message,
      })
      return {
        status: 'failed',
        error: {
          message,
          code: 'COMMAND_RESOLUTION_FAILED',
        },
      }
    }

    // Build PluginContextDescriptor (matches REST API pattern)
    const requestId = context.trace?.traceId ?? randomUUID()
    const executionId = `exec_${context.stepId}_${Date.now()}_${randomUUID().slice(0, 8)}`

    const hostContext: HostContext = {
      host: 'workflow',
      workflowId: context.runId, // Using runId as workflowId for now
      runId: context.runId,
      jobId: context.jobId,
      stepId: context.stepId,
      attempt: context.attempt,
      input: resolution.input,
    }

    const descriptor: PluginContextDescriptor = {
      host: 'workflow', // Required field at top level
      pluginId: resolution.pluginId,
      pluginVersion: resolution.pluginVersion,
      requestId,
      cwd: workspace ?? this.workspaceRoot,
      permissions: {}, // TODO: Extract from plugin manifest if needed
      hostContext,
      // Note: config is loaded at runtime from kb.config.json
    }

    // Build ExecutionRequest (matches REST API pattern)
    const executionRequest: ExecutionRequest = {
      executionId,
      descriptor,
      pluginRoot: resolution.pluginRoot,
      handlerRef: resolution.handler,
      input: resolution.input,
      workspace: {
        type: 'local',
        cwd: workspace ?? this.workspaceRoot,
      },
      timeoutMs: this.defaultTimeout,
    }

    // Log execution start
    context.logger.info('Executing plugin handler', {
      stepId: context.stepId,
      pluginId: resolution.pluginId,
      handler: resolution.handler,
      executionId,
    })

    // Execute via backend
    const result = await this.backend.execute(executionRequest, { signal })

    // Map ExecutionResult to StepExecutionResult
    if (result.ok) {
      context.logger.info('Plugin handler completed', {
        stepId: context.stepId,
        executionId,
        executionTimeMs: result.executionTimeMs,
      })

      return {
        status: 'success',
        outputs: typeof result.data === 'object' && result.data !== null
          ? (result.data as Record<string, unknown>)
          : { result: result.data },
      }
    } else {
      // Check if cancelled
      if (signal?.aborted || result.error?.code === 'ABORTED') {
        return buildCancelledResult(signal, result.error)
      }

      context.logger.error('Plugin handler failed', {
        stepId: context.stepId,
        executionId,
        error: result.error?.message,
        code: result.error?.code,
      })

      return {
        status: 'failed',
        error: {
          message: result.error?.message ?? 'Plugin execution failed',
          code: result.error?.code ?? 'UNKNOWN_ERROR',
          stack: result.error?.stack,
          details: result.error?.details,
        },
      }
    }
  }

  /**
   * Resolve command reference to plugin handler.
   *
   * Supports two formats:
   * - `uses: "plugin:release-manager/create-release"` - direct plugin handler reference
   * - `uses: "command:release:create"` - command name (resolved via CLI API)
   *
   * Returns plugin ID, version, root path, handler path, and input.
   */
  private async resolveCommand(
    spec: StepSpec,
    request: StepExecutionRequest,
  ): Promise<PluginCommandResolution> {
    const uses = spec.uses!
    const input = spec.with ?? {}

    // Format 1: plugin:id/handler
    if (uses.startsWith('plugin:')) {
      return this.resolvePluginHandler(uses, input)
    }

    // Format 2: command:name
    if (uses.startsWith('command:')) {
      return this.resolveCommandName(uses, input, request)
    }

    // Unsupported format
    throw new Error(`Unsupported uses format: ${uses}. Expected "plugin:..." or "command:..."`)
  }

  /**
   * Resolve plugin handler reference.
   * Format: `plugin:id/handler` or `plugin:id/path/to/handler`
   */
  private async resolvePluginHandler(
    uses: string,
    input: unknown,
  ): Promise<PluginCommandResolution> {
    const pluginRef = uses.slice('plugin:'.length)
    const [pluginId, ...handlerParts] = pluginRef.split('/')

    if (!pluginId || handlerParts.length === 0) {
      throw new Error(`Invalid plugin reference: ${uses}. Expected "plugin:id/handler"`)
    }

    const handlerName = handlerParts.join('/')

    // Get plugin manifest from CLI API snapshot
    const snapshot = this.cliApi.snapshot()
    const entry = snapshot.manifests?.find(m => m.pluginId === pluginId)

    if (!entry) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    // Find workflow handler by name
    const workflowHandlers = entry.manifest.workflows?.handlers ?? []
    const handler = workflowHandlers.find(h => h.id === handlerName)

    if (!handler) {
      throw new Error(`Workflow handler not found: ${handlerName} in plugin ${pluginId}`)
    }

    return {
      pluginId,
      pluginVersion: entry.manifest.version,
      pluginRoot: entry.pluginRoot,
      handler: handler.handler, // File path from manifest
      input,
    }
  }

  /**
   * Resolve command name to plugin handler.
   * Format: `command:name` (e.g., `command:release:create`)
   *
   * Searches for command in CLI API snapshot and resolves to handler.
   */
  private async resolveCommandName(
    uses: string,
    input: unknown,
    request: StepExecutionRequest,
  ): Promise<PluginCommandResolution> {
    const commandName = uses.slice('command:'.length)

    // Get CLI API snapshot
    const snapshot = this.cliApi.snapshot()

    // Search all manifests for matching CLI command
    for (const entry of snapshot.manifests ?? []) {
      const commands = entry.manifest.cli?.commands ?? []
      const command = commands.find((c) => c.id === commandName)

      if (command) {
        return {
          pluginId: entry.pluginId,
          pluginVersion: entry.manifest.version,
          pluginRoot: entry.pluginRoot,
          handler: command.handler,
          input,
        }
      }
    }

    throw new Error(`Command not found: ${commandName}`)
  }
}

function buildCancelledResult(
  signal?: AbortSignal,
  error?: { message: string },
): StepExecutionResult {
  const reason = error?.message ?? signalReason(signal) ?? 'Step execution cancelled'

  return {
    status: 'cancelled',
    error: {
      message: reason,
      code: 'STEP_CANCELLED',
    },
  }
}

function signalReason(signal?: AbortSignal): string | undefined {
  if (!signal?.aborted) {
    return undefined
  }
  const reason = (signal as AbortSignal & { reason?: unknown }).reason
  if (reason instanceof Error) {
    return reason.message
  }
  if (typeof reason === 'string') {
    return reason
  }
  return undefined
}
