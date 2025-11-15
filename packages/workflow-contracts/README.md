# @kb-labs/workflow-contracts

Contracts, types and schemas for the KB Labs workflow engine.

## Features

- **Zod Schemas**: Validation schemas for workflow specifications
- **TypeScript Types**: Complete type definitions for all workflow entities
- **Workflow Spec**: Type-safe workflow specification format

## Usage

```typescript
import { WorkflowSpecSchema, type WorkflowSpec } from '@kb-labs/workflow-contracts'
import { z } from 'zod'

// Validate a workflow spec
const spec = WorkflowSpecSchema.parse(yamlContent)

// Type-safe workflow definition
const myWorkflow: WorkflowSpec = {
  name: 'my-workflow',
  version: '0.1.0',
  jobs: {
    build: {
      steps: [
        { name: 'build', uses: 'plugin:@kb-labs/build/cli' }
      ]
    }
  }
}
```

## Types

- `WorkflowSpec` - Complete workflow specification
- `WorkflowRun` - Workflow run state and metadata
- `JobRun` - Job execution state
- `StepRun` - Step execution state

## Dependencies

- `@kb-labs/workflow-constants` - Shared constants
- `zod` - Schema validation

