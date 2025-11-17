import { mkdir, readFile, rm, access } from 'node:fs/promises'
import { join, resolve, basename, extname, relative } from 'node:path'
import { execaCommand } from 'execa'
import fg from 'fast-glob'
import { parse as parseYaml } from 'yaml'
import { WorkflowSpecSchema, type WorkflowSpec } from '@kb-labs/workflow-contracts'
import type { ResolvedWorkflow, WorkflowRegistry } from './types'
import type { RemoteMarketplaceSource } from '../config'
export interface LoggerLike {
  debug?(msg: string, meta?: Record<string, unknown>): void
  info?(msg: string, meta?: Record<string, unknown>): void
  warn?(msg: string, meta?: Record<string, unknown>): void
  error?(msg: string, meta?: Record<string, unknown>): void
}

export interface RemoteWorkflowRegistryConfig {
  workspaceRoot: string
  remotes: RemoteMarketplaceSource[]
  cacheDir?: string
  logger?: LoggerLike
}

/**
 * Registry for remote workflows (from git repositories)
 */
export class RemoteWorkflowRegistry implements WorkflowRegistry {
  private cache: ResolvedWorkflow[] | null = null
  private readonly cacheDir: string
  private readonly logger?: LoggerLike

  constructor(private readonly config: RemoteWorkflowRegistryConfig) {
    this.cacheDir =
      config.cacheDir ?? join(config.workspaceRoot, '.kb/workflows/remotes')
    this.logger = config.logger
  }

  async list(): Promise<ResolvedWorkflow[]> {
    if (this.cache) {
      return this.cache
    }

    const workflows: ResolvedWorkflow[] = []

    for (const remote of this.config.remotes) {
      try {
        const remoteWorkflows = await this.loadWorkflowsFromRemote(remote)
        workflows.push(...remoteWorkflows)
      } catch (error) {
        if (this.logger?.warn) {
          this.logger.warn('Failed to load workflows from remote', {
            remote: remote.name,
            error: error instanceof Error ? error.message : String(error),
          })
        }
        // Continue with other remotes
      }
    }

    this.cache = workflows
    return workflows
  }

  async resolve(id: string): Promise<ResolvedWorkflow | null> {
    // Remove remote: prefix if present
    const cleanId = id.startsWith('remote:') ? id.slice('remote:'.length) : id

    const all = await this.list()
    return all.find((w) => w.id === id || w.id.endsWith(':' + cleanId)) ?? null
  }

  async refresh(): Promise<void> {
    // Clear cache and update all remotes
    this.cache = null
    for (const remote of this.config.remotes) {
      await this.updateRemote(remote)
    }
  }

  async dispose(): Promise<void> {
    // Optionally clean up cache directory
    // For now, keep it for performance
  }

  private async loadWorkflowsFromRemote(
    remote: RemoteMarketplaceSource,
  ): Promise<ResolvedWorkflow[]> {
    const workflows: ResolvedWorkflow[] = []
    const repoPath = await this.ensureRemoteCloned(remote)

    // Find workflow files in the remote
    const searchPath = remote.path
      ? join(repoPath, remote.path, '**/*.{yml,yaml,json}')
      : join(repoPath, '**/*.{yml,yaml,json}')

    const files = await fg([searchPath], {
      absolute: true,
      onlyFiles: true,
      ignore: ['node_modules/**', 'dist/**', '.git/**'],
    })

    for (const file of files) {
      try {
        const spec = await this.loadWorkflowSpec(file)
        if (!spec) {
          continue
        }

        const relativePath = relative(repoPath, file)
        const id = this.generateId(remote.name, relativePath)

        workflows.push({
          id,
          source: 'plugin', // Use 'plugin' for now, could add 'remote' later
          filePath: file,
          description: spec.description,
          // Store remote info in tags for now (metadata is limited)
          tags: [`remote:${remote.name}`],
        })
      } catch (error) {
        if (this.logger?.warn) {
          this.logger.warn('Failed to load workflow from remote file', {
            remote: remote.name,
            file,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    return workflows
  }

  private async ensureRemoteCloned(
    remote: RemoteMarketplaceSource,
  ): Promise<string> {
    const repoName = this.getRepoName(remote.url)
    const repoPath = join(this.cacheDir, remote.name, repoName)

    // Check if already cloned
    try {
      await access(join(repoPath, '.git'))
      // Already exists, try to update
      await this.updateRemote(remote)
      return repoPath
    } catch {
      // Not cloned yet, clone it
    }

    // Clone the repository
    await mkdir(repoPath, { recursive: true })
    const ref = remote.ref ?? 'main'

    try {
      await execaCommand(`git clone --depth 1 --branch ${ref} ${remote.url} ${repoPath}`, {
        shell: true,
      })
    } catch (error) {
      // Clean up on failure
      await rm(repoPath, { recursive: true, force: true }).catch(() => {})
      throw new Error(
        `Failed to clone remote ${remote.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return repoPath
  }

  private async updateRemote(remote: RemoteMarketplaceSource): Promise<void> {
    const repoName = this.getRepoName(remote.url)
    const repoPath = join(this.cacheDir, remote.name, repoName)

    try {
      await access(join(repoPath, '.git'))
    } catch {
      // Not cloned yet, will be cloned on next list()
      return
    }

    const ref = remote.ref ?? 'main'

    try {
      // Fetch and checkout the specified ref
      await execaCommand(`git fetch origin ${ref}`, {
        cwd: repoPath,
        shell: true,
      })
      await execaCommand(`git checkout ${ref}`, {
        cwd: repoPath,
        shell: true,
      })
    } catch (error) {
      if (this.logger?.warn) {
        this.logger.warn('Failed to update remote', {
          remote: remote.name,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // Continue, use cached version
    }
  }

  private async loadWorkflowSpec(
    filePath: string,
  ): Promise<WorkflowSpec | null> {
    try {
      const raw = await readFile(filePath, 'utf8')
      const parsed = filePath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw)
      const validated = WorkflowSpecSchema.safeParse(parsed)
      if (!validated.success) {
        if (this.logger?.warn) {
          this.logger.warn('Validation failed for workflow', {
            filePath,
            errors: validated.error.issues,
          })
        }
        return null
      }
      return validated.data
    } catch (error) {
      if (this.logger?.warn) {
        this.logger.warn('Error reading or parsing workflow file', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return null
    }
  }

  private generateId(remoteName: string, relativePath: string): string {
    const noExt = relativePath.replace(extname(relativePath), '')
    const cleanPath = noExt.replace(/\\/g, '/').replace(/^\//, '')
    return `remote:${remoteName}/${cleanPath}`
  }

  private getRepoName(url: string): string {
    // Extract repo name from URL
    // e.g., https://github.com/org/repo.git -> repo
    const match = url.match(/\/([^/]+?)(?:\.git)?$/)
    return match?.[1] ?? 'repo'
  }
}

