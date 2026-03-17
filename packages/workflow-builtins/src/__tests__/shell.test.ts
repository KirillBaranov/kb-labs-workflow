/**
 * Unit tests for the shell built-in JSON stdout merging behaviour.
 *
 * `mergeJsonOutputs` is private inside shell.ts, so we reproduce the
 * same logic here and verify the expected contract, then assert against
 * the exported types to confirm the interface shape.
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { ShellInput, ShellOutput } from '../shell'

// ---------------------------------------------------------------------------
// Inline mirror of the private mergeJsonOutputs function.
// Any change to the logic in shell.ts must be reflected here.
// ---------------------------------------------------------------------------
function mergeJsonOutputs(output: ShellOutput): Record<string, unknown> {
  const base: Record<string, unknown> = { ...output }
  const trimmed = output.stdout.trim()
  if (!trimmed) {
    return base
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(base, parsed)
    }
  } catch {
    // Not JSON — return as-is
  }
  return base
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeOutput(stdout: string, exitCode = 0): ShellOutput {
  return {
    stdout,
    stderr: '',
    exitCode,
    ok: exitCode === 0,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('mergeJsonOutputs (shell JSON stdout merging)', () => {
  it('merges a flat JSON object from stdout into the output record', () => {
    const output = makeOutput('{"passed": true, "score": 95}')
    const result = mergeJsonOutputs(output)

    expect(result.passed).toBe(true)
    expect(result.score).toBe(95)
  })

  it('preserves the base ShellOutput fields even when merging', () => {
    const output = makeOutput('{"custom": "value"}')
    const result = mergeJsonOutputs(output)

    expect(result.stdout).toBe('{"custom": "value"}')
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.ok).toBe(true)
    expect(result.custom).toBe('value')
  })

  it('ignores invalid JSON and returns the base output unchanged', () => {
    const output = makeOutput('not json at all')
    const result = mergeJsonOutputs(output)

    expect(result.stdout).toBe('not json at all')
    expect(Object.keys(result)).toEqual(['stdout', 'stderr', 'exitCode', 'ok'])
  })

  it('ignores partial / malformed JSON and returns the base output unchanged', () => {
    const output = makeOutput('{"key": }')
    const result = mergeJsonOutputs(output)

    expect(result.stdout).toBe('{"key": }')
    expect(result.key).toBeUndefined()
  })

  it('does NOT merge JSON arrays — only plain objects are merged', () => {
    const output = makeOutput('[1, 2, 3]')
    const result = mergeJsonOutputs(output)

    // Array entries must not bleed into the output record as numeric keys
    expect(result[0]).toBeUndefined()
    expect(result[1]).toBeUndefined()
    expect(result[2]).toBeUndefined()
    // Original stdout is preserved
    expect(result.stdout).toBe('[1, 2, 3]')
  })

  it('does NOT merge primitive JSON values (string, number, boolean)', () => {
    expect(mergeJsonOutputs(makeOutput('"hello"')).stdout).toBe('"hello"')
    expect(Object.keys(mergeJsonOutputs(makeOutput('"hello"')))).toEqual([
      'stdout',
      'stderr',
      'exitCode',
      'ok',
    ])

    expect(mergeJsonOutputs(makeOutput('42')).stdout).toBe('42')
    expect(mergeJsonOutputs(makeOutput('true')).stdout).toBe('true')
  })

  it('returns base output unchanged when stdout is empty', () => {
    const result = mergeJsonOutputs(makeOutput(''))
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0, ok: true })
  })

  it('returns base output unchanged when stdout is only whitespace', () => {
    const result = mergeJsonOutputs(makeOutput('   \n  '))
    expect(result.stdout).toBe('   \n  ')
    expect(Object.keys(result)).toEqual(['stdout', 'stderr', 'exitCode', 'ok'])
  })

  it('merges nested objects from JSON stdout', () => {
    const output = makeOutput('{"meta": {"version": "1.0", "stable": true}}')
    const result = mergeJsonOutputs(output)

    expect(result.meta).toEqual({ version: '1.0', stable: true })
  })

  it('handles stdout with leading/trailing whitespace around valid JSON', () => {
    const output = makeOutput('  {"trimmed": true}  ')
    const result = mergeJsonOutputs(output)

    expect(result.trimmed).toBe(true)
  })

  it('works correctly when command fails (exitCode != 0)', () => {
    const output = makeOutput('{"error": "something went wrong"}', 1)
    const result = mergeJsonOutputs(output)

    // Merging still applies for failed commands
    expect(result.error).toBe('something went wrong')
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Type shape tests for the exported interfaces
// ---------------------------------------------------------------------------
describe('ShellInput type shape', () => {
  it('accepts a minimal input with only command', () => {
    const input: ShellInput = { command: 'echo hello' }
    expectTypeOf(input.command).toBeString()
    expectTypeOf(input.env).toEqualTypeOf<Record<string, string> | undefined>()
    expectTypeOf(input.timeout).toEqualTypeOf<number | undefined>()
    expectTypeOf(input.throwOnError).toEqualTypeOf<boolean | undefined>()
  })

  it('accepts a fully specified input', () => {
    const input: ShellInput = {
      command: 'npm test',
      env: { NODE_ENV: 'test' },
      timeout: 60000,
      throwOnError: true,
    }
    expect(input.command).toBe('npm test')
    expect(input.timeout).toBe(60000)
  })
})

describe('ShellOutput type shape', () => {
  it('has the expected fields', () => {
    const output: ShellOutput = {
      stdout: 'hello',
      stderr: '',
      exitCode: 0,
      ok: true,
    }
    expectTypeOf(output.stdout).toBeString()
    expectTypeOf(output.stderr).toBeString()
    expectTypeOf(output.exitCode).toBeNumber()
    expectTypeOf(output.ok).toBeBoolean()
  })
})
