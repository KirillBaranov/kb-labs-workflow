/**
 * @module @kb-labs/workflow-daemon/cron-discovery
 * CronDiscovery - discovers cron jobs from plugin manifests and user YAML files
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import YAML from 'yaml';
import type { ILogger } from '@kb-labs/core-platform';
import type { CliAPI } from '@kb-labs/cli-api';
import type { CronScheduler } from './cron-scheduler.js';
import {
  PluginCronJobSchema,
  UserCronJobSchema,
  type PluginCronJob,
  type UserCronJob,
} from '@kb-labs/workflow-contracts';

export interface CronDiscoveryOptions {
  cliApi: CliAPI;
  scheduler: CronScheduler;
  logger: ILogger;
  workspaceRoot: string;
}

/**
 * CronDiscovery scans for cron jobs from:
 * 1. Plugin manifests (manifest.cron section)
 * 2. User YAML files (.kb/jobs/*.yml)
 */
export class CronDiscovery {
  private readonly cliApi: CliAPI;
  private readonly scheduler: CronScheduler;
  private readonly logger: ILogger;
  private readonly workspaceRoot: string;

  constructor(options: CronDiscoveryOptions) {
    this.cliApi = options.cliApi;
    this.scheduler = options.scheduler;
    this.logger = options.logger;
    this.workspaceRoot = options.workspaceRoot;
  }

  /**
   * Discover and register all cron jobs.
   * Scans plugin manifests and user YAML files.
   */
  async discoverAll(): Promise<{ plugins: number; users: number }> {
    this.logger.info('Starting cron job discovery');

    const pluginJobs = await this.discoverPluginJobs();
    const userJobs = await this.discoverUserJobs();

    this.logger.info('Cron job discovery complete', {
      pluginJobs,
      userJobs,
      total: pluginJobs + userJobs,
    });

    return { plugins: pluginJobs, users: userJobs };
  }

  /**
   * Discover cron jobs from plugin manifests.
   */
  private async discoverPluginJobs(): Promise<number> {
    let count = 0;

    try {
      const plugins = await this.cliApi.listPlugins();

      for (const plugin of plugins) {
        try {
          // Get plugin manifest
          const manifest = await this.cliApi.getPluginManifest(plugin.id);

          // Check if manifest has cron section
          const cronSection = (manifest as any).cron;
          if (!cronSection || !Array.isArray(cronSection)) {
            continue;
          }

          this.logger.debug('Found cron section in plugin manifest', {
            pluginId: plugin.id,
            cronJobs: cronSection.length,
          });

          // Validate and register each cron job
          for (const jobDef of cronSection) {
            try {
              const validated = PluginCronJobSchema.parse(jobDef);
              this.scheduler.registerPluginJob(plugin.id, validated);
              count++;
            } catch (error) {
              this.logger.warn('Invalid plugin cron job definition', {
                pluginId: plugin.id,
                jobDef,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          this.logger.warn('Failed to process plugin manifest', {
            pluginId: plugin.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error(
        'Failed to discover plugin cron jobs',
        error instanceof Error ? error : undefined
      );
    }

    return count;
  }

  /**
   * Discover cron jobs from user YAML files in .kb/jobs/*.yml
   */
  private async discoverUserJobs(): Promise<number> {
    let count = 0;
    const jobsDir = join(this.workspaceRoot, '.kb', 'jobs');

    try {
      // Check if directory exists
      const dirStat = await stat(jobsDir).catch(() => null);
      if (!dirStat?.isDirectory()) {
        this.logger.debug('User jobs directory does not exist', { jobsDir });
        return 0;
      }

      // Read all files in directory
      const files = await readdir(jobsDir);

      for (const file of files) {
        const filePath = join(jobsDir, file);
        const ext = extname(file);

        // Only process .yml and .yaml files
        if (ext !== '.yml' && ext !== '.yaml') {
          continue;
        }

        try {
          const content = await readFile(filePath, 'utf-8');
          const parsed = YAML.parse(content);

          // Validate against UserCronJobSchema
          const validated = UserCronJobSchema.parse(parsed);

          // Only register if autoStart is true
          if (validated.autoStart) {
            const fileName = basename(file, ext);
            this.scheduler.registerUserJob(fileName, validated);
            count++;
          } else {
            this.logger.debug('Skipping user cron job (autoStart: false)', {
              file,
            });
          }
        } catch (error) {
          this.logger.warn('Failed to parse user cron job file', {
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn(
        'Failed to discover user cron jobs',
        error instanceof Error ? error : undefined,
        { jobsDir }
      );
    }

    return count;
  }
}
