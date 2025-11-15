# @kb-labs/workflow-artifacts

Artifact helpers for KB Labs workflow engine.

## Features

- **File System Client**: Operations for reading and writing workflow artifacts
- **Artifact Management**: Helpers for artifact paths and organization

## Usage

```typescript
import { createFileSystemArtifactClient } from '@kb-labs/workflow-artifacts'

const client = createFileSystemArtifactClient({
  baseDir: '/path/to/artifacts'
})

// Read artifact
const content = await client.read('run-123/job-abc/artifact.txt')

// Write artifact
await client.write('run-123/job-abc/artifact.txt', 'content')
```

## API

### createFileSystemArtifactClient

Creates a file system-based artifact client.

- `read(path)`: Read an artifact
- `write(path, content)`: Write an artifact
- `list(prefix)`: List artifacts with a prefix

## Dependencies

- `pathe` - Path utilities

