/**
 * @module @kb-labs/workflow-daemon/bootstrap
 * Bootstrap workflow daemon - initialize platform, engine, worker, and HTTP server
 */

import { platform, createServiceBootstrap } from '@kb-labs/core-runtime';
import { WorkflowEngine, WorkflowService } from '@kb-labs/workflow-engine';
import { createWorkflowWorker } from './worker.js';
import { JobBroker } from './job-broker.js';
import { CronScheduler } from './cron-scheduler.js';
import { CronDiscovery } from './cron-discovery.js';
import { createServer } from './server.js';
import { createCliAPI } from '@kb-labs/cli-api';
import { findRepoRoot, discoverSubRepoPaths } from '@kb-labs/core-sys';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { WorkflowWorker } from './worker.js';
import type { FastifyInstance } from 'fastify';

// Singleton instances for cleanup
let workerInstance: WorkflowWorker | null = null;
let serverInstance: FastifyInstance | null = null;
let cronSchedulerInstance: CronScheduler | null = null;

/**
 * Bootstrap workflow daemon.
 * Initializes platform, engine, worker, and HTTP server.
 */
export async function bootstrap(cwd: string = process.cwd()): Promise<void> {
  // Detect repo root first
  const repoRoot = await findRepoRoot(cwd);

  // Initialize platform (loads .env + adapters from kb.config.json)
  await createServiceBootstrap({ appId: 'workflow-daemon', repoRoot });

  if (!platform.isConfigured('workspace')) {
    // Not fatal — workflows with explicit isolation: relaxed will still work.
    // But balanced (default) and strict isolation will fail at job execution time.
    process.stderr.write(
      '[workflow-daemon] WARNING: workspace adapter is not configured.\n' +
      '[workflow-daemon] Workflows that use isolation: balanced (default) or isolation: strict will fail.\n' +
      '[workflow-daemon] To fix: set platform.adapters.workspace in kb.config.json.\n' +
      '[workflow-daemon] To run without a workspace: add "isolation: relaxed" to your workflow YAML.\n',
    );
  }

  if (!platform.isConfigured('environment') && platform.isConfigured('workspace')) {
    process.stderr.write(
      '[workflow-daemon] WARNING: environment adapter is not configured.\n' +
      '[workflow-daemon] Workflows that use isolation: strict will fail.\n' +
      '[workflow-daemon] To fix: set platform.adapters.environment in kb.config.json.\n',
    );
  }

  // Now we can use platform.logger (configured from kb.config.json)
  const startupRequestId = `workflow-startup-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const startupTraceId = randomUUID();
  const startupSpanId = randomUUID();
  const bootstrapLogger = platform.logger.child({
    layer: 'workflow',
    service: 'bootstrap',
    requestId: startupRequestId,
    reqId: startupRequestId,
    traceId: startupTraceId,
    spanId: startupSpanId,
    invocationId: startupSpanId,
    executionId: startupSpanId,
  });

  bootstrapLogger.info('Workflow daemon starting', { repoRoot });

  // Initialize CLI API for plugin discovery
  bootstrapLogger.info('Initializing CLI API for plugin discovery');

  // Collect all sub-repo paths for plugin discovery.
  // Uses .gitmodules for accurate nested layout — no hardcoded category dirs.
  const discoveryRoots = [repoRoot, ...discoverSubRepoPaths(repoRoot)];
  bootstrapLogger.info('Discovery roots configured', {
    roots: discoveryRoots,
    rootsCount: discoveryRoots.length,
  });

  const cliApi = await createCliAPI({
    discovery: {
      strategies: ['workspace', 'pkg', 'dir', 'file'],
      roots: discoveryRoots,
      allowDowngrade: false,
    },
    cache: {
      inMemory: true,
      ttlMs: 10 * 60 * 1000, // 10 minutes
    },
    logger: {
      level: 'info',
    },
    snapshot: {
      mode: 'producer', // Workflow daemon produces its own snapshots (standalone mode)
      refreshIntervalMs: 60_000, // Refresh every minute
    },
  });

  await cliApi.initialize();
  const plugins = await cliApi.listPlugins();
  bootstrapLogger.info('CLI API discovery complete', {
    pluginsFound: plugins.length,
    pluginIds: plugins.map(p => `${p.id}@${p.version}`),
  });

  bootstrapLogger.info('Creating WorkflowEngine');
  const engine = new WorkflowEngine({
    cache: platform.cache,
    events: platform.eventBus,
    logger: platform.logger,
    snapshotManager: (platform as any).snapshotManager,
    workspaceRoot: repoRoot,
  });

  // Mark stale running/queued runs as failed (they're orphaned from previous process)
  bootstrapLogger.info('Cleaning up stale runs from previous daemon process');
  await engine.cleanupStaleRuns();

  // Resume interrupted jobs from previous shutdown
  bootstrapLogger.info('Resuming interrupted jobs');
  await engine.resumeInterruptedJobs();

  // Create JobBroker
  bootstrapLogger.info('Creating JobBroker');
  const jobBroker = new JobBroker(engine, platform.logger, platform);

  // Create CronScheduler (before HTTP server so it can be exposed via API)
  bootstrapLogger.info('Creating CronScheduler');
  const cronScheduler = new CronScheduler({
    jobBroker,
    workflowEngine: engine,
    logger: platform.logger,
    timezone: process.env.WORKFLOW_CRON_TIMEZONE,
  });

  // Store cron scheduler instance for cleanup
  cronSchedulerInstance = cronScheduler;

  // Discover cron jobs from plugin manifests and user YAML files (BEFORE HTTP server)
  bootstrapLogger.info('Discovering cron jobs');
  const cronDiscovery = new CronDiscovery({
    cliApi,
    scheduler: cronScheduler,
    logger: platform.logger,
    workspaceRoot: repoRoot,
  });

  const discovered = await cronDiscovery.discoverAll();
  bootstrapLogger.info('Cron job discovery complete', discovered);

  // Create WorkflowService for workflow definitions management
  bootstrapLogger.info('Creating WorkflowService');
  const workflowService = new WorkflowService({
    cliApi,
    platform,
    workspaceRoot: repoRoot,
  });

  // Create HTTP API server (pass cronDiscovery for refresh endpoint)
  bootstrapLogger.info('Creating HTTP server');
  const server = await createServer({
    engine,
    jobBroker,
    workflowService,
    cronScheduler,
    cronDiscovery,
    logger: platform.logger,
  });

  // Start HTTP server
  const port = parseInt(process.env.WORKFLOW_PORT || '7778', 10);
  await server.listen({ port, host: '0.0.0.0' });
  bootstrapLogger.info('HTTP API listening', { port });

  // Store server instance for cleanup
  serverInstance = server;

  // Create WorkflowWorker
  bootstrapLogger.info('Creating WorkflowWorker');
  const worker = await createWorkflowWorker({
    engine,
    cliApi,
    logger: platform.logger,
    analytics: platform.analytics,
    platform,
    workspaceRoot: repoRoot,
    concurrency: parseInt(process.env.WORKFLOW_CONCURRENCY || '5', 10),
  });

  // Store worker instance for cleanup
  workerInstance = worker;

  // Start worker
  bootstrapLogger.info('Starting WorkflowWorker');
  // Start worker in background (non-blocking)
  worker.start().catch(error => {
    bootstrapLogger.error('Worker crashed - shutting down daemon', error instanceof Error ? error : undefined);
    // Trigger graceful shutdown - daemon cannot function without worker
    process.kill(process.pid, 'SIGTERM');
  });

  // Start cron scheduler
  if (discovered.plugins + discovered.users > 0) {
    bootstrapLogger.info('Starting CronScheduler');
    await cronScheduler.start();
  } else {
    bootstrapLogger.info('No cron jobs found, skipping CronScheduler start');
  }

  bootstrapLogger.info('Workflow daemon started successfully', { port });

  // Setup graceful shutdown
  const shutdown = async (signal: string) => {
    bootstrapLogger.warn('Received shutdown signal', { signal });

    // Stop cron scheduler first (prevent new jobs from being scheduled)
    if (cronSchedulerInstance) {
      await cronSchedulerInstance.stop();
      cronSchedulerInstance = null;
    }

    // Stop worker (wait for in-flight jobs)
    if (workerInstance) {
      await workerInstance.stop();
      workerInstance = null;
    }

    // Close HTTP server
    if (serverInstance) {
      await serverInstance.close();
      serverInstance = null;
    }

    // Dispose CLI API
    await cliApi.dispose();

    // Shutdown platform (includes ExecutionBackend and all adapters)
    await platform.shutdown();
    bootstrapLogger.info('Workflow daemon shutdown complete');

    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
