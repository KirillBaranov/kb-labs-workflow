/**
 * @module @kb-labs/workflow-engine/manifest-scanner
 *
 * Scans plugin manifests for workflows and jobs, converting them to unified WorkflowRuntime format.
 *
 * ## Features
 * - Discovers workflows from `manifest.workflows.handlers`
 * - Discovers jobs from `manifest.jobs`
 * - Converts to unified WorkflowRuntime representation
 * - Caches results via Platform state for performance
 *
 * ## Usage
 * ```typescript
 * const scanner = new ManifestScanner({ cliApi, platform });
 * const workflows = await scanner.scanPlugins();
 * ```
 */

import type { CliAPI } from '@kb-labs/cli-api';
import type { ManifestV3, WorkflowHandlerDecl, JobDecl, PlatformServices } from '@kb-labs/plugin-contracts';

/**
 * Workflow trigger type
 */
export type WorkflowTriggerType = 'manual' | 'webhook' | 'push' | 'schedule' | 'event';

/**
 * Workflow trigger configuration
 */
export interface WorkflowTrigger {
  type: WorkflowTriggerType;
  config?: Record<string, unknown>;
}

/**
 * Schedule configuration for workflows
 */
export interface WorkflowSchedule {
  /** Cron expression (e.g., "0 2 * * *") */
  cron: string;
  /** Whether schedule is enabled */
  enabled: boolean;
  /** Next run time (calculated) */
  nextRun?: Date;
  /** Last run time */
  lastRun?: Date;
}

/**
 * Workflow runtime statistics
 */
export interface WorkflowStats {
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  lastRunStatus?: 'success' | 'failed' | 'cancelled';
  lastRunAt?: Date;
  avgDurationMs?: number;
}

/**
 * Unified workflow runtime representation.
 *
 * Used for both manifest-based and standalone workflows.
 */
export interface WorkflowRuntime {
  // Identification
  id: string;
  source: 'manifest' | 'standalone';

  // Manifest-based fields
  pluginId?: string;
  manifestPath?: string;

  // Common metadata
  name: string;
  description?: string;
  tags?: string[];

  // Execution configuration
  triggers: WorkflowTrigger[];
  handler?: string; // For manifest-based workflows

  // Schedule (if applicable)
  schedule?: WorkflowSchedule;

  // Status
  status: 'active' | 'paused' | 'disabled';

  // Statistics (optional, populated from runtime)
  stats?: WorkflowStats;

  // Permissions
  permissions?: unknown; // From manifest

  // Input/output schemas
  input?: unknown;
  output?: unknown;
}

/**
 * Options for ManifestScanner
 */
export interface ManifestScannerOptions {
  /** CLI API instance */
  cliApi: CliAPI;

  /** Platform services (for state, logger, etc.) */
  platform: PlatformServices;

  /** Cache TTL in milliseconds (default: 60000 = 1 minute) */
  cacheTtlMs?: number;
}

/**
 * Manifest Scanner Service
 *
 * Discovers workflows and jobs from installed plugin manifests.
 */
export class ManifestScanner {
  private readonly cliApi: CliAPI;
  private readonly platform: PlatformServices;
  private readonly cacheTtlMs: number;

  constructor(options: ManifestScannerOptions) {
    this.cliApi = options.cliApi;
    this.platform = options.platform;
    this.cacheTtlMs = options.cacheTtlMs ?? 60000; // 1 minute default
  }

  /**
   * Scan all installed plugins for workflows and jobs.
   *
   * Returns unified WorkflowRuntime representations.
   */
  async scanPlugins(): Promise<WorkflowRuntime[]> {
    const cacheKey = 'manifest-scanner:workflows';

    // Check cache first (via platform cache)
    if (this.platform.cache) {
      const cached = await this.platform.cache.get<WorkflowRuntime[]>(cacheKey);
      if (cached) {
        this.platform.logger?.debug('ManifestScanner: Using cached workflows', { count: cached.length });
        return cached;
      }
    }

    this.platform.logger?.debug('ManifestScanner: Scanning plugin manifests');
    const snapshot = this.cliApi.snapshot();
    const workflows: WorkflowRuntime[] = [];

    for (const entry of snapshot.manifests ?? []) {
      const pluginWorkflows = this.scanPlugin(entry.pluginId, entry.manifest, entry.pluginRoot);
      workflows.push(...pluginWorkflows);
    }

    this.platform.logger?.info('ManifestScanner: Discovered workflows', {
      count: workflows.length,
      plugins: snapshot.manifests?.length ?? 0,
    });

    // Cache results (via platform cache)
    if (this.platform.cache) {
      await this.platform.cache.set(cacheKey, workflows, this.cacheTtlMs);
    }

    return workflows;
  }

  /**
   * Scan specific plugin for workflows and jobs.
   */
  scanPlugin(pluginId: string, manifest: ManifestV3, pluginRoot: string): WorkflowRuntime[] {
    const workflows: WorkflowRuntime[] = [];

    // 1. Scan workflow handlers
    const workflowHandlers = manifest.workflows?.handlers ?? [];
    for (const handler of workflowHandlers) {
      workflows.push(this.convertWorkflowHandler(pluginId, handler, pluginRoot));
    }

    // 2. Scan jobs
    const jobs = manifest.jobs ?? [];
    for (const job of jobs) {
      workflows.push(this.convertJob(pluginId, job, pluginRoot));
    }

    return workflows;
  }

  /**
   * Convert workflow handler declaration to WorkflowRuntime.
   */
  private convertWorkflowHandler(
    pluginId: string,
    handler: WorkflowHandlerDecl,
    pluginRoot: string
  ): WorkflowRuntime {
    const id = `${pluginId}/${handler.id}`;

    return {
      id,
      source: 'manifest',
      pluginId,
      manifestPath: pluginRoot,
      name: handler.describe ?? handler.id,
      description: handler.describe,
      tags: ['plugin', pluginId],
      triggers: [
        { type: 'manual' }, // Workflow handlers can always be triggered manually
      ],
      handler: handler.handler,
      status: 'active',
      permissions: handler.permissions,
      input: handler.input,
      output: handler.output,
    };
  }

  /**
   * Convert job declaration to WorkflowRuntime.
   */
  private convertJob(
    pluginId: string,
    job: JobDecl,
    pluginRoot: string
  ): WorkflowRuntime {
    const id = `${pluginId}/${job.id}`;

    const triggers: WorkflowTrigger[] = [
      { type: 'manual' }, // Jobs can be triggered manually
    ];

    // Add schedule trigger if schedule is defined
    let schedule: WorkflowSchedule | undefined;
    if (job.schedule) {
      triggers.push({
        type: 'schedule',
        config: { cron: job.schedule },
      });

      schedule = {
        cron: job.schedule,
        enabled: job.enabled ?? true,
      };
    }

    return {
      id,
      source: 'manifest',
      pluginId,
      manifestPath: pluginRoot,
      name: job.describe ?? job.id,
      description: job.describe,
      tags: job.tags ?? ['plugin', pluginId],
      triggers,
      handler: job.handler,
      schedule,
      status: (job.enabled ?? true) ? 'active' : 'disabled',
      permissions: job.permissions,
      input: job.input,
    };
  }

  /**
   * Clear cache (useful for testing or force refresh).
   */
  async clearCache(): Promise<void> {
    if (this.platform.cache) {
      await this.platform.cache.delete('manifest-scanner:workflows');
      this.platform.logger?.debug('ManifestScanner: Cache cleared');
    }
  }

  /**
   * Watch for plugin changes and invalidate cache.
   *
   * @param callback Optional callback when workflows change
   * @returns Unsubscribe function
   */
  watchPlugins(callback?: (workflows: WorkflowRuntime[]) => void): () => void {
    return this.cliApi.onChange(async () => {
      // Invalidate cache on plugin changes
      await this.clearCache();

      // Notify callback
      if (callback) {
        const workflows = await this.scanPlugins();
        callback(workflows);
      }
    });
  }
}
