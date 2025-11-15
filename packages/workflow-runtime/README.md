# @kb-labs/workflow-runtime

Runtime adapters and step executors for the KB Labs workflow engine.

## Features

- **Local Runner**: Execute steps in-process
- **Sandbox Runner**: Execute plugin commands in sandboxed environment
- **Context Management**: Step execution context with environment and secrets
- **Signal Handling**: Proper cancellation and timeout handling

## Usage

```typescript
import { LocalRunner, SandboxRunner } from '@kb-labs/workflow-runtime'
import type { StepExecutionRequest } from '@kb-labs/workflow-runtime'

const runner = new LocalRunner()

const result = await runner.execute({
  spec: stepSpec,
  context: {
    runId: 'run-123',
    jobId: 'job-abc',
    stepId: 'step-xyz',
    attempt: 1,
    env: {},
    secrets: {},
    logger: logger,
    trace: { traceId: 'trace-1', spanId: 'span-1' }
  }
})
```

## API

### LocalRunner

Execute steps in the current process.

- `execute(request)`: Execute a step synchronously

### SandboxRunner

Execute plugin commands in a sandboxed environment.

- `execute(request)`: Execute a plugin command in sandbox

## Dependencies

- `@kb-labs/plugin-runtime` - Plugin runtime for sandboxed execution
- `@kb-labs/workflow-*` - Other workflow packages

