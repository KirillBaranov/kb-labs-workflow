import { describe, it, expect } from 'vitest'
import { evaluateExpression, interpolateString } from '../expressions'
import type { ExpressionContext } from '../types'

describe('Expression Evaluation', () => {
  const baseContext: ExpressionContext = {
    env: { NODE_ENV: 'production', VERSION: '1.0.0' },
    trigger: {
      type: 'push',
      actor: 'user',
      payload: { ref: 'refs/heads/main' },
    },
    steps: {},
  }

  it('should evaluate boolean literals', () => {
    expect(evaluateExpression('true', baseContext)).toBe(true)
    expect(evaluateExpression('false', baseContext)).toBe(false)
  })

  it('should evaluate equality', () => {
    expect(evaluateExpression('env.NODE_ENV == "production"', baseContext)).toBe(true)
    expect(evaluateExpression('env.NODE_ENV == "development"', baseContext)).toBe(false)
  })

  it('should evaluate inequality', () => {
    expect(evaluateExpression('env.NODE_ENV != "development"', baseContext)).toBe(true)
    expect(evaluateExpression('env.NODE_ENV != "production"', baseContext)).toBe(false)
  })

  it('should evaluate contains function', () => {
    expect(evaluateExpression('contains(env.VERSION, "1.0")', baseContext)).toBe(true)
    expect(evaluateExpression('contains(env.VERSION, "2.0")', baseContext)).toBe(false)
  })

  it('should evaluate startsWith function', () => {
    expect(evaluateExpression('startsWith(trigger.payload.ref, "refs/heads/")', baseContext)).toBe(true)
    expect(evaluateExpression('startsWith(trigger.payload.ref, "refs/tags/")', baseContext)).toBe(false)
  })

  it('should evaluate endsWith function', () => {
    expect(evaluateExpression('endsWith(trigger.payload.ref, "/main")', baseContext)).toBe(true)
    expect(evaluateExpression('endsWith(trigger.payload.ref, "/develop")', baseContext)).toBe(false)
  })

  it('should handle parentheses', () => {
    expect(evaluateExpression('(true)', baseContext)).toBe(true)
    expect(evaluateExpression('(env.NODE_ENV == "production")', baseContext)).toBe(true)
  })

  it('should interpolate strings', () => {
    const result = interpolateString('Hello ${{ env.NODE_ENV }}', baseContext)
    expect(result).toBe('Hello production')
  })

  it('should interpolate multiple expressions', () => {
    const result = interpolateString('Version ${{ env.VERSION }} by ${{ trigger.actor }}', baseContext)
    expect(result).toBe('Version 1.0.0 by user')
  })

  it('should handle step outputs', () => {
    const contextWithSteps: ExpressionContext = {
      ...baseContext,
      steps: {
        test: {
          outputs: {
            exitCode: 0,
            result: 'success',
          },
        },
      },
    }

    // String comparison - both sides are coerced to string
    expect(evaluateExpression('steps.test.outputs.exitCode == 0', contextWithSteps)).toBe(true)
    expect(evaluateExpression('steps.test.outputs.result == success', contextWithSteps)).toBe(true)
  })

  it('should handle empty expressions', () => {
    expect(evaluateExpression('', baseContext)).toBe(false)
    expect(evaluateExpression('   ', baseContext)).toBe(false)
  })
})

