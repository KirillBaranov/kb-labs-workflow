# @product-name/demo

Demo UI application for showcasing KB Labs Workflow engine.

## Vision & Purpose

This small Vue application demonstrates how a product UI can be wired on top of the KB Labs Workflow stack.  
It is intentionally minimal and is used as a playground/fixture rather than a production surface.

### Core Goals

- Provide a minimal front-end for workflow demos
- Act as a fixture for end-to-end testing of workflow-powered flows
- Serve as a reference for wiring a UI app into the KB Labs mono-repo

## Package Status

- **Version**: 0.1.0  
- **Stage**: Experimental  
- **Status**: Internal Demo Only ⚠️

## Architecture

### Stack

- **Framework**: Vue 3 + Vite
- **Language**: TypeScript

### Structure

```
apps/demo/
├── src/
│   ├── App.vue          # Demo root component (Hello World placeholder)
│   ├── main.ts          # Vue/Vite entrypoint
│   └── __tests__/       # Smoke tests
├── index.html           # Vite HTML shell
└── vite.config.ts       # Vite configuration
```

Currently the UI is a simple `Hello World` placeholder; workflow-specific UI can be added later if this demo is promoted.

## Scripts

From the `kb-labs-workflow` repo root:

```bash
pnpm install
pnpm --filter @product-name/demo dev      # Start Vite dev server
pnpm --filter @product-name/demo build    # Build for production
pnpm --filter @product-name/demo preview  # Preview built app
pnpm --filter @product-name/demo test     # Run Vitest suite
```

## Relationship to Workflow Packages

This app is **not** required for running workflows; it is a convenience demo only.  
Core workflow functionality lives in:

- `@kb-labs/workflow-engine`
- `@kb-labs/workflow-runtime`
- `@kb-labs/workflow-contracts`


