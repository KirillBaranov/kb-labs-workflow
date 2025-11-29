/**
 * @module @kb-labs/plugin-runtime/jobs/cron/parser
 * Schedule parser for cron expressions and interval strings
 */

import type { ParsedSchedule } from './types.js';

/**
 * Parse interval string like "5m", "1h", "30s" to milliseconds
 */
export function parseInterval(interval: string): number | null {
  const match = interval.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    return null;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

/**
 * Validate cron expression (basic validation)
 * Full format: "minute hour day month weekday"
 * Example: "0 9 * * *" = every day at 9am
 */
export function validateCron(expression: string): boolean {
  const parts = expression.trim().split(/\s+/);

  // Must have 5 parts: minute hour day month weekday
  if (parts.length !== 5) {
    return false;
  }

  // Basic validation for each part
  const [minute, hour, day, month, weekday] = parts;

  // Minute: 0-59 or * or */n
  if (!isValidCronPart(minute, 0, 59)) return false;

  // Hour: 0-23 or * or */n
  if (!isValidCronPart(hour, 0, 23)) return false;

  // Day: 1-31 or * or */n
  if (!isValidCronPart(day, 1, 31)) return false;

  // Month: 1-12 or * or */n
  if (!isValidCronPart(month, 1, 12)) return false;

  // Weekday: 0-7 (0 and 7 are Sunday) or * or */n
  if (!isValidCronPart(weekday, 0, 7)) return false;

  return true;
}

/**
 * Validate a single cron part
 */
function isValidCronPart(part: string, min: number, max: number): boolean {
  // Wildcard
  if (part === '*') return true;

  // Step values: */5
  if (part.startsWith('*/')) {
    const step = parseInt(part.slice(2), 10);
    return !isNaN(step) && step > 0;
  }

  // Range: 1-5
  if (part.includes('-')) {
    const [start, end] = part.split('-').map(n => parseInt(n, 10));
    return !isNaN(start) && !isNaN(end) && start >= min && end <= max && start <= end;
  }

  // List: 1,3,5
  if (part.includes(',')) {
    const values = part.split(',').map(n => parseInt(n, 10));
    return values.every(v => !isNaN(v) && v >= min && v <= max);
  }

  // Single value
  const value = parseInt(part, 10);
  return !isNaN(value) && value >= min && value <= max;
}

/**
 * Parse schedule string (cron or interval)
 */
export function parseSchedule(schedule: string): ParsedSchedule | null {
  // Try interval first
  const intervalMs = parseInterval(schedule);
  if (intervalMs !== null) {
    return {
      type: 'interval',
      expression: schedule,
      intervalMs,
    };
  }

  // Try cron
  if (validateCron(schedule)) {
    return {
      type: 'cron',
      expression: schedule,
      cron: schedule,
    };
  }

  return null;
}

/**
 * Calculate next run time for a schedule
 */
export function getNextRun(parsed: ParsedSchedule, after: number = Date.now()): number {
  if (parsed.type === 'interval') {
    // Simple interval: just add the interval to current time
    return after + (parsed.intervalMs || 0);
  }

  // Cron: calculate next matching time
  return getNextCronRun(parsed.cron || '', after);
}

/**
 * Calculate next cron run time
 * This is a simplified implementation - for production, use a proper cron library
 */
function getNextCronRun(expression: string, after: number): number {
  const parts = expression.split(/\s+/);
  const [minutePart, hourPart, dayPart, monthPart, weekdayPart] = parts;

  const date = new Date(after);

  // Start from next minute
  date.setSeconds(0);
  date.setMilliseconds(0);
  date.setMinutes(date.getMinutes() + 1);

  // Try to find next matching time (max 366 days ahead)
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchesCron(date, minutePart, hourPart, dayPart, monthPart, weekdayPart)) {
      return date.getTime();
    }
    date.setMinutes(date.getMinutes() + 1);
  }

  // Couldn't find match (should not happen with valid cron)
  return after + 60 * 1000; // Default to 1 minute
}

/**
 * Check if date matches cron expression
 */
function matchesCron(
  date: Date,
  minutePart: string,
  hourPart: string,
  dayPart: string,
  monthPart: string,
  weekdayPart: string
): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const day = date.getDate();
  const month = date.getMonth() + 1; // 0-indexed
  const weekday = date.getDay(); // 0=Sunday

  if (!matchesCronPart(minute, minutePart, 0, 59)) return false;
  if (!matchesCronPart(hour, hourPart, 0, 23)) return false;
  if (!matchesCronPart(day, dayPart, 1, 31)) return false;
  if (!matchesCronPart(month, monthPart, 1, 12)) return false;
  if (!matchesCronPart(weekday, weekdayPart, 0, 7)) return false;

  return true;
}

/**
 * Check if value matches cron part
 */
function matchesCronPart(value: number, part: string, min: number, max: number): boolean {
  // Wildcard
  if (part === '*') return true;

  // Step values: */5
  if (part.startsWith('*/')) {
    const step = parseInt(part.slice(2), 10);
    return value % step === 0;
  }

  // Range: 1-5
  if (part.includes('-')) {
    const [start, end] = part.split('-').map(n => parseInt(n, 10));
    return value >= start && value <= end;
  }

  // List: 1,3,5
  if (part.includes(',')) {
    const values = part.split(',').map(n => parseInt(n, 10));
    return values.includes(value);
  }

  // Single value
  return value === parseInt(part, 10);
}
