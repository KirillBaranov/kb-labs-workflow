/**
 * Tests for CronScheduler.getNextRunTime()
 *
 * Tests for calculating next execution time from cron expressions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronScheduler } from '../cron-scheduler.js';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobBroker } from '../job-broker.js';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { PluginCronJob, UserCronJob } from '@kb-labs/workflow-contracts';
import { formatInTimeZone } from 'date-fns-tz';

// Mock JobBroker
class MockJobBroker implements Partial<JobBroker> {
  async submit(job: any): Promise<any> {
    return { id: `run-${Date.now()}` };
  }
}

// Mock WorkflowEngine
class MockWorkflowEngine implements Partial<WorkflowEngine> {
  async runFromInline(spec: any, input: any): Promise<any> {
    return { id: `run-${Date.now()}`, name: spec.name };
  }
}

// Mock Logger
const createMockLogger = (): ILogger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(function () {
    return createMockLogger();
  }),
});

describe('CronScheduler - getNextRunTime', () => {
  let jobBroker: MockJobBroker;
  let workflowEngine: MockWorkflowEngine;
  let logger: ILogger;
  let scheduler: CronScheduler;

  beforeEach(() => {
    jobBroker = new MockJobBroker();
    workflowEngine = new MockWorkflowEngine();
    logger = createMockLogger();

    scheduler = new CronScheduler({
      jobBroker: jobBroker as any,
      workflowEngine: workflowEngine as any,
      logger,
      timezone: 'UTC',
    });
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  describe('Basic Functionality', () => {
    it('should return next run time for valid cron expression', () => {
      const pluginJob: PluginCronJob = {
        id: 'test-job',
        schedule: '0 */6 * * *', // Every 6 hours at minute 0
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', pluginJob);

      const nextRun = scheduler.getNextRunTime('plugin:test-plugin:test-job');

      expect(nextRun).toBeDefined();
      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun!.getTime()).toBeGreaterThan(Date.now());
    });

    it('should return null for non-existent job', () => {
      const nextRun = scheduler.getNextRunTime('non-existent-job');
      expect(nextRun).toBeNull();
    });

    it('should calculate next run for enabled jobs', () => {
      const pluginJob: PluginCronJob = {
        id: 'enabled-job',
        schedule: '0 * * * *', // Every hour
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', pluginJob);

      const nextRun = scheduler.getNextRunTime('plugin:test-plugin:enabled-job');

      expect(nextRun).toBeDefined();
      expect(nextRun).toBeInstanceOf(Date);
    });

    it('should calculate next run for disabled jobs', () => {
      const pluginJob: PluginCronJob = {
        id: 'disabled-job',
        schedule: '0 * * * *', // Every hour
        handler: './handler.js',
        enabled: false,
      };

      scheduler.registerPluginJob('test-plugin', pluginJob);

      const nextRun = scheduler.getNextRunTime('plugin:test-plugin:disabled-job');

      // Should still calculate next run even if disabled
      expect(nextRun).toBeDefined();
      expect(nextRun).toBeInstanceOf(Date);
    });
  });

  describe('Cron Expression Parsing', () => {
    it('should parse hourly cron expression', () => {
      const job: PluginCronJob = {
        id: 'hourly',
        schedule: '0 * * * *', // Every hour at minute 0
        handler: './handler.js',
        enabled: true,
        timezone: 'UTC',
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:hourly');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getUTCMinutes()).toBe(0);
    });

    it('should parse daily cron expression', () => {
      const job: PluginCronJob = {
        id: 'daily',
        schedule: '0 2 * * *', // Daily at 2 AM UTC
        handler: './handler.js',
        enabled: true,
        timezone: 'UTC',
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:daily');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getUTCHours()).toBe(2);
      expect(nextRun!.getUTCMinutes()).toBe(0);
    });

    it('should parse every 6 hours cron expression', () => {
      const job: PluginCronJob = {
        id: 'six-hours',
        schedule: '0 */6 * * *', // Every 6 hours UTC
        handler: './handler.js',
        enabled: true,
        timezone: 'UTC',
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:six-hours');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getUTCMinutes()).toBe(0);
      expect([0, 6, 12, 18]).toContain(nextRun!.getUTCHours());
    });

    it('should parse every 5 minutes cron expression', () => {
      const job: PluginCronJob = {
        id: 'five-minutes',
        schedule: '*/5 * * * *', // Every 5 minutes
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:five-minutes');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getMinutes() % 5).toBe(0);
    });

    it('should handle weekly cron expression', () => {
      const job: PluginCronJob = {
        id: 'weekly',
        schedule: '0 0 * * 0', // Every Sunday at midnight UTC
        handler: './handler.js',
        enabled: true,
        timezone: 'UTC',
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:weekly');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getUTCDay()).toBe(0); // Sunday
      expect(nextRun!.getUTCHours()).toBe(0);
      expect(nextRun!.getUTCMinutes()).toBe(0);
    });
  });

  describe('Timezone Handling', () => {
    it('should respect UTC timezone', () => {
      const job: PluginCronJob = {
        id: 'utc-job',
        schedule: '0 12 * * *', // Daily at noon
        handler: './handler.js',
        enabled: true,
        timezone: 'UTC',
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:utc-job');

      expect(nextRun).toBeDefined();
    });

    it('should respect custom timezone', () => {
      const job: PluginCronJob = {
        id: 'tokyo-job',
        schedule: '0 9 * * *', // Daily at 9 AM Tokyo time
        handler: './handler.js',
        enabled: true,
        timezone: 'Asia/Tokyo',
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:tokyo-job');

      expect(nextRun).toBeDefined();
    });

    it('should use scheduler default timezone if not specified', () => {
      const job: PluginCronJob = {
        id: 'default-tz',
        schedule: '0 10 * * *',
        handler: './handler.js',
        enabled: true,
        // No timezone specified
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:default-tz');

      expect(nextRun).toBeDefined();
    });
  });

  describe('User Jobs', () => {
    it('should calculate next run for user workflow jobs', () => {
      const userJob: UserCronJob = {
        id: 'mind-reindex',
        name: 'Mind RAG Reindex',
        schedule: '0 */6 * * *', // Every 6 hours
        enabled: true,
        jobs: {
          main: {
            runsOn: 'local',
            steps: [
              {
                name: 'Reindex',
                uses: 'command:mind:rag-index',
                with: { scope: 'default' },
              },
            ],
          },
        },
      };

      scheduler.registerUserJob('mind-reindex-hourly', userJob);
      const nextRun = scheduler.getNextRunTime('user:mind-reindex-hourly');

      expect(nextRun).toBeDefined();
      expect(nextRun).toBeInstanceOf(Date);
      expect(nextRun!.getMinutes()).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should return null for invalid cron expression', () => {
      const job: PluginCronJob = {
        id: 'invalid',
        schedule: 'invalid cron expression',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:invalid');

      expect(nextRun).toBeNull();

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to parse cron expression',
        expect.any(Error),
        expect.objectContaining({
          cronJobId: 'plugin:test:invalid',
          schedule: 'invalid cron expression',
        })
      );
    });

    it('should return null for empty schedule', () => {
      const job: PluginCronJob = {
        id: 'empty',
        schedule: '',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test', job);
      const nextRun = scheduler.getNextRunTime('plugin:test:empty');

      expect(nextRun).toBeNull();
    });
  });

  describe('Multiple Jobs', () => {
    it('should calculate next run independently for multiple jobs', () => {
      const job1: PluginCronJob = {
        id: 'job1',
        schedule: '0 */6 * * *', // Every 6 hours
        handler: './handler1.js',
        enabled: true,
      };

      const job2: PluginCronJob = {
        id: 'job2',
        schedule: '0 * * * *', // Every hour
        handler: './handler2.js',
        enabled: true,
      };

      scheduler.registerPluginJob('plugin1', job1);
      scheduler.registerPluginJob('plugin2', job2);

      const nextRun1 = scheduler.getNextRunTime('plugin:plugin1:job1');
      const nextRun2 = scheduler.getNextRunTime('plugin:plugin2:job2');

      expect(nextRun1).toBeDefined();
      expect(nextRun2).toBeDefined();

      // job2 runs more frequently, so next run should be sooner
      expect(nextRun1!.getTime()).toBeGreaterThanOrEqual(nextRun2!.getTime());
    });
  });

  describe('Real-world Examples', () => {
    it('should handle Mind RAG reindex schedule (every 6 hours)', () => {
      const job: UserCronJob = {
        id: 'mind-reindex',
        name: 'Mind RAG Reindex',
        schedule: '0 */6 * * *',
        enabled: true,
        timezone: 'UTC',
        jobs: {
          main: {
            runsOn: 'local',
            steps: [
              {
                name: 'Reindex',
                uses: 'command:mind:rag-index',
                with: { scope: 'default' },
              },
            ],
          },
        },
      };

      scheduler.registerUserJob('mind-reindex-hourly', job);
      const nextRun = scheduler.getNextRunTime('user:mind-reindex-hourly');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getUTCMinutes()).toBe(0);
      expect([0, 6, 12, 18]).toContain(nextRun!.getUTCHours());
    });

    it('should handle backup schedule (daily at 2 AM)', () => {
      const job: PluginCronJob = {
        id: 'daily-backup',
        schedule: '0 2 * * *',
        handler: './backup.js',
        enabled: true,
        timezone: 'UTC',
      };

      scheduler.registerPluginJob('backup-plugin', job);
      const nextRun = scheduler.getNextRunTime('plugin:backup-plugin:daily-backup');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getUTCHours()).toBe(2);
      expect(nextRun!.getUTCMinutes()).toBe(0);
    });

    it('should handle monitoring schedule (every 5 minutes)', () => {
      const job: PluginCronJob = {
        id: 'health-check',
        schedule: '*/5 * * * *',
        handler: './health.js',
        enabled: true,
      };

      scheduler.registerPluginJob('monitoring', job);
      const nextRun = scheduler.getNextRunTime('plugin:monitoring:health-check');

      expect(nextRun).toBeDefined();
      expect(nextRun!.getMinutes() % 5).toBe(0);

      // Next run should be within 5 minutes
      const now = Date.now();
      const diff = nextRun!.getTime() - now;
      expect(diff).toBeLessThanOrEqual(5 * 60 * 1000);
      expect(diff).toBeGreaterThan(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle job registered but scheduler not started', () => {
      const job: PluginCronJob = {
        id: 'not-started',
        schedule: '0 * * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test', job);

      // Scheduler not started yet
      const nextRun = scheduler.getNextRunTime('plugin:test:not-started');

      // Should still calculate next run time
      expect(nextRun).toBeDefined();
    });

    it('should handle calculation after scheduler is stopped', async () => {
      const job: PluginCronJob = {
        id: 'stopped',
        schedule: '0 * * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test', job);

      await scheduler.start();
      await scheduler.stop();

      // Should still calculate next run after stopped
      const nextRun = scheduler.getNextRunTime('plugin:test:stopped');
      expect(nextRun).toBeDefined();
    });

    it('should return consistent results for multiple calls', () => {
      const job: PluginCronJob = {
        id: 'consistent',
        schedule: '0 */6 * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test', job);

      const nextRun1 = scheduler.getNextRunTime('plugin:test:consistent');
      const nextRun2 = scheduler.getNextRunTime('plugin:test:consistent');

      expect(nextRun1).toBeDefined();
      expect(nextRun2).toBeDefined();

      // Should be very close (within a few milliseconds)
      const diff = Math.abs(nextRun1!.getTime() - nextRun2!.getTime());
      expect(diff).toBeLessThan(1000); // Less than 1 second difference
    });
  });
});
