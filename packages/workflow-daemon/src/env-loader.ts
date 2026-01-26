/**
 * @module @kb-labs/workflow-daemon/env-loader
 * Load environment variables from .env file
 * Does not overwrite existing variables
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Load environment variables from .env file.
 * Does not overwrite existing variables.
 */
export function loadEnvFile(cwd: string): void {
  const envPath = path.join(cwd, '.env');

  if (!existsSync(envPath)) {
    return;
  }

  try {
    const content = readFileSync(envPath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      // Parse KEY=VALUE
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) {
        continue;
      }

      const key = trimmed.substring(0, equalIndex).trim();
      const value = trimmed.substring(equalIndex + 1).trim();

      // Remove quotes if present
      const unquotedValue = value
        .replace(/^["'](.*?)["']$/, '$1')
        .replace(/^`(.*?)`$/, '$1');

      // Set only if variable is not already set
      if (key && !(key in process.env)) {
        process.env[key] = unquotedValue;
      }
    }
  } catch (_error) {
    // Silently ignore .env loading errors
    // Not critical for daemon operation
  }
}
