/**
 * @module @kb-labs/workflow-daemon/platform
 * Platform services provider for Workflow Daemon.
 * Uses core-runtime to initialize real adapters from kb.config.json.
 */

import type { PlatformConfig } from '@kb-labs/core-runtime';
import { initPlatform, platform } from '@kb-labs/core-runtime';
import { findNearestConfig, readJsonWithDiagnostics } from '@kb-labs/core-config';

/**
 * Whether platform has been initialized.
 */
let _initialized = false;

/**
 * Initialize platform from kb.config.json.
 * Loads real adapters (LLM, embeddings, vector store, etc.) from config.
 * Falls back to NoOp adapters if config not found or missing.
 *
 * @param cwd - Workspace root directory to search for kb.config.json
 */
export async function initializePlatform(cwd: string = process.cwd()): Promise<void> {
  if (_initialized) {
    // Use stderr since logger not initialized yet
    process.stderr.write('[workflow-daemon] Platform already initialized, skipping\n');
    return;
  }

  try {
    // Try to find kb.config.json
    const { path: configPath } = await findNearestConfig({
      startDir: cwd,
      filenames: [
        '.kb/kb.config.json',
        'kb.config.json',
      ],
    });

    if (!configPath) {
      process.stderr.write('[workflow-daemon] No kb.config.json found, using NoOp adapters\n');
      await initPlatform({ adapters: {} }, cwd);
      _initialized = true;
      return;
    }

    // Read config
    const result = await readJsonWithDiagnostics<{ platform?: PlatformConfig }>(configPath);
    if (!result.ok) {
      process.stderr.write(`[workflow-daemon] Failed to read kb.config.json, using NoOp adapters: ${result.diagnostics.map(d => d.message).join(', ')}\n`);
      await initPlatform({ adapters: {} }, cwd);
      _initialized = true;
      return;
    }

    // Store raw config globally for ConfigAdapter (so useConfig() works)
    interface KBGlobal {
      __KB_RAW_CONFIG__?: unknown;
    }
    (globalThis as KBGlobal).__KB_RAW_CONFIG__ = result.data;

    // Extract platform config
    const platformConfig = result.data.platform;
    if (!platformConfig) {
      process.stderr.write('[workflow-daemon] No platform config in kb.config.json, using NoOp adapters\n');
      await initPlatform({ adapters: {} }, cwd);
      _initialized = true;
      return;
    }

    // Initialize platform with config
    const adapterKeys = Object.keys(platformConfig.adapters ?? {}).join(', ');
    process.stderr.write(`[workflow-daemon] Initializing platform adapters: ${configPath} [${adapterKeys}]\n`);

    await initPlatform(platformConfig, cwd);
    _initialized = true;

    // Now we can use platform.logger (initialized)
    platform.logger.info('Workflow daemon platform adapters initialized', {
      adapters: Object.keys(platformConfig.adapters ?? {}),
      hasExecutionBackend: !!platform.executionBackend,
    });

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[workflow-daemon] Platform initialization failed, using NoOp adapters: ${errorMsg}\n`);
    await initPlatform({ adapters: {} }, cwd);
    _initialized = true;
  }
}
