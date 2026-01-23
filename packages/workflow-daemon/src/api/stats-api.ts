/**
 * @module @kb-labs/workflow-daemon/api/stats-api
 * REST API endpoint for dashboard statistics
 */

import type { FastifyInstance } from 'fastify';
import type { WorkflowEngine, WorkflowService } from '@kb-labs/workflow-engine';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobBroker } from '../job-broker.js';
import type { CronScheduler } from '../cron-scheduler.js';
import type { DashboardStatsResponse } from '@kb-labs/workflow-contracts';

export interface RegisterStatsAPIOptions {
  server: FastifyInstance;
  engine: WorkflowEngine;
  jobBroker: JobBroker;
  workflowService?: WorkflowService;
  cronScheduler?: CronScheduler;
  logger: ILogger;
}

/**
 * Register dashboard statistics endpoint.
 *
 * Endpoints:
 * - GET /api/v1/stats - Get dashboard statistics
 */
export function registerStatsAPI(options: RegisterStatsAPIOptions): void {
  const { server, engine, jobBroker, workflowService, cronScheduler, logger } = options;

  // GET /api/v1/stats - Dashboard statistics
  server.get('/api/v1/stats', async (request, reply) => {
    try {
      // Get workflow stats
      let workflowStats = { total: 0, active: 0, inactive: 0 };
      if (workflowService) {
        const workflows = await workflowService.listAll({});
        workflowStats.total = workflows.length;
        workflowStats.active = workflows.filter((w) => w.status === 'active').length;
        workflowStats.inactive = workflows.filter((w) => w.status === 'inactive').length;
      }

      // Get job stats from engine metrics
      const metrics = await engine.getMetrics();
      const jobStats = {
        running: metrics.activeExecutions || 0,
        pending: metrics.queueSize || 0,
        completed: metrics.completedJobs || 0,
        failed: metrics.failedJobs || 0,
      };

      // Get cron stats
      let cronStats = { total: 0, enabled: 0, disabled: 0 };
      if (cronScheduler) {
        const cronJobs = cronScheduler.getRegisteredJobs();
        cronStats.total = cronJobs.length;
        cronStats.enabled = cronJobs.filter((j) => j.enabled).length;
        cronStats.disabled = cronJobs.filter((j) => !j.enabled).length;
      }

      // Get active executions (currently running jobs)
      const activeExecutions = await engine.getActiveExecutions();
      const activeExecutionsData = activeExecutions.map((exec) => ({
        id: exec.id,
        type: exec.handler || 'unknown',
        workflowName: exec.workflowName,
        status: 'running' as const,
        progress: exec.progress,
        progressMessage: exec.progressMessage,
        startedAt: exec.startedAt?.toISOString() || new Date().toISOString(),
        durationMs: exec.startedAt ? Date.now() - exec.startedAt.getTime() : undefined,
      }));

      // Get recent activity (last 10 completed/failed jobs)
      // TODO: This requires a proper job history API from engine
      // For now, return empty array or mock data
      const recentActivity: DashboardStatsResponse['recentActivity'] = [];

      const response: DashboardStatsResponse = {
        workflows: workflowStats,
        jobs: jobStats,
        crons: cronStats,
        activeExecutions: activeExecutionsData,
        recentActivity,
      };

      return { ok: true, data: response };
    } catch (error) {
      logger.error('[stats-api] Error fetching dashboard stats', error instanceof Error ? error : undefined);
      reply.code(500);
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to fetch dashboard stats',
      };
    }
  });

  logger.info('[stats-api] Stats API endpoint registered');
}
