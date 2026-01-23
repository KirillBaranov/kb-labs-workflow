/**
 * KB Labs Workflow CLI - Manifest V3
 *
 * Provides CLI commands for interacting with Workflow Daemon via HTTP API.
 */

import { defineCommandFlags, combinePermissions } from '@kb-labs/sdk';
import {
  healthFlags,
  metricsFlags,
  statusFlags,
  logsFlags,
  listFlags,
  runFlags,
} from './flags';
import {
  WORKFLOW_BASE_PATH,
  WORKFLOW_ROUTES,
} from '@kb-labs/workflow-contracts';

/**
 * Minimal permissions - workflow-cli only makes HTTP requests
 * No file system or git access needed
 */
const pluginPermissions = combinePermissions()
  .withEnv(['WORKFLOW_DAEMON_URL'])
  .withNetwork({
    fetch: ['http://localhost:*', 'http://127.0.0.1:*'],
  })
  .withQuotas({
    timeoutMs: 30000, // 30 seconds for HTTP requests
    memoryMb: 128,
  })
  .build();

export const manifest = {
  schema: 'kb.plugin/3',
  id: '@kb-labs/workflow',
  version: '0.1.0',

  display: {
    name: 'Workflow CLI',
    description: 'CLI commands for interacting with KB Labs Workflow Daemon.',
    tags: ['workflow', 'daemon', 'jobs', 'orchestration'],
  },

  // No platform requirements - just HTTP client
  platform: {
    requires: [],
    optional: [],
  },

  cli: {
    commands: [
      // workflow:health - Check daemon health
      {
        id: 'workflow:health',
        group: 'workflow',
        describe: 'Check workflow daemon health status.',
        longDescription:
          'Performs a health check on the workflow daemon by making an HTTP request to /health endpoint. ' +
          'Use this to verify the daemon is running and responding.',

        handler: './commands/health.js#default',
        handlerPath: './commands/health.js',

        flags: defineCommandFlags(healthFlags),

        examples: [
          'kb workflow health',
          'kb workflow health --json',
        ],
      },

      // workflow:metrics - Get metrics
      {
        id: 'workflow:metrics',
        group: 'workflow',
        describe: 'Get workflow daemon metrics.',
        longDescription:
          'Fetches comprehensive metrics from the workflow daemon including total runs, queued jobs, ' +
          'running jobs, completed jobs, and failure counts.',

        handler: './commands/metrics.js#default',
        handlerPath: './commands/metrics.js',

        flags: defineCommandFlags(metricsFlags),

        examples: [
          'kb workflow metrics',
          'kb workflow metrics --json',
        ],
      },

      // workflow:status - Get job status
      {
        id: 'workflow:status',
        group: 'workflow',
        describe: 'Get status of a specific workflow job.',
        longDescription:
          'Retrieves detailed status information for a specific job by ID, including current state, ' +
          'start time, and completion time if finished.',

        handler: './commands/status.js#default',
        handlerPath: './commands/status.js',

        flags: defineCommandFlags(statusFlags),

        examples: [
          'kb workflow status --job-id=abc123',
          'kb workflow status --job-id=abc123 --json',
        ],
      },

      // workflow:logs - Get job logs
      {
        id: 'workflow:logs',
        group: 'workflow',
        describe: 'Get logs for a specific workflow job.',
        longDescription:
          'Fetches execution logs for a specific job by ID. Note: Log integration with platform.logger ' +
          'is pending, currently returns placeholder data.',

        handler: './commands/logs.js#default',
        handlerPath: './commands/logs.js',

        flags: defineCommandFlags(logsFlags),

        examples: [
          'kb workflow logs --job-id=abc123',
          'kb workflow logs --job-id=abc123 --json',
          'kb workflow logs --job-id=abc123 --follow',
        ],
      },

      // workflow:list - List active executions
      {
        id: 'workflow:list',
        group: 'workflow',
        describe: 'List active workflow executions.',
        longDescription:
          'Lists all currently active workflow executions or cron jobs. Can be filtered by status (running, queued, ' +
          'completed, failed, cancelled) or type (runs, cron).',

        handler: './commands/list.js#default',
        handlerPath: './commands/list.js',

        flags: defineCommandFlags(listFlags),

        examples: [
          'kb workflow list',
          'kb workflow list --status=running',
          'kb workflow list --type=cron',
          'kb workflow list --json',
        ],
      },

      // workflow:run - Submit job for execution
      {
        id: 'workflow:run',
        group: 'workflow',
        describe: 'Submit a job for execution.',
        longDescription:
          'Submits a job to the workflow daemon for execution. Requires a handler (plugin command) and ' +
          'optionally accepts input parameters as JSON. Can wait for job completion with --wait flag.',

        handler: './commands/run.js#default',
        handlerPath: './commands/run.js',

        flags: defineCommandFlags(runFlags),

        examples: [
          'kb workflow run --handler=mind:rag-query --input=\'{"text":"test"}\'',
          'kb workflow run --handler=mind:rag-query --input=\'{"text":"test"}\' --wait',
          'kb workflow run --handler=mind:rag-query --input=\'{"text":"test"}\' --priority=8',
          'kb workflow run --handler=mind:rag-query --input=\'{"text":"test"}\' --json',
        ],
      },
    ],
  },

  // REST API routes (proxy to workflow daemon)
  rest: {
    basePath: WORKFLOW_BASE_PATH,
    routes: [
      // GET /workflows - List workflow definitions
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.WORKFLOWS,
        handler: './rest/workflows-list-handler.js#default',
        describe: 'List all workflow definitions',
        output: {
          zod: '@kb-labs/workflow-contracts#WorkflowListResponseSchema',
        },
      },
      // GET /workflows/:id - Get workflow detail
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.WORKFLOW_DETAIL,
        handler: './rest/workflow-detail-handler.js#default',
        describe: 'Get workflow definition details',
        output: {
          zod: '@kb-labs/workflow-contracts#WorkflowInfoSchema',
        },
      },
      // POST /workflows/:id/run - Run workflow
      {
        method: 'POST',
        path: WORKFLOW_ROUTES.WORKFLOW_RUN,
        handler: './rest/workflow-run-handler.js#default',
        describe: 'Run a workflow',
        input: {
          zod: '@kb-labs/workflow-contracts#WorkflowRunRequestSchema',
        },
      },
      // GET /workflows/jobs - List jobs
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.JOBS,
        handler: './rest/jobs-list-handler.js#default',
        describe: 'List workflow jobs with optional filters',
        output: {
          zod: '@kb-labs/workflow-contracts#JobListResponseSchema',
        },
      },
      // GET /workflows/jobs/:jobId - Get job detail
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.JOB_DETAIL,
        handler: './rest/job-detail-handler.js#default',
        describe: 'Get detailed information about a specific job',
        output: {
          zod: '@kb-labs/workflow-contracts#JobStatusInfoSchema',
        },
      },
      // POST /workflows/jobs/:jobId/cancel - Cancel job
      {
        method: 'POST',
        path: WORKFLOW_ROUTES.JOB_CANCEL,
        handler: './rest/job-cancel-handler.js#default',
        describe: 'Cancel a running or pending job',
        output: {
          zod: '@kb-labs/workflow-contracts#JobCancelResponseSchema',
        },
      },
      // GET /workflows/cron - List cron jobs
      {
        method: 'GET',
        path: WORKFLOW_ROUTES.CRON,
        handler: './rest/cron-list-handler.js#default',
        describe: 'List all registered cron jobs',
        output: {
          zod: '@kb-labs/workflow-contracts#CronListResponseSchema',
        },
      },
    ],
  },

  permissions: pluginPermissions,
};
