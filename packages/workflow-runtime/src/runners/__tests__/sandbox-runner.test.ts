/**
 * Tests for SandboxRunner
 *
 * Critical infrastructure tests covering:
 * - Plugin handler resolution (plugin:id/handler)
 * - CLI command resolution (command:name)
 * - CLI Adapter pattern (workflow input → CLI format)
 * - ExecutionBackend integration
 * - Error handling and validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SandboxRunner } from '../sandbox-runner.js';
import type { ExecutionBackend, ExecutionRequest } from '@kb-labs/plugin-execution';
import type { CliAPI } from '@kb-labs/cli-api';
import type { StepExecutionRequest, StepExecutionResult } from '../../types.js';
import type { Logger } from '@kb-labs/shared-logger';

// Mock ExecutionBackend
class MockExecutionBackend implements ExecutionBackend {
  executeCallCount = 0;
  lastRequest?: ExecutionRequest;
  mockResult: any = { ok: true, data: { result: 'success' }, executionTimeMs: 100 };

  async execute(request: ExecutionRequest, options?: { signal?: AbortSignal }) {
    this.executeCallCount++;
    this.lastRequest = request;

    // Simulate abort
    if (options?.signal?.aborted) {
      return {
        ok: false,
        error: { message: 'Aborted', code: 'ABORTED' },
      };
    }

    return this.mockResult;
  }
}

// Mock CliAPI
class MockCliAPI implements Partial<CliAPI> {
  mockManifests: any[] = [];

  snapshot() {
    return { manifests: this.mockManifests };
  }
}

// Mock Logger
const createMockLogger = (): Logger => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => createMockLogger()),
});

describe('SandboxRunner', () => {
  let backend: MockExecutionBackend;
  let cliApi: MockCliAPI;
  let runner: SandboxRunner;
  let logger: Logger;

  beforeEach(() => {
    backend = new MockExecutionBackend();
    cliApi = new MockCliAPI();
    logger = createMockLogger();

    runner = new SandboxRunner({
      backend: backend as any,
      cliApi: cliApi as any,
      workspaceRoot: '/test/workspace',
      defaultTimeout: 60000,
    });
  });

  describe('Validation', () => {
    it('should fail if step.uses is missing', async () => {
      const request: StepExecutionRequest = {
        spec: { name: 'test-step' }, // Missing 'uses'
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('INVALID_STEP');
      expect(result.error?.message).toContain('requires "uses" field');
    });

    it('should fail on unsupported uses format', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'invalid:format:here',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('COMMAND_RESOLUTION_FAILED');
      expect(result.error?.message).toContain('Unsupported uses format');
    });

    it('should handle aborted signal early', async () => {
      const controller = new AbortController();
      controller.abort();

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
        signal: controller.signal,
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('cancelled');
      expect(result.error?.code).toBe('STEP_CANCELLED');
    });
  });

  describe('Plugin Handler Resolution (plugin:id/handler)', () => {
    beforeEach(() => {
      // Mock plugin manifest
      cliApi.mockManifests = [
        {
          pluginId: 'test-plugin',
          pluginRoot: '/plugins/test-plugin',
          manifest: {
            version: '1.0.0',
            workflows: {
              handlers: [
                { id: 'my-handler', handler: './dist/handlers/my-handler.js' },
                { id: 'nested/handler', handler: './dist/handlers/nested/handler.js' },
              ],
            },
          },
        },
      ];
    });

    it('should resolve plugin handler correctly', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test-plugin/my-handler',
          with: { foo: 'bar' },
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('success');
      expect(backend.executeCallCount).toBe(1);
      expect(backend.lastRequest?.pluginRoot).toBe('/plugins/test-plugin');
      expect(backend.lastRequest?.handlerRef).toBe('./dist/handlers/my-handler.js');
      expect(backend.lastRequest?.input).toEqual({ foo: 'bar' });
    });

    it('should resolve nested handler paths', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test-plugin/nested/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('success');
      expect(backend.lastRequest?.handlerRef).toBe('./dist/handlers/nested/handler.js');
    });

    it('should fail if plugin not found', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:non-existent/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('COMMAND_RESOLUTION_FAILED');
      expect(result.error?.message).toContain('Plugin not found');
    });

    it('should fail if handler not found', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test-plugin/non-existent',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('COMMAND_RESOLUTION_FAILED');
      expect(result.error?.message).toContain('Workflow handler not found');
    });

    it('should fail on invalid plugin reference format', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test-plugin', // Missing handler
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('COMMAND_RESOLUTION_FAILED');
      expect(result.error?.message).toContain('Invalid plugin reference');
    });
  });

  describe('CLI Command Resolution (command:name)', () => {
    beforeEach(() => {
      // Mock CLI command manifest
      cliApi.mockManifests = [
        {
          pluginId: 'mind',
          pluginRoot: '/plugins/mind',
          manifest: {
            version: '2.0.0',
            cli: {
              commands: [
                { id: 'mind:rag-index', handler: './dist/cli/commands/rag-index.js' },
                { id: 'mind:rag-query', handler: './dist/cli/commands/rag-query.js' },
              ],
            },
          },
        },
      ];
    });

    it('should resolve CLI command correctly', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'index-step',
          uses: 'command:mind:rag-index',
          with: { scope: 'default', incremental: true },
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
        workspace: '/custom/workspace',
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('success');
      expect(backend.executeCallCount).toBe(1);
      expect(backend.lastRequest?.pluginRoot).toBe('/plugins/mind');
      expect(backend.lastRequest?.handlerRef).toBe('./dist/cli/commands/rag-index.js');
    });

    it('should fail if CLI command not found', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'command:non-existent',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('COMMAND_RESOLUTION_FAILED');
      expect(result.error?.message).toContain('CLI command not found');
    });
  });

  describe('CLI Adapter Pattern', () => {
    beforeEach(() => {
      cliApi.mockManifests = [
        {
          pluginId: 'mind',
          pluginRoot: '/plugins/mind',
          manifest: {
            version: '2.0.0',
            cli: {
              commands: [
                { id: 'mind:rag-index', handler: './dist/cli/commands/rag-index.js' },
              ],
            },
          },
        },
      ];
    });

    it('should adapt workflow input to CLI format', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'index-step',
          uses: 'command:mind:rag-index',
          with: { scope: 'default', incremental: true },
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
        workspace: '/my/workspace',
      };

      await runner.execute(request);

      // Verify CLI Adapter transformed input
      expect(backend.lastRequest?.input).toEqual({
        argv: [],
        flags: { scope: 'default', incremental: true },
        cwd: '/my/workspace',
      });
    });

    it('should use workspaceRoot if request.workspace not provided', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'index-step',
          uses: 'command:mind:rag-index',
          with: { scope: 'default' },
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
        // No workspace field
      };

      await runner.execute(request);

      expect(backend.lastRequest?.input).toEqual({
        argv: [],
        flags: { scope: 'default' },
        cwd: '/test/workspace', // From runner constructor
      });
    });

    it('should pass through already CLI-formatted input', async () => {
      const cliInput = {
        argv: ['arg1', 'arg2'],
        flags: { verbose: true },
        cwd: '/custom/cwd',
      };

      const request: StepExecutionRequest = {
        spec: {
          name: 'index-step',
          uses: 'command:mind:rag-index',
          with: cliInput,
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      await runner.execute(request);

      // Should NOT transform already CLI-formatted input
      expect(backend.lastRequest?.input).toEqual(cliInput);
    });

    it('should handle empty input (with: undefined)', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'index-step',
          uses: 'command:mind:rag-index',
          // No 'with' field
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      await runner.execute(request);

      expect(backend.lastRequest?.input).toEqual({
        argv: [],
        flags: {},
        cwd: '/test/workspace',
      });
    });
  });

  describe('ExecutionBackend Integration', () => {
    beforeEach(() => {
      cliApi.mockManifests = [
        {
          pluginId: 'test',
          pluginRoot: '/plugins/test',
          manifest: {
            version: '1.0.0',
            workflows: {
              handlers: [{ id: 'handler', handler: './handler.js' }],
            },
          },
        },
      ];
    });

    it('should build correct ExecutionRequest', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
          with: { foo: 'bar' },
        },
        context: {
          runId: 'run-123',
          jobId: 'job-456',
          stepId: 'step-789',
          attempt: 2,
          trace: { traceId: 'trace-abc' },
          logger,
        },
        workspace: '/custom/workspace',
      };

      await runner.execute(request);

      const execReq = backend.lastRequest!;

      expect(execReq.executionId).toMatch(/^exec_step-789_/);
      expect(execReq.descriptor.pluginId).toBe('test');
      expect(execReq.descriptor.pluginVersion).toBe('1.0.0');
      expect(execReq.descriptor.hostType).toBe('workflow');
      expect(execReq.descriptor.requestId).toBe('trace-abc');
      expect(execReq.descriptor.hostContext).toEqual({
        host: 'workflow',
        workflowId: 'run-123',
        runId: 'run-123',
        jobId: 'job-456',
        stepId: 'step-789',
        attempt: 2,
        input: { foo: 'bar' },
      });
      expect(execReq.pluginRoot).toBe('/plugins/test');
      expect(execReq.handlerRef).toBe('./handler.js');
      expect(execReq.input).toEqual({ foo: 'bar' });
      expect(execReq.workspace).toEqual({
        type: 'local',
        cwd: '/custom/workspace',
      });
      expect(execReq.timeoutMs).toBe(60000);
    });

    it('should map successful backend result to step result', async () => {
      backend.mockResult = {
        ok: true,
        data: { message: 'success', count: 42 },
        executionTimeMs: 1234,
      };

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ message: 'success', count: 42 });
    });

    it('should wrap non-object result in { result } wrapper', async () => {
      backend.mockResult = {
        ok: true,
        data: 'simple string result',
        executionTimeMs: 100,
      };

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('success');
      expect(result.outputs).toEqual({ result: 'simple string result' });
    });

    it('should map backend failure to step failure', async () => {
      backend.mockResult = {
        ok: false,
        error: {
          message: 'Handler execution failed',
          code: 'HANDLER_ERROR',
          stack: 'Error: ...',
          details: { reason: 'timeout' },
        },
      };

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('failed');
      expect(result.error?.message).toBe('Handler execution failed');
      expect(result.error?.code).toBe('HANDLER_ERROR');
      expect(result.error?.stack).toBe('Error: ...');
      expect(result.error?.details).toEqual({ reason: 'timeout' });
    });

    it('should map backend cancellation to step cancellation', async () => {
      backend.mockResult = {
        ok: false,
        error: {
          message: 'Execution aborted',
          code: 'ABORTED',
        },
      };

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      const result = await runner.execute(request);

      expect(result.status).toBe('cancelled');
      expect(result.error?.code).toBe('STEP_CANCELLED');
    });

    it('should pass signal to backend.execute()', async () => {
      const controller = new AbortController();

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
        signal: controller.signal,
      };

      // Abort mid-flight
      setTimeout(() => controller.abort(), 10);

      await runner.execute(request);

      expect(backend.executeCallCount).toBe(1);
    });
  });

  describe('Logging', () => {
    beforeEach(() => {
      cliApi.mockManifests = [
        {
          pluginId: 'test',
          pluginRoot: '/plugins/test',
          manifest: {
            version: '1.0.0',
            workflows: {
              handlers: [{ id: 'handler', handler: './handler.js' }],
            },
          },
        },
      ];
    });

    it('should log execution start', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      await runner.execute(request);

      expect(logger.info).toHaveBeenCalledWith(
        'Executing plugin handler',
        expect.objectContaining({
          stepId: 'step-1',
          pluginId: 'test',
          handler: './handler.js',
        })
      );
    });

    it('should log successful completion', async () => {
      backend.mockResult = {
        ok: true,
        data: { result: 'success' },
        executionTimeMs: 1234,
      };

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      await runner.execute(request);

      expect(logger.info).toHaveBeenCalledWith(
        'Plugin handler completed',
        expect.objectContaining({
          stepId: 'step-1',
          executionTimeMs: 1234,
        })
      );
    });

    it('should log failures', async () => {
      backend.mockResult = {
        ok: false,
        error: {
          message: 'Handler failed',
          code: 'ERROR',
        },
      };

      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:test/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      await runner.execute(request);

      expect(logger.error).toHaveBeenCalledWith(
        'Plugin handler failed',
        expect.objectContaining({
          stepId: 'step-1',
          error: 'Handler failed',
          code: 'ERROR',
        })
      );
    });

    it('should log validation errors', async () => {
      const request: StepExecutionRequest = {
        spec: { name: 'test-step' }, // Missing uses
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      await runner.execute(request);

      expect(logger.error).toHaveBeenCalledWith(
        'SandboxRunner validation failed',
        expect.objectContaining({
          stepId: 'step-1',
          message: expect.stringContaining('requires "uses" field'),
        })
      );
    });

    it('should log resolution errors', async () => {
      const request: StepExecutionRequest = {
        spec: {
          name: 'test-step',
          uses: 'plugin:non-existent/handler',
        },
        context: {
          runId: 'run-1',
          jobId: 'job-1',
          stepId: 'step-1',
          attempt: 1,
          logger,
        },
      };

      await runner.execute(request);

      expect(logger.error).toHaveBeenCalledWith(
        'Plugin command resolution failed',
        expect.objectContaining({
          stepId: 'step-1',
          uses: 'plugin:non-existent/handler',
        })
      );
    });
  });
});
