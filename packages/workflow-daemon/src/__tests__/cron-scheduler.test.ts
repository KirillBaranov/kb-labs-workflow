/**
 * Tests for CronScheduler
 *
 * Critical infrastructure tests covering:
 * - Cron expression validation
 * - Job registration (plugin and user)
 * - Job scheduling and execution
 * - Start/stop lifecycle
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronScheduler } from '../cron-scheduler.js';
import type { ILogger } from '@kb-labs/core-platform';
import type { JobBroker } from '../job-broker.js';
import type { WorkflowEngine } from '@kb-labs/workflow-engine';
import type { PluginCronJob, UserCronJob } from '@kb-labs/workflow-contracts';

// Mock JobBroker
class MockJobBroker implements Partial<JobBroker> {
  submittedJobs: any[] = [];

  async submit(job: any): Promise<any> {
    this.submittedJobs.push(job);
    return { id: `run-${Date.now()}` };
  }
}

// Mock WorkflowEngine
class MockWorkflowEngine implements Partial<WorkflowEngine> {
  runFromInlineCalls: any[] = [];

  async runFromInline(spec: any, input: any): Promise<any> {
    this.runFromInlineCalls.push({ spec, input });
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

describe('CronScheduler', () => {
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
      timezone: 'America/New_York',
    });
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  describe('Initialization', () => {
    it('should create scheduler with required dependencies', () => {
      expect(scheduler).toBeDefined();
      expect(scheduler.isSchedulerRunning()).toBe(false);
      expect(scheduler.getRegisteredJobs()).toHaveLength(0);
    });

    it('should use default timezone if not provided', () => {
      const scheduler2 = new CronScheduler({
        jobBroker: jobBroker as any,
        workflowEngine: workflowEngine as any,
        logger,
        // No timezone
      });

      expect(scheduler2).toBeDefined();
    });
  });

  describe('Plugin Job Registration', () => {
    it('should register plugin cron job', () => {
      const pluginJob: PluginCronJob = {
        id: 'daily-backup',
        schedule: '0 2 * * *', // 2 AM daily
        handler: './handlers/backup.js',
        input: { target: '/data' },
        enabled: true,
        priority: 'high',
      };

      scheduler.registerPluginJob('backup-plugin', pluginJob);

      const jobs = scheduler.getRegisteredJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('plugin:backup-plugin:daily-backup');
      expect(jobs[0].source).toBe('plugin');
      expect(jobs[0].schedule).toBe('0 2 * * *');
      expect(jobs[0].handler).toBe('./handlers/backup.js');
      expect(jobs[0].enabled).toBe(true);
      expect(jobs[0].priority).toBe('high');
    });

    it('should use default timezone for plugin job', () => {
      const pluginJob: PluginCronJob = {
        id: 'test-job',
        schedule: '* * * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', pluginJob);

      const job = scheduler.getJob('plugin:test-plugin:test-job');
      expect(job?.timezone).toBe('America/New_York'); // From constructor
    });

    it('should use custom timezone for plugin job', () => {
      const pluginJob: PluginCronJob = {
        id: 'test-job',
        schedule: '* * * * *',
        handler: './handler.js',
        enabled: true,
        timezone: 'Asia/Tokyo',
      };

      scheduler.registerPluginJob('test-plugin', pluginJob);

      const job = scheduler.getJob('plugin:test-plugin:test-job');
      expect(job?.timezone).toBe('Asia/Tokyo');
    });

    it('should skip duplicate plugin job registration', () => {
      const pluginJob: PluginCronJob = {
        id: 'test-job',
        schedule: '* * * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', pluginJob);
      scheduler.registerPluginJob('test-plugin', pluginJob);

      const jobs = scheduler.getRegisteredJobs();
      expect(jobs).toHaveLength(1);

      expect(logger.warn).toHaveBeenCalledWith(
        'Cron job already registered, skipping',
        expect.objectContaining({
          cronJobId: 'plugin:test-plugin:test-job',
        })
      );
    });
  });

  describe('User Job Registration', () => {
    it('should register user cron job', () => {
      const userJob: UserCronJob = {
        id: 'mind-reindex',
        name: 'Mind RAG Reindex',
        schedule: '0 * * * *', // Every hour
        enabled: true,
        priority: 'low',
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

      scheduler.registerUserJob('mind-reindex-hourly.yml', userJob);

      const jobs = scheduler.getRegisteredJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe('user:mind-reindex-hourly.yml');
      expect(jobs[0].source).toBe('user');
      expect(jobs[0].schedule).toBe('0 * * * *');
      expect(jobs[0].workflowSpec).toBeDefined();
      expect(jobs[0].workflowSpec?.name).toBe('Mind RAG Reindex');
      expect(jobs[0].enabled).toBe(true);
      expect(jobs[0].priority).toBe('low');
    });

    it('should use default timezone for user job', () => {
      const userJob: UserCronJob = {
        id: 'test-workflow',
        name: 'Test',
        schedule: '* * * * *',
        enabled: true,
        jobs: { main: { runsOn: 'local', steps: [] } },
      };

      scheduler.registerUserJob('test.yml', userJob);

      const job = scheduler.getJob('user:test.yml');
      expect(job?.timezone).toBe('America/New_York');
    });

    it('should skip duplicate user job registration', () => {
      const userJob: UserCronJob = {
        id: 'test',
        name: 'Test',
        schedule: '* * * * *',
        enabled: true,
        jobs: { main: { runsOn: 'local', steps: [] } },
      };

      scheduler.registerUserJob('test.yml', userJob);
      scheduler.registerUserJob('test.yml', userJob);

      const jobs = scheduler.getRegisteredJobs();
      expect(jobs).toHaveLength(1);

      expect(logger.warn).toHaveBeenCalledWith(
        'Cron job already registered, skipping',
        expect.objectContaining({
          cronJobId: 'user:test.yml',
        })
      );
    });
  });

  describe('Cron Expression Validation', () => {
    it('should skip jobs with invalid cron expressions on start', async () => {
      const invalidJob: PluginCronJob = {
        id: 'invalid-job',
        schedule: 'invalid cron', // Invalid
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', invalidJob);

      await scheduler.start();

      expect(scheduler.isSchedulerRunning()).toBe(true);

      expect(logger.error).toHaveBeenCalledWith(
        'Invalid cron expression',
        undefined,
        expect.objectContaining({
          cronJobId: 'plugin:test-plugin:invalid-job',
          schedule: 'invalid cron',
        })
      );
    });

    it('should accept valid cron expressions', async () => {
      const validJob: PluginCronJob = {
        id: 'valid-job',
        schedule: '*/5 * * * *', // Every 5 minutes
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', validJob);

      await scheduler.start();

      expect(logger.info).toHaveBeenCalledWith(
        'Cron job scheduled',
        expect.objectContaining({
          cronJobId: 'plugin:test-plugin:valid-job',
          schedule: '*/5 * * * *',
        })
      );
    });
  });

  describe('Start/Stop Lifecycle', () => {
    it('should start scheduler and schedule enabled jobs', async () => {
      const job1: PluginCronJob = {
        id: 'job1',
        schedule: '* * * * *',
        handler: './handler1.js',
        enabled: true,
      };

      const job2: PluginCronJob = {
        id: 'job2',
        schedule: '*/5 * * * *',
        handler: './handler2.js',
        enabled: true,
      };

      scheduler.registerPluginJob('plugin1', job1);
      scheduler.registerPluginJob('plugin2', job2);

      await scheduler.start();

      expect(scheduler.isSchedulerRunning()).toBe(true);

      expect(logger.info).toHaveBeenCalledWith(
        'Starting CronScheduler',
        expect.objectContaining({
          totalJobs: 2,
        })
      );

      expect(logger.info).toHaveBeenCalledWith(
        'CronScheduler started',
        expect.objectContaining({
          scheduledJobs: 2,
        })
      );
    });

    it('should skip disabled jobs on start', async () => {
      const enabledJob: PluginCronJob = {
        id: 'enabled',
        schedule: '* * * * *',
        handler: './enabled.js',
        enabled: true,
      };

      const disabledJob: PluginCronJob = {
        id: 'disabled',
        schedule: '* * * * *',
        handler: './disabled.js',
        enabled: false,
      };

      scheduler.registerPluginJob('plugin1', enabledJob);
      scheduler.registerPluginJob('plugin2', disabledJob);

      await scheduler.start();

      expect(logger.debug).toHaveBeenCalledWith(
        'Skipping disabled cron job',
        expect.objectContaining({
          cronJobId: 'plugin:plugin2:disabled',
        })
      );

      expect(logger.info).toHaveBeenCalledWith(
        'CronScheduler started',
        expect.objectContaining({
          scheduledJobs: 1, // Only enabled job
        })
      );
    });

    it('should warn if already running on start', async () => {
      await scheduler.start();
      await scheduler.start(); // Second call

      expect(logger.warn).toHaveBeenCalledWith('CronScheduler already running');
    });

    it('should stop scheduler and clear scheduled tasks', async () => {
      const job: PluginCronJob = {
        id: 'test-job',
        schedule: '* * * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', job);

      await scheduler.start();
      expect(scheduler.isSchedulerRunning()).toBe(true);

      await scheduler.stop();
      expect(scheduler.isSchedulerRunning()).toBe(false);

      expect(logger.info).toHaveBeenCalledWith(
        'Stopping CronScheduler',
        expect.objectContaining({
          scheduledJobs: 1,
        })
      );

      expect(logger.info).toHaveBeenCalledWith('CronScheduler stopped');
    });

    it('should do nothing if stop called when not running', async () => {
      await scheduler.stop();
      // Should not throw, just return
      expect(scheduler.isSchedulerRunning()).toBe(false);
    });
  });

  describe('Job Retrieval', () => {
    it('should get all registered jobs', () => {
      const job1: PluginCronJob = {
        id: 'job1',
        schedule: '* * * * *',
        handler: './handler1.js',
        enabled: true,
      };

      const job2: UserCronJob = {
        id: 'job2',
        name: 'User Job',
        schedule: '*/5 * * * *',
        enabled: true,
        jobs: { main: { runsOn: 'local', steps: [] } },
      };

      scheduler.registerPluginJob('plugin1', job1);
      scheduler.registerUserJob('user-job.yml', job2);

      const jobs = scheduler.getRegisteredJobs();

      expect(jobs).toHaveLength(2);
      expect(jobs[0].id).toBe('plugin:plugin1:job1');
      expect(jobs[1].id).toBe('user:user-job.yml');
    });

    it('should get specific job by ID', () => {
      const job: PluginCronJob = {
        id: 'test-job',
        schedule: '* * * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', job);

      const retrieved = scheduler.getJob('plugin:test-plugin:test-job');

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('plugin:test-plugin:test-job');
      expect(retrieved?.handler).toBe('./handler.js');
    });

    it('should return undefined for non-existent job', () => {
      const retrieved = scheduler.getJob('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('Clear All', () => {
    it('should clear all registered jobs', () => {
      const job1: PluginCronJob = {
        id: 'job1',
        schedule: '* * * * *',
        handler: './handler1.js',
        enabled: true,
      };

      const job2: PluginCronJob = {
        id: 'job2',
        schedule: '*/5 * * * *',
        handler: './handler2.js',
        enabled: true,
      };

      scheduler.registerPluginJob('plugin1', job1);
      scheduler.registerPluginJob('plugin2', job2);

      expect(scheduler.getRegisteredJobs()).toHaveLength(2);

      scheduler.clearAll();

      expect(scheduler.getRegisteredJobs()).toHaveLength(0);

      expect(logger.info).toHaveBeenCalledWith(
        'Clearing all registered cron jobs',
        expect.objectContaining({
          count: 2,
        })
      );
    });
  });

  describe('Job Execution - Plugin Jobs', () => {
    it('should submit plugin job to JobBroker', async () => {
      const job: PluginCronJob = {
        id: 'backup-job',
        schedule: '0 2 * * *',
        handler: './handlers/backup.js',
        input: { target: '/data' },
        enabled: true,
        priority: 'high',
        metadata: { version: '1.0' },
      };

      scheduler.registerPluginJob('backup-plugin', job);

      // Manually trigger execution (instead of waiting for cron)
      await (scheduler as any).executeCronJob('plugin:backup-plugin:backup-job', {
        id: 'plugin:backup-plugin:backup-job',
        source: 'plugin',
        schedule: '0 2 * * *',
        timezone: 'UTC',
        handler: './handlers/backup.js',
        input: { target: '/data' },
        enabled: true,
        priority: 'high',
        metadata: { version: '1.0' },
      });

      expect(jobBroker.submittedJobs).toHaveLength(1);
      expect(jobBroker.submittedJobs[0]).toMatchObject({
        handler: './handlers/backup.js',
        input: { target: '/data' },
        priority: 'high',
        metadata: expect.objectContaining({
          version: '1.0',
          cronJobId: 'plugin:backup-plugin:backup-job',
          scheduledBy: 'cron',
        }),
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Executing cron job',
        expect.objectContaining({
          cronJobId: 'plugin:backup-plugin:backup-job',
        })
      );

      expect(logger.info).toHaveBeenCalledWith(
        'Cron job submitted',
        expect.objectContaining({
          cronJobId: 'plugin:backup-plugin:backup-job',
        })
      );
    });
  });

  describe('Job Execution - User Jobs', () => {
    it('should run user workflow via WorkflowEngine', async () => {
      const job: UserCronJob = {
        id: 'mind-reindex',
        name: 'Mind RAG Reindex',
        schedule: '0 * * * *',
        enabled: true,
        priority: 'low',
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

      scheduler.registerUserJob('mind-reindex-hourly.yml', job);

      // Manually trigger execution
      await (scheduler as any).executeCronJob('user:mind-reindex-hourly.yml', {
        id: 'user:mind-reindex-hourly.yml',
        source: 'user',
        schedule: '0 * * * *',
        timezone: 'UTC',
        enabled: true,
        priority: 'low',
        workflowSpec: {
          name: 'Mind RAG Reindex',
          jobs: job.jobs,
        },
      });

      expect(workflowEngine.runFromInlineCalls).toHaveLength(1);

      const call = workflowEngine.runFromInlineCalls[0];
      expect(call.spec.name).toBe('Mind RAG Reindex');
      expect(call.spec.jobs).toEqual(job.jobs);
      expect(call.input.trigger).toEqual({
        type: 'schedule',
        payload: expect.objectContaining({
          cronJobId: 'user:mind-reindex-hourly.yml',
        }),
      });

      expect(logger.info).toHaveBeenCalledWith(
        'Cron workflow submitted',
        expect.objectContaining({
          cronJobId: 'user:mind-reindex-hourly.yml',
          workflowName: 'Mind RAG Reindex',
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should log error if job execution fails', async () => {
      // Mock JobBroker to throw error
      jobBroker.submit = vi.fn().mockRejectedValue(new Error('Broker error'));

      const job: PluginCronJob = {
        id: 'failing-job',
        schedule: '* * * * *',
        handler: './handler.js',
        enabled: true,
      };

      scheduler.registerPluginJob('test-plugin', job);

      await (scheduler as any).executeCronJob('plugin:test-plugin:failing-job', {
        id: 'plugin:test-plugin:failing-job',
        source: 'plugin',
        schedule: '* * * * *',
        timezone: 'UTC',
        handler: './handler.js',
        enabled: true,
      });

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to execute cron job',
        expect.any(Error),
        expect.objectContaining({
          cronJobId: 'plugin:test-plugin:failing-job',
        })
      );
    });

    it('should handle invalid cron job configuration', async () => {
      // Invalid: no handler and no workflowSpec
      const invalidJob = {
        id: 'invalid',
        source: 'plugin' as const,
        schedule: '* * * * *',
        timezone: 'UTC',
        enabled: true,
        // Missing handler
      };

      await (scheduler as any).executeCronJob('invalid-job', invalidJob);

      expect(logger.error).toHaveBeenCalledWith(
        'Failed to execute cron job',
        expect.any(Error),
        expect.objectContaining({
          cronJobId: 'invalid-job',
        })
      );
    });
  });
});
