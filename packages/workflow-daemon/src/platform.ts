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
    console.log('[workflow-daemon] Platform already initialized, skipping');
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
      console.log('[workflow-daemon] No kb.config.json found, using NoOp adapters');
      await initPlatform({ adapters: {} }, cwd);
      _initialized = true;
      return;
    }

    // Read config
    const result = await readJsonWithDiagnostics<{ platform?: PlatformConfig }>(configPath);
    if (!result.ok) {
      console.warn('[workflow-daemon] Failed to read kb.config.json, using NoOp adapters', {
        errors: result.diagnostics.map(d => d.message),
      });
      await initPlatform({ adapters: {} }, cwd);
      _initialized = true;
      return;
    }

    // Extract platform config
    const platformConfig = result.data.platform;
    if (!platformConfig) {
      console.log('[workflow-daemon] No platform config in kb.config.json, using NoOp adapters');
      await initPlatform({ adapters: {} }, cwd);
      _initialized = true;
      return;
    }

    // Initialize platform with config
    console.log('[workflow-daemon] Initializing platform adapters', {
      configPath,
      adapters: Object.keys(platformConfig.adapters ?? {}),
    });

    await initPlatform(platformConfig, cwd);
    _initialized = true;

    // Now we can use platform.logger (initialized)
    platform.logger.info('Workflow daemon platform adapters initialized', {
      adapters: Object.keys(platformConfig.adapters ?? {}),
      hasExecutionBackend: !!platform.executionBackend,
    });

  } catch (error) {
    console.warn('[workflow-daemon] Platform initialization failed, using NoOp adapters', {
      error: error instanceof Error ? error.message : String(error),
    });
    await initPlatform({ adapters: {} }, cwd);
    _initialized = true;
  }
}
