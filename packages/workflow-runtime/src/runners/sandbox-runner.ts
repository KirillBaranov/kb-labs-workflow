import type {
  Runner,
  StepExecutionRequest,
  StepExecutionResult,
} from '../types'
import type {
  ExecuteInput,
  ExecuteResult,
  ExecutionContext,
  HandlerRef,
  PluginRegistry,
} from '@kb-labs/plugin-runtime'
import { execute as executePlugin } from '@kb-labs/plugin-runtime'
import type { ManifestV2, PermissionSpec } from '@kb-labs/plugin-manifest'

const PLUGIN_PREFIX = 'plugin:'

export interface PluginCommandResolution {
  manifest: ManifestV2
  handler: HandlerRef
  permissions: PermissionSpec
  pluginRoot: string
  input?: unknown
  registry?: PluginRegistry
  contextOverrides?: Partial<ExecutionContext>
}

export interface SandboxRunnerOptions {
  timeoutMs?: number
  resolveCommand?: (
    commandRef: string,
    request: StepExecutionRequest,
  ) => Promise<PluginCommandResolution>
}

export class SandboxRunner implements Runner {
  constructor(private readonly options: SandboxRunnerOptions = {}) {}

  async execute(request: StepExecutionRequest): Promise<StepExecutionResult> {
    const { spec, context } = request
    if (!spec.uses || typeof spec.uses !== 'string') {
      context.logger.error('Sandbox runner requires step.uses to be defined', {
        stepId: context.stepId,
      })
      return {
        status: 'failed',
        error: {
          message: 'Sandbox runner requires step.uses to be defined',
          code: 'SANDBOX_INVALID_USES',
        },
      }
    }

    if (!spec.uses.startsWith(PLUGIN_PREFIX)) {
      context.logger.error('Sandbox runner supports only plugin:* steps', {
        stepId: context.stepId,
        uses: spec.uses,
      })
      return {
        status: 'failed',
        error: {
          message: `Sandbox runner supports only "${PLUGIN_PREFIX}*" steps`,
          code: 'SANDBOX_UNSUPPORTED_STEP',
        },
      }
    }

    if (!this.options.resolveCommand) {
      context.logger.error('Sandbox runner command resolver not configured')
      return {
        status: 'failed',
        error: {
          message: 'Sandbox runner is not configured to resolve plugin commands',
          code: 'SANDBOX_RESOLVER_MISSING',
        },
      }
    }

    if (request.signal?.aborted) {
      return buildCancelledResult(request.signal, spec.name)
    }

    const commandRef = spec.uses.slice(PLUGIN_PREFIX.length)

    let resolution: PluginCommandResolution
    try {
      resolution = await this.options.resolveCommand(commandRef, request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      context.logger.error('Failed to resolve plugin command', {
        commandRef,
        error: message,
      })
      return {
        status: 'failed',
        error: {
          message: `Failed to resolve plugin command "${commandRef}": ${message}`,
          code: 'SANDBOX_RESOLVE_FAILED',
        },
      }
    }

    if (!resolution.permissions) {
      context.logger.error('Sandbox runner resolver returned no permissions', {
        commandRef,
      })
      return {
        status: 'failed',
        error: {
          message: `Resolver did not provide permissions for "${commandRef}"`,
          code: 'SANDBOX_PERMISSIONS_MISSING',
        },
      }
    }

    const executeInput: ExecuteInput = {
      handler: resolution.handler,
      input:
        resolution.input ??
        spec.with ??
        {
          step: spec.name,
          metadata: {
            runId: context.runId,
            jobId: context.jobId,
            stepId: context.stepId,
          },
        },
      manifest: resolution.manifest,
      perms: resolution.permissions,
    }

    const artifactBase =
      typeof context.artifacts?.basePath === 'function'
        ? context.artifacts.basePath()
        : undefined

    const {
      pluginRoot: overridePluginRoot,
      ...restOverrides
    } = resolution.contextOverrides ?? {}

    const baseContext: ExecutionContext = {
      requestId: `${context.runId}:${context.jobId}:${context.stepId}`,
      pluginId: resolution.manifest.id,
      pluginVersion: resolution.manifest.version,
      routeOrCommand: commandRef,
      workdir:
        request.workspace ??
        artifactBase ??
        process.cwd(),
      outdir:
        artifactBase ??
        request.workspace,
      pluginRoot: overridePluginRoot ?? resolution.pluginRoot,
      traceId: context.trace?.traceId ?? context.runId,
      spanId: context.trace?.spanId,
      parentSpanId: context.trace?.parentSpanId,
      debug: false,
      jsonMode: false,
    }

    const executionContext: ExecutionContext = {
      ...baseContext,
      ...restOverrides,
      signal: request.signal ?? restOverrides.signal,
    }

    try {
      const result = await executePlugin(
        executeInput,
        executionContext,
        resolution.registry,
      )
      return transformPluginResult(result, context.stepId)
    } catch (error) {
      if (request.signal?.aborted) {
        return buildCancelledResult(request.signal, spec.name)
      }
      const message = error instanceof Error ? error.message : String(error)
      context.logger.error('Sandbox runner execution failed', {
        commandRef,
        error: message,
      })
      return {
        status: 'failed',
        error: {
          message: `Sandbox execution failed: ${message}`,
          code: 'SANDBOX_EXECUTION_FAILED',
        },
      }
    }
  }
}

function buildCancelledResult(
  signal: AbortSignal,
  stepName: string,
): StepExecutionResult {
  const reason = signalReason(signal) ?? `Step "${stepName}" cancelled`
  return {
    status: 'cancelled',
    error: {
      message: reason,
      code: 'STEP_CANCELLED',
    },
  }
}

function signalReason(signal: AbortSignal): string | undefined {
  if (!signal.aborted) {
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

function transformPluginResult(
  result: ExecuteResult,
  stepId: string,
): StepExecutionResult {
  if (result.ok) {
    return {
      status: 'success',
      outputs: {
        data: result.data,
        metrics: result.metrics,
        logs: result.logs,
        profile: result.profile,
        stepId,
      },
    }
  }

  return {
    status: 'failed',
    error: {
      message: result.error.message,
      code: result.error.code,
      details: {
        httpStatus: result.error.http,
        meta: result.error.meta,
      },
    },
  }
}


