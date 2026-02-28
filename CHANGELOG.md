# Changelog

## 1.0.0 - 2026-02-25

### Breaking Changes

- All workflow daemon APIs are now canonical under `/api/v1/*`.
- Legacy cron aliases under `/api/cron/*` are removed.
- Workflow run request supports execution targeting and isolation overrides:
  - `target.environmentId`
  - `target.workspaceId`
  - `target.namespace`
  - `target.workdir`
  - `isolation: strict | balanced | relaxed`
- `balanced` and `strict` execution require platform workspace manager.
- `strict` execution requires platform environment manager.
- Replay with infra snapshot refs requires platform snapshot manager.

### Added

- `WorkflowHostService` as stable host-layer boundary for jobs/cron/workflows APIs.
- Unified API response envelope for daemon routes:
  - success: `{ "ok": true, "data": ... }`
  - error: `{ "ok": false, "error": ... }`
- New workflow execution architecture ADR:
  - [ADR-0020](./docs/adr/0020-workflow-runtime-targets-and-artifact-lifecycle.md)
- Workflow execution target and isolation contracts in workflow schemas/types.
- CLI command `workflow:run` with target/isolation flags:
  - `--workflow-id`
  - `--isolation`
  - `--target-namespace`
  - `--target-environment-id`
  - `--target-workspace-id`
  - `--target-workdir`
- Raw job submission command renamed to `workflow:job-run`.

### Changed

- Workflow worker now integrates platform lifecycle primitives:
  - workspace materialize/attach/release
  - environment create/destroy for strict isolation
- Sandbox runner forwards `ExecutionRequest.target` to execution backend.
- Artifact merge now uses `ArtifactClient` operations (`consume`/`produce`) without direct filesystem write hacks.
- Replay snapshot model now supports optional infra snapshot refs:
  - `workspaceSnapshotId`
  - `environmentSnapshotId`

### Versioning

- All workflow packages are released as `1.0.0`:
  - `@kb-labs/workflow-artifacts`
  - `@kb-labs/workflow-builtins`
  - `@kb-labs/workflow-cli`
  - `@kb-labs/workflow-constants`
  - `@kb-labs/workflow-contracts`
  - `@kb-labs/workflow-daemon`
  - `@kb-labs/workflow-engine`
  - `@kb-labs/workflow-runtime`
