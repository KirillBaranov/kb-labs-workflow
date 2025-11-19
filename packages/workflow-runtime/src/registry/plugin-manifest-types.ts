/**
 * Local types for plugin workflows until ManifestV2 is extended
 * These types should match what will be added to @kb-labs/plugin-manifest
 */

export interface PluginWorkflowDef {
  id: string
  file: string
  description?: string
  tags?: string[]
}

/**
 * Extract workflows from manifest (with type assertion)
 */
export function getPluginWorkflows(manifest: unknown): PluginWorkflowDef[] {
  const m = manifest as { workflows?: PluginWorkflowDef[] }
  return m.workflows ?? []
}

