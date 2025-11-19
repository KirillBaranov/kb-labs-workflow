import type { ExpressionContext, WorkflowInvocationSpec } from './types'

/**
 * Parse workflow: uses string into WorkflowInvocationSpec
 * @param uses - The uses string (e.g., "workflow:workspace:ai-ci")
 * @returns WorkflowInvocationSpec or null if not a workflow uses
 */
export function parseWorkflowUses(uses: string): WorkflowInvocationSpec | null {
  if (!uses.startsWith('workflow:')) {
    return null
  }

  const workflowId = uses.slice('workflow:'.length)
  if (!workflowId) {
    return null
  }

  return {
    type: 'workflow',
    workflowId,
    mode: 'wait', // default
    inheritEnv: true, // default
  }
}

/**
 * Extract all ${{ expression }} patterns from a string
 */
export function extractExpressions(str: string): string[] {
  const pattern = /\$\{\{\s*([^}]+)\s*\}\}/g
  const matches: string[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(str)) !== null) {
    matches.push(match[1]!.trim())
  }

  return matches
}

/**
 * Evaluate a boolean expression
 * Supported operators: ==, !=, &&, ||, !
 * Supported functions: contains(), startsWith(), endsWith()
 * Supported contexts: env.*, trigger.*, steps.*.outputs.*
 */
export function evaluateExpression(
  expr: string,
  context: ExpressionContext,
): boolean {
  const trimmed = expr.trim()

  // Handle logical operators
  if (trimmed.includes('&&')) {
    const parts = trimmed.split('&&').map((p) => p.trim())
    return parts.every((part) => evaluateExpression(part, context))
  }

  if (trimmed.includes('||')) {
    const parts = trimmed.split('||').map((p) => p.trim())
    return parts.some((part) => evaluateExpression(part, context))
  }

  // Handle negation
  if (trimmed.startsWith('!')) {
    return !evaluateExpression(trimmed.slice(1).trim(), context)
  }

  // Handle parentheses (simple case)
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return evaluateExpression(trimmed.slice(1, -1).trim(), context)
  }

  // Handle boolean literals (before equality checks)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  // Handle equality/inequality
  if (trimmed.includes('==')) {
    const parts = trimmed.split('==').map((s) => s.trim())
    if (parts.length === 2 && parts[0] && parts[1]) {
      const left = resolveValue(parts[0], context)
      const right = resolveValue(parts[1], context)
      // For numeric comparison, try numeric first
      if (typeof left === 'number' && typeof right === 'number') {
        return left === right
      }
      // Otherwise coerce to string
      return coerceToString(left) === coerceToString(right)
    }
  }

  if (trimmed.includes('!=')) {
    const parts = trimmed.split('!=').map((s) => s.trim())
    if (parts.length === 2 && parts[0] && parts[1]) {
      const left = resolveValue(parts[0], context)
      const right = resolveValue(parts[1], context)
      // For numeric comparison, try numeric first
      if (typeof left === 'number' && typeof right === 'number') {
        return left !== right
      }
      // Otherwise coerce to string
      return coerceToString(left) !== coerceToString(right)
    }
  }

  // Handle functions
  if (trimmed.includes('contains(')) {
    const match = trimmed.match(/contains\(([^,]+),\s*([^)]+)\)/)
    if (match && match[1] && match[2]) {
      const value = resolveValue(match[1].trim(), context)
      const search = match[2].trim().replace(/^["']|["']$/g, '')
      return String(value).includes(search)
    }
  }

  if (trimmed.includes('startsWith(')) {
    const match = trimmed.match(/startsWith\(([^,]+),\s*([^)]+)\)/)
    if (match && match[1] && match[2]) {
      const value = resolveValue(match[1].trim(), context)
      const prefix = match[2].trim().replace(/^["']|["']$/g, '')
      return String(value).startsWith(prefix)
    }
  }

  if (trimmed.includes('endsWith(')) {
    const match = trimmed.match(/endsWith\(([^,]+),\s*([^)]+)\)/)
    if (match && match[1] && match[2]) {
      const value = resolveValue(match[1].trim(), context)
      const suffix = match[2].trim().replace(/^["']|["']$/g, '')
      return String(value).endsWith(suffix)
    }
  }

  // Fallback: treat as truthy/falsy
  const value = resolveValue(trimmed, context)
  return Boolean(value)
}

/**
 * Resolve a value from context (e.g., "env.VAR", "steps.build.outputs.version")
 */
function resolveValue(path: string, context: ExpressionContext): unknown {
  // Remove quotes
  const cleanPath = path.replace(/^["']|["']$/g, '')

  // env.VAR
  if (cleanPath.startsWith('env.')) {
    const key = cleanPath.slice('env.'.length)
    return context.env[key] ?? ''
  }

  // trigger.type, trigger.actor, trigger.payload.*
  if (cleanPath.startsWith('trigger.')) {
    const key = cleanPath.slice('trigger.'.length)
    if (key === 'type') {
      return context.trigger.type
    }
    if (key === 'actor') {
      return context.trigger.actor ?? ''
    }
    if (key.startsWith('payload.')) {
      const payloadKey = key.slice('payload.'.length)
      return context.trigger.payload?.[payloadKey] ?? ''
    }
    return ''
  }

  // steps.<id>.outputs.<key>
  if (cleanPath.startsWith('steps.')) {
    const rest = cleanPath.slice('steps.'.length)
    const match = rest.match(/^([^.]+)\.outputs\.(.+)$/)
    if (match) {
      const stepId = match[1]!
      const outputKey = match[2]!
      const value = context.steps[stepId]?.outputs[outputKey]
      return value !== undefined ? value : ''
    }
    return ''
  }

  // matrix.* (for future)
  if (cleanPath.startsWith('matrix.') && context.matrix) {
    const key = cleanPath.slice('matrix.'.length)
    return context.matrix[key] ?? ''
  }

  // Try to parse as number
  const num = Number(cleanPath)
  if (!isNaN(num) && isFinite(num)) {
    return num
  }

  // Try to parse as boolean
  if (cleanPath === 'true') return true
  if (cleanPath === 'false') return false

  // Literal value
  return cleanPath
}

/**
 * Coerce value to string for comparison
 */
function coerceToString(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return String(value)
}

/**
 * Interpolate string with context values
 * Example: "Version: ${{ steps.build.outputs.version }}"
 */
export function interpolateString(
  str: string,
  context: ExpressionContext,
): string {
  const expressions = extractExpressions(str)
  let result = str

  for (const expr of expressions) {
    const value = resolveValue(expr, context)
    const replacement = coerceToString(value)
    const pattern = new RegExp(
      `\\$\\{\\{\\s*${escapeRegex(expr)}\\s*\\}\\}`,
      'g',
    )
    result = result.replace(pattern, replacement)
  }

  return result
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

