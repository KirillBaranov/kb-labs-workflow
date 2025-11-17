import { resolve } from 'node:path'
import type { WorkflowRegistry, WorkflowRegistryConfig } from './types'
import { WorkspaceWorkflowRegistry } from './workspace-registry'
import { PluginWorkflowRegistry } from './plugin-registry'
import { RemoteWorkflowRegistry } from './remote-registry'
import { CompositeWorkflowRegistry } from './composite-registry'
import { loadWorkflowConfig } from '../config'

/**
 * Create a composite workflow registry
 */
export async function createWorkflowRegistry(
  config: WorkflowRegistryConfig,
): Promise<WorkflowRegistry> {
  // 1. Load workflow config from kb.config.json
  const workflowConfig = await loadWorkflowConfig(config.workspaceRoot)

  // 2. Create workspace registry
  const workspace = new WorkspaceWorkflowRegistry({
    workspaceRoot: resolve(config.workspaceRoot),
    patterns: workflowConfig.workspaces,
  })

  // 3. Create plugin registry (if enabled)
  let plugin: PluginWorkflowRegistry | null = null

  if (config.plugins !== false && workflowConfig.plugins !== false) {
    plugin = new PluginWorkflowRegistry({
      workspaceRoot: resolve(config.workspaceRoot),
      discovery: {
        strategies: ['workspace', 'pkg'],
        roots: [resolve(config.workspaceRoot)],
      },
    })
  } else {
    // Create a no-op plugin registry
    plugin = new PluginWorkflowRegistry({
      workspaceRoot: resolve(config.workspaceRoot),
      discovery: {
        strategies: ['workspace', 'pkg'],
        roots: [resolve(config.workspaceRoot)],
      },
    })
  }

  // 4. Create remote registry (if configured)
  let remote: RemoteWorkflowRegistry | undefined = undefined

  if (workflowConfig.remotes && workflowConfig.remotes.length > 0) {
    remote = new RemoteWorkflowRegistry({
      workspaceRoot: resolve(config.workspaceRoot),
      remotes: workflowConfig.remotes,
      logger: (config as any).logger, // Optional logger from config
    })
  }

  // 5. Composite
  return new CompositeWorkflowRegistry(workspace, plugin, remote)
}

