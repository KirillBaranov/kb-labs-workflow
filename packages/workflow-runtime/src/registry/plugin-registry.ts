import { join, resolve, dirname } from 'node:path'
import { access } from 'node:fs/promises'
import { PluginRegistry, type DiscoveryOptions } from '@kb-labs/cli-core'
import type { ResolvedWorkflow, WorkflowRegistry } from './types'
import { getPluginWorkflows } from './plugin-manifest-types'

export interface PluginWorkflowRegistryConfig {
  workspaceRoot: string
  discovery: DiscoveryOptions
}

/**
 * Registry for plugin workflows (from plugin manifests)
 */
export class PluginWorkflowRegistry implements WorkflowRegistry {
  private cache: ResolvedWorkflow[] | null = null
  private readonly pluginRegistry: PluginRegistry

  constructor(config: PluginWorkflowRegistryConfig) {
    this.pluginRegistry = new PluginRegistry({
      ...config.discovery,
    })
  }

  async list(): Promise<ResolvedWorkflow[]> {
    if (this.cache) {
      return this.cache
    }

    await this.pluginRegistry.refresh()

    const workflows: ResolvedWorkflow[] = []
    const plugins = this.pluginRegistry.list()

    for (const plugin of plugins) {
      const manifest = this.pluginRegistry.getManifestV2(plugin.id)
      if (!manifest) {
        continue
      }

      const workflowDefs = getPluginWorkflows(manifest)
      if (workflowDefs.length === 0) {
        continue
      }

      const pluginRoot = plugin.source?.path
      if (!pluginRoot) {
        continue
      }

      // Find package root by walking up from pluginRoot until we find package.json
      // This ensures we resolve workflows relative to the actual package root, not dist/
      // pluginRoot might be dist/ (where manifest is), but workflows are in package root
      // This follows the same pattern as findRepoRoot/findNearestConfig in the codebase
      let packageRoot = pluginRoot
      let currentDir = resolve(pluginRoot)
      
      while (currentDir !== dirname(currentDir)) {
        try {
          const pkgPath = join(currentDir, 'package.json')
          await access(pkgPath)
          packageRoot = currentDir
          break
        } catch {
          currentDir = dirname(currentDir)
        }
      }

      for (const wfDef of workflowDefs) {
        const id = `plugin:${plugin.id}/${wfDef.id}`
        
        // Resolve workflow file relative to package root
        // Workflow files are included via package.json "files" field
        const filePath = resolve(packageRoot, wfDef.file)

        workflows.push({
          id,
          source: 'plugin',
          filePath,
          description: wfDef.description,
          tags: wfDef.tags,
          metadata: {
            pluginId: plugin.id,
            pluginVersion: manifest.version,
          },
        })
      }
    }

    this.cache = workflows
    return workflows
  }

  async resolve(id: string): Promise<ResolvedWorkflow | null> {
    // Remove plugin: prefix if present
    const cleanId = id.startsWith('plugin:') ? id.slice('plugin:'.length) : id

    const all = await this.list()
    return all.find((w) => w.id === id || w.id.endsWith(':' + cleanId)) ?? null
  }

  async refresh(): Promise<void> {
    this.cache = null
    await this.pluginRegistry.refresh()
  }

  async dispose(): Promise<void> {
    await this.pluginRegistry.dispose()
  }
}

