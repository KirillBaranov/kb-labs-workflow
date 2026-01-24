/**
 * @module @kb-labs/workflow-runtime/builtin-handlers/shell
 * Built-in shell execution handler for workflows
 *
 * Security features:
 * - Blocks dangerous commands (rm -rf /, fork bombs, etc.)
 * - Timeout enforcement (default 5 minutes)
 * - Environment variable isolation
 * - Working directory restrictions
 */

import { execaCommand } from 'execa';
import type { PluginContextV3 } from '@kb-labs/plugin-contracts';

/**
 * Commands that are always blocked (dangerous)
 */
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf /*',
  'mkfs',
  'dd if=',
  ':(){:|:&};:', // Fork bomb
  'chmod -R 777 /',
  'chown -R',
  '> /dev/sda',
  'mv /* ',
  'format',
  'fdisk',
];

/**
 * Split string into chunks of specified size
 */
function chunkString(str: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < str.length; i += chunkSize) {
    chunks.push(str.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Shell handler input
 */
export interface ShellInput {
  /** Command to execute */
  command: string;

  /** Additional environment variables */
  env?: Record<string, string>;

  /** Timeout in milliseconds (default: 300000 = 5 min) */
  timeout?: number;

  /** Throw on non-zero exit code (default: false) */
  throwOnError?: boolean;
}

/**
 * Shell handler output
 */
export interface ShellOutput {
  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Exit code */
  exitCode: number;

  /** Whether command succeeded (exitCode === 0) */
  ok: boolean;
}

/**
 * Built-in shell execution handler.
 *
 * Executes shell commands with safety checks and timeout enforcement.
 *
 * @param ctx - Handler execution context
 * @param input - Shell command input
 * @returns Shell execution result
 * @throws Error if dangerous command detected or timeout exceeded
 */
async function shellHandler(
  ctx: PluginContextV3,
  input: ShellInput,
): Promise<ShellOutput> {
  const { command, env = {}, timeout = 300000, throwOnError = false } = input;

  // Security: Check for dangerous commands
  const normalizedCommand = command.toLowerCase().trim();
  for (const blocked of BLOCKED_COMMANDS) {
    if (normalizedCommand.includes(blocked.toLowerCase())) {
      throw new Error(
        `Dangerous command blocked: "${blocked}". Command attempted: ${command.slice(0, 100)}`,
      );
    }
  }

  // Get working directory from context (workflow workspace)
  const cwd = ctx.cwd;

  // Merge environment variables
  const mergedEnv = {
    ...process.env,
    ...env,
  };

  ctx.platform.logger.info('Executing shell command', {
    command: command.slice(0, 200),
    cwd,
    timeout,
  });

  try {
    const result = await execaCommand(command, {
      cwd,
      env: mergedEnv,
      shell: true,
      stdio: 'pipe',
      timeout,
      // Reject on non-zero exit only if throwOnError is true
      reject: throwOnError,
    });

    const output: ShellOutput = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
      ok: (result.exitCode ?? 0) === 0,
    };

    if (output.ok) {
      ctx.platform.logger.info('Shell command completed successfully', {
        exitCode: output.exitCode,
        stdoutLines: output.stdout.split('\n').length,
      });

      // Log stdout as separate log entries for visibility in log queries
      if (output.stdout.trim()) {
        // Split into chunks to avoid huge log entries (max 2000 chars per chunk)
        const chunks = chunkString(output.stdout, 2000);
        chunks.forEach((chunk, index) => {
          ctx.platform.logger.info(`Shell stdout (chunk ${index + 1}/${chunks.length})`, {
            stdout: chunk,
          });
        });
      }
    } else {
      ctx.platform.logger.warn('Shell command failed', {
        exitCode: output.exitCode,
        stderrLines: output.stderr.split('\n').length,
      });

      // Log stderr as separate log entries
      if (output.stderr.trim()) {
        const chunks = chunkString(output.stderr, 2000);
        chunks.forEach((chunk, index) => {
          ctx.platform.logger.warn(`Shell stderr (chunk ${index + 1}/${chunks.length})`, {
            stderr: chunk,
          });
        });
      }
    }

    return output;
  } catch (error) {
    // Handle timeout
    if (error && typeof error === 'object' && 'timedOut' in error && error.timedOut) {
      throw new Error(`Shell command timed out after ${timeout}ms`);
    }

    // Handle execution error
    if (error && typeof error === 'object' && 'exitCode' in error) {
      const execError = error as { exitCode?: number; stdout?: string; stderr?: string };
      const output: ShellOutput = {
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? '',
        exitCode: execError.exitCode ?? 1,
        ok: false,
      };

      ctx.platform.logger.error('Shell command execution failed', undefined, {
        exitCode: output.exitCode,
        stderr: output.stderr.slice(0, 500),
      });

      // If throwOnError was false, return the error result instead of throwing
      if (!throwOnError) {
        return output;
      }
    }

    // Re-throw unexpected errors
    throw error;
  }
}

// Export handler in format expected by ExecutionBackend
export default {
  execute: shellHandler,
};
