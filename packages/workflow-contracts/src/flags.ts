/**
 * Flag definitions for workflow CLI commands
 * Uses defineFlags from @kb-labs/sdk for type safety
 */

import { defineFlags } from '@kb-labs/sdk';

/**
 * Flags for workflow:status command
 */
export const statusFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output result as JSON',
    default: false,
  },
  'job-id': {
    type: 'string',
    description: 'Job ID to get status for',
  },
});

/**
 * Flags for workflow:logs command
 */
export const logsFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output result as JSON',
    default: false,
  },
  'job-id': {
    type: 'string',
    description: 'Job ID to get logs for (required)',
  },
  follow: {
    type: 'boolean',
    description: 'Follow log output (stream new logs)',
    default: false,
  },
});

/**
 * Flags for workflow:metrics command
 */
export const metricsFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output result as JSON',
    default: false,
  },
});

/**
 * Flags for workflow:health command
 */
export const healthFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output result as JSON',
    default: false,
  },
});

/**
 * Flags for workflow:list command
 */
export const listFlags = defineFlags({
  json: {
    type: 'boolean',
    description: 'Output result as JSON',
    default: false,
  },
  status: {
    type: 'string',
    description: 'Filter by status (running, completed, failed)',
  },
  type: {
    type: 'string',
    description: 'Filter by type: "runs" (active executions), "cron" (scheduled jobs)',
  },
});

// Type exports for use in command handlers
export type StatusFlags = typeof statusFlags.type;
export type LogsFlags = typeof logsFlags.type;
export type MetricsFlags = typeof metricsFlags.type;
export type HealthFlags = typeof healthFlags.type;
export type ListFlags = typeof listFlags.type;
