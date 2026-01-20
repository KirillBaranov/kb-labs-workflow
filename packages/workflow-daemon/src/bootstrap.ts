/**
 * @module @kb-labs/workflow-daemon/bootstrap
 * Bootstrap workflow daemon - initialize platform, engine, worker, and HTTP server
 */

import { loadEnvFile } from './env-loader.js';
import { initializePlatform } from './platform.js';
import { platform } from '@kb-labs/core-runtime';
import { WorkflowEngine } from '@kb-labs/workflow-engine';
import { createWorkflowWorker } from './worker.js';
import { JobBroker } from './job-broker.js';
import { CronScheduler } from './cron-scheduler.js';
import { CronDiscovery } from './cron-discovery.js';
import { createServer } from './server.js';
import { createCliAPI } from '@kb-labs/cli-api';
import { findRepoRoot } from '@kb-labs/core-sys';
import { randomUUID } from 'node:crypto';
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
  // Load .env file if present
  loadEnvFile(cwd);

  // Detect repo root
  const repoRoot = await findRepoRoot(cwd);

  // Initialize platform adapters from kb.config.json
  await initializePlatform(repoRoot);

  // Now we can use platform.logger (configured from kb.config.json)
  const bootstrapLogger = platform.logger.child({
    layer: 'workflow',
    service: 'bootstrap',
    traceId: randomUUID(),
  });

  bootstrapLogger.info('Workflow daemon starting', { repoRoot });

  // Validate ExecutionBackend is available
  if (!platform.executionBackend) {
    bootstrapLogger.error('ExecutionBackend not available in platform');
    throw new Error('ExecutionBackend is required for workflow daemon');
  }

  // Initialize CLI API for plugin discovery
  bootstrapLogger.info('Initializing CLI API for plugin discovery');
  const cliApi = await createCliAPI({
    discovery: {
      strategies: ['workspace', 'pkg', 'dir', 'file'],
      roots: [repoRoot],
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
      mode: 'consumer', // Workflow daemon consumes snapshots
    },
  });

  await cliApi.initialize();
  const plugins = await cliApi.listPlugins();
  bootstrapLogger.info('CLI API discovery complete', {
    pluginsFound: plugins.length,
    pluginIds: plugins.map(p => `${p.id}@${p.version}`),
  });

  // Create WorkflowEngine with ExecutionBackend
  bootstrapLogger.info('Creating WorkflowEngine');
  const engine = new WorkflowEngine({
    cache: platform.cache,
    events: platform.eventBus,
    logger: platform.logger,
    executionBackend: platform.executionBackend,
  });

  // Resume interrupted jobs from previous shutdown
  bootstrapLogger.info('Resuming interrupted jobs');
  await engine.resumeInterruptedJobs();

  // Create JobBroker
  bootstrapLogger.info('Creating JobBroker');
  const jobBroker = new JobBroker(engine, platform.logger);

  // Create CronScheduler (before HTTP server so it can be exposed via API)
  bootstrapLogger.info('Creating CronScheduler');
  const cronScheduler = new CronScheduler({
    jobBroker,
    logger: platform.logger,
    timezone: process.env.WORKFLOW_CRON_TIMEZONE,
  });

  // Store cron scheduler instance for cleanup
  cronSchedulerInstance = cronScheduler;

  // Create HTTP API server
  bootstrapLogger.info('Creating HTTP server');
  const server = await createServer({
    engine,
    jobBroker,
    cronScheduler,
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
    executionBackend: platform.executionBackend,
    cliApi,
    logger: platform.logger,
    workspaceRoot: repoRoot,
    concurrency: parseInt(process.env.WORKFLOW_CONCURRENCY || '5', 10),
  });

  // Store worker instance for cleanup
  workerInstance = worker;

  // Start worker
  bootstrapLogger.info('Starting WorkflowWorker');
  // Start worker in background (non-blocking)
  worker.start().catch(error => {
    bootstrapLogger.error('Worker crashed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // Discover cron jobs from plugin manifests and user YAML files
  bootstrapLogger.info('Discovering cron jobs');
  const cronDiscovery = new CronDiscovery({
    cliApi,
    scheduler: cronScheduler,
    logger: platform.logger,
    workspaceRoot: repoRoot,
  });

  const discovered = await cronDiscovery.discoverAll();
  bootstrapLogger.info('Cron job discovery complete', discovered);

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
