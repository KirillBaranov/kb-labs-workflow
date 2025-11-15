import { PluginRegistry, type DiscoveryOptions, type CacheOptions } from '@kb-labs/cli-core'
import type { ManifestV2, CliCommandDecl, PermissionSpec } from '@kb-labs/plugin-manifest'
import type { PluginCommandResolution } from '@kb-labs/workflow-runtime'
import type { EngineLogger } from './types'

export interface PluginCommandResolverDeps {
  registry: PluginRegistry
  logger: EngineLogger
}

export interface PluginCommandResolverConfig {
  discovery: DiscoveryOptions
  cache?: CacheOptions
  logger?: EngineLogger
}

export class PluginCommandResolver {
  private readonly registry: PluginRegistry
  private readonly logger: EngineLogger
  private readonly cache = new Map<string, PluginCommandResolution>()
  private unsubscribe?: () => void

  constructor(deps: PluginCommandResolverDeps) {
    this.registry = deps.registry
    this.logger = deps.logger
    this.unsubscribe = this.registry.onChange(() => {
      this.logger.debug('Plugin registry changed; clearing command resolution cache')
      this.cache.clear()
    })
  }

  async ensureReady(): Promise<void> {
    if (this.registry.isInitialized) {
      return
    }
    await this.registry.refresh()
  }

  async resolve(commandRef: string): Promise<PluginCommandResolution> {
    const cached = this.cache.get(commandRef)
    if (cached) {
      return cached
    }

    await this.ensureReady()

    const parsed = parseCommandRef(commandRef)
    const manifest = this.registry.getManifestV2(parsed.pluginId)
    if (!manifest) {
      throw new PluginCommandResolverError(
        `Manifest not found for plugin ${parsed.pluginId}`,
        commandRef,
      )
    }

    const pluginRecord = this.registry.list().find(
      (item) => item.id === parsed.pluginId,
    )
    if (!pluginRecord?.source?.path) {
      throw new PluginCommandResolverError(
        `Plugin source path not resolved for ${parsed.pluginId}`,
        commandRef,
      )
    }
    const pluginRoot = pluginRecord.source.path

    const command = resolveCommandDecl(manifest, parsed.commandId)
    if (!command) {
      throw new PluginCommandResolverError(
        `CLI command ${parsed.commandId} not found in manifest ${parsed.pluginId}`,
        commandRef,
      )
    }

    const handler = parseHandler(command.handler)
    const permissions = resolvePermissions(manifest.permissions)

    const resolution: PluginCommandResolution = {
      manifest,
      handler,
      permissions,
      pluginRoot,
      input: command,
    }

    this.cache.set(commandRef, resolution)
    return resolution
  }

  async dispose(): Promise<void> {
    this.cache.clear()
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }
    await this.registry.dispose()
  }
}

export async function createPluginCommandResolver(
  config: PluginCommandResolverConfig,
): Promise<PluginCommandResolver> {
  const logger =
    config.logger ??
    {
      debug() {},
      info() {},
      warn(message: string) {
        console.warn(`[PluginCommandResolver] ${message}`)
      },
      error(message: string) {
        console.error(`[PluginCommandResolver] ${message}`)
      },
    }

  const registry = new PluginRegistry({
    ...config.discovery,
    cache: config.cache,
  })

  const resolver = new PluginCommandResolver({
    registry,
    logger,
  })

  await resolver.ensureReady()
  return resolver
}

interface ParsedCommandRef {
  pluginId: string
  section: string
  commandId: string
}

function parseCommandRef(commandRef: string): ParsedCommandRef {
  const rawRef = commandRef.startsWith('plugin:')
    ? commandRef.slice('plugin:'.length)
    : commandRef

  const parts = rawRef.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new PluginCommandResolverError(
      'Workflow step command reference must follow plugin:<pluginId>/<section>/<command>',
      commandRef,
    )
  }

  let sectionIndex = 1
  let pluginId = parts[0]!

  if (pluginId.startsWith('@')) {
    if (parts.length < 3) {
      throw new PluginCommandResolverError(
        'Workflow step command reference must follow plugin:<pluginId>/<section>/<command>',
        commandRef,
      )
    }
    pluginId = `${parts[0]!}/${parts[1]!}`
    sectionIndex = 2
  }

  const section = parts[sectionIndex]!
  const rest = parts.slice(sectionIndex + 1)

  if (section !== 'cli') {
    throw new PluginCommandResolverError(
      `Unsupported plugin command section "${section}"`,
      commandRef,
    )
  }

  const commandId = rest.join('/')
  if (!commandId) {
    throw new PluginCommandResolverError(
      'Workflow step command reference is missing command identifier',
      commandRef,
    )
  }

  return { pluginId, section, commandId }
}

function resolveCommandDecl(
  manifest: ManifestV2,
  commandId: string,
): CliCommandDecl | null {
  const commands = manifest.cli?.commands ?? []
  if (commands.length === 0) {
    return null
  }

  const directMatch = commands.find(
    (command: CliCommandDecl) => command.id === commandId,
  )
  if (directMatch) {
    return directMatch
  }

  const groupMatch = commands.find((command: CliCommandDecl) => {
    if (!command.group) {
      return false
    }
    return `${command.group}/${command.id}` === commandId
  })
  if (groupMatch) {
    return groupMatch
  }

  return null
}

function parseHandler(handlerRef: string) {
  const [file, exportName] = handlerRef.split('#')
  if (!file || !exportName) {
    throw new Error(`Invalid handler reference: ${handlerRef}`)
  }
  return {
    file,
    export: exportName,
  }
}

function resolvePermissions(
  permissions: PermissionSpec | undefined,
): PermissionSpec {
  if (!permissions) {
    return {}
  }
  return permissions
}

export class PluginCommandResolverError extends Error {
  constructor(message: string, public readonly commandRef: string) {
    super(message)
    this.name = 'PluginCommandResolverError'
  }
}

