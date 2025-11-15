# @kb-labs/workflow-constants

Shared constants for the KB Labs workflow engine.

## Features

- **State Constants**: Workflow, job, and step state definitions
- **Event Names**: Event type constants for workflow events
- **Status Enums**: Status and state enumerations

## Usage

```typescript
import { RUN_STATES, EVENT_NAMES, StepState } from '@kb-labs/workflow-constants'

// Check run state
if (run.state === RUN_STATES.RUNNING) {
  // ...
}

// Use event names
eventBus.publish(EVENT_NAMES.RUN_STARTED, data)

// Step states
const stepState: StepState = StepState.SUCCESS
```

## Constants

- `RUN_STATES` - Workflow run states
- `JOB_STATES` - Job execution states
- `STEP_STATES` - Step execution states
- `EVENT_NAMES` - Event type names

