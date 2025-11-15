# KB Labs Workflow (@kb-labs/workflow)

> **Workflow orchestration engine for KB Labs ecosystem.** Provides workflow execution, job scheduling, and step orchestration capabilities.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18.18.0+-green.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.0.0+-orange.svg)](https://pnpm.io/)

## 🎯 Vision

KB Labs Workflow is a workflow orchestration engine that enables declarative workflow definitions, job scheduling, step execution, and distributed coordination through Redis. It provides a unified interface for running multi-step workflows across the KB Labs ecosystem.

The project solves the problem of orchestrating complex multi-step operations (like CI/CD pipelines, data processing, and plugin workflows) by providing a reliable, scalable workflow engine with support for dependencies, retries, concurrency control, and observability.

This project is part of the **@kb-labs** ecosystem and integrates seamlessly with CLI, REST API, Studio, and all plugin systems.

## 🚀 Quick Start

### Installation

```bash
# Install dependencies
pnpm install
```

### Development

```bash
# Start development mode for all packages
pnpm dev

# Build all packages
pnpm build

# Run tests
pnpm test

# Lint code
pnpm lint
```

### Basic Usage

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

const spec: WorkflowSpec = {
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

const run = await engine.run(spec, {
  idempotency: 'build-123'
})
```

## ✨ Features

- **Declarative Workflows**: YAML/JSON workflow definitions with jobs, steps, and dependencies
- **Job Scheduling**: Intelligent job scheduling with dependency resolution and concurrency control
- **Step Execution**: Support for in-process and sandboxed plugin command execution
- **Redis Coordination**: Distributed coordination through Redis for multi-worker setups
- **Retry Logic**: Configurable retry policies for jobs and steps
- **Observability**: Event streaming, logging, and metrics integration
- **Type Safety**: Full TypeScript support with Zod schema validation

## 📁 Repository Structure

```
kb-labs-workflow/
├── apps/                    # Example applications and demos
│   └── demo/                # Example app demonstrating workflow functionality
├── packages/                # Workflow packages
│   ├── workflow-artifacts/   # Artifact helpers and file system clients
│   ├── workflow-constants/   # Shared constants and enums
│   ├── workflow-contracts/  # Type definitions and Zod schemas
│   ├── workflow-engine/     # Core orchestration engine
│   └── workflow-runtime/    # Step execution runtime adapters
├── docs/                    # Documentation
│   └── adr/                 # Architecture Decision Records
└── scripts/                 # Utility scripts
```

## 📦 Packages

| Package | Description |
|---------|-------------|
| [@kb-labs/workflow-artifacts](./packages/workflow-artifacts/) | Artifact helpers for file system operations and artifact management |
| [@kb-labs/workflow-constants](./packages/workflow-constants/) | Shared constants, enums, and state definitions |
| [@kb-labs/workflow-contracts](./packages/workflow-contracts/) | Type definitions, Zod schemas, and workflow specification contracts |
| [@kb-labs/workflow-engine](./packages/workflow-engine/) | Core orchestration engine with Redis coordination, job scheduling, and state management |
| [@kb-labs/workflow-runtime](./packages/workflow-runtime/) | Runtime adapters for step execution (local and sandboxed runners) |

### Package Details

**@kb-labs/workflow-engine** is the core orchestration engine:
- Job scheduling with dependency resolution
- Redis-based state management and coordination
- Event bus for workflow events
- Retry logic and timeout handling
- Concurrency control and idempotency

**@kb-labs/workflow-runtime** provides step execution:
- Local runner for in-process execution
- Sandbox runner for plugin command execution
- Context management and environment setup
- Signal handling and cancellation

**@kb-labs/workflow-contracts** defines the workflow specification:
- Zod schemas for validation
- TypeScript types for all workflow entities
- Example workflow definitions

## 🔗 Dependencies

This repository depends on:

- **@kb-labs/core-sys** - System utilities and logging (from `kb-labs-core`)
- **@kb-labs/cli-core** - CLI core utilities (from `kb-labs-cli`)
- **@kb-labs/plugin-manifest** - Plugin manifest definitions (from `kb-labs-plugin`)
- **@kb-labs/plugin-runtime** - Plugin runtime for sandboxed execution (from `kb-labs-plugin`)

## 📚 Documentation

- [Workflow Engine Guide](../../docs/workflow-engine.md) - Complete guide to using workflows across CLI, REST API, and Studio
- [Architecture Decisions](./docs/adr/) - ADRs for this project
- [Contributing Guide](./CONTRIBUTING.md) - How to contribute

## 🔧 Requirements

- **Node.js**: >= 18.18.0
- **pnpm**: >= 9.0.0
- **Redis**: Required for distributed coordination (standalone, cluster, or sentinel)

## 🤝 Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines and contribution process.

## 📄 License

MIT © KB Labs
