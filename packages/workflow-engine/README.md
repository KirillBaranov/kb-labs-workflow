# @kb-labs/workflow-engine

Workflow orchestration engine for KB Labs. Provides job scheduling, state management, Redis coordination, and workflow execution.

## Features

- **Job Scheduling**: Intelligent job scheduling with dependency resolution
- **Redis Coordination**: Distributed state management and coordination through Redis
- **Event Bus**: Event streaming for workflow observability
- **Retry Logic**: Configurable retry policies for jobs and steps
- **Concurrency Control**: Idempotency and concurrency group management
- **Timeout Handling**: Configurable timeouts for jobs and steps

## Usage

```typescript
import { WorkflowEngine, createRedisClient } from '@kb-labs/workflow-engine'
import type { WorkflowSpec } from '@kb-labs/workflow-contracts'

const redis = await createRedisClient({
  url: process.env.KB_REDIS_URL || 'redis://localhost:6379'
})

const engine = new WorkflowEngine({
  redis,
  logger: getLogger('workflow')
})

// Run a workflow
const run = await engine.run(spec, {
  idempotency: 'unique-key',
  concurrency: { group: 'my-group' }
})

// Create a worker
const worker = createWorkflowWorker({
  engine,
  maxConcurrentJobs: 2
})

await worker.start()
```

## API

### WorkflowEngine

Main orchestration engine class.

- `run(spec, options)`: Execute a workflow
- `getRun(runId)`: Get run details
- `cancelRun(runId)`: Cancel a running workflow
- `listRuns(options)`: List workflow runs

### WorkflowWorker

Long-running worker that polls Redis queues and executes jobs.

- `start()`: Start the worker
- `stop()`: Stop the worker gracefully
- `getMetrics()`: Get worker metrics

## Dependencies

- `@kb-labs/core-sys` - Logging and system utilities
- `@kb-labs/cli-core` - CLI utilities
- `@kb-labs/plugin-manifest` - Plugin manifest definitions
- `@kb-labs/workflow-*` - Other workflow packages

