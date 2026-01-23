# Workflow UI REST API + WebSocket Implementation Plan

**Goal**: Implement complete REST API + WebSocket support for Workflow UI dashboard (GitHub Actions-style).

**Date**: 2026-01-24
**Status**: In Progress

---

## 📊 Current Status

### ✅ Completed Endpoints

1. **Workflows Management**
   - `GET /api/v1/plugins/workflow/workflows` - List all workflow definitions
   - `GET /api/v1/plugins/workflow/workflows/:id` - Get workflow details
   - `POST /api/v1/plugins/workflow/workflows/:id/run` - Run a workflow

2. **Jobs Management**
   - `GET /api/v1/plugins/workflow/jobs` - List all jobs (with filters)
   - `GET /api/v1/plugins/workflow/jobs/:jobId` - Get job details
   - `POST /api/v1/plugins/workflow/jobs/:jobId/cancel` - Cancel a job

3. **Cron Management**
   - `GET /api/v1/plugins/workflow/cron` - List all cron jobs

4. **Dashboard Stats** ✅ (JUST ADDED!)
   - `GET /api/v1/plugins/workflow/stats` - Dashboard statistics
   - Returns: workflow counts, job counts, cron counts, active executions, recent activity

### 🔧 Type Contracts Ready

All TypeScript interfaces and Zod schemas are defined in `workflow-contracts/src/rest-api.ts`:
- ✅ `DashboardStatsResponse`
- ✅ `JobLogsResponse`
- ✅ `JobStepsResponse`
- ✅ `WorkflowRunHistoryResponse`
- ✅ All corresponding Zod schemas

---

## 🎯 Missing Endpoints (To Implement)

### 1. Job Logs (REST + WebSocket)

**REST Endpoint**: `GET /api/v1/plugins/workflow/jobs/:jobId/logs`

**Purpose**: Get job execution logs (historical/snapshot).

**Query Parameters**:
- `limit?: number` - Max number of log entries (default: 100)
- `offset?: number` - Pagination offset (default: 0)
- `level?: 'all' | 'info' | 'warn' | 'error' | 'debug'` - Filter by log level
- `stream?: boolean` - If true, suggest using WebSocket instead

**Response**: `JobLogsResponse`
```typescript
{
  jobId: string;
  logs: Array<{
    timestamp: string;
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
    context?: Record<string, unknown>;
  }>;
  total: number;
  hasMore: boolean;
}
```

**WebSocket Channel**: `/v1/ws/plugins/workflow/logs/:jobId`

**Purpose**: Real-time streaming of job logs as they are generated.

**Incoming Messages** (Client → Server):
```typescript
type LogsIncoming =
  | { type: 'subscribe'; jobId: string; level?: string }
  | { type: 'unsubscribe' };
```

**Outgoing Messages** (Server → Client):
```typescript
type LogsOutgoing =
  | { type: 'log'; timestamp: string; level: string; message: string; context?: Record<string, unknown> }
  | { type: 'complete'; jobId: string; status: string }
  | { type: 'error'; message: string };
```

**Implementation Notes**:
- Daemon API: `workflow-daemon/src/api/logs-api.ts` - GET endpoint implementation
- CLI REST Handler: `workflow-cli/src/rest/job-logs-handler.ts` - Proxy to daemon
- CLI WebSocket Handler: `workflow-cli/src/ws/logs-channel.ts` - WebSocket handler
- Data Source: `WorkflowDaemonClient.getJobLogs(jobId)` (already exists!)
- Manifest: Add to `workflow-cli/src/manifest.ts` (rest.routes + ws.channels)

---

### 2. Job Steps/Progress (REST + WebSocket)

**REST Endpoint**: `GET /api/v1/plugins/workflow/jobs/:jobId/steps`

**Purpose**: Get current state of all workflow execution steps (GitHub Actions-style).

**Response**: `JobStepsResponse`
```typescript
{
  jobId: string;
  workflowName?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  steps: Array<{
    name: string;
    handler?: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    progress?: number; // 0-100
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    error?: string;
    output?: unknown;
  }>;
  currentStep?: number; // Current step index
}
```

**WebSocket Channel**: `/v1/ws/plugins/workflow/progress/:jobId`

**Purpose**: Real-time updates of step progress and status changes.

**Incoming Messages** (Client → Server):
```typescript
type ProgressIncoming =
  | { type: 'subscribe'; jobId: string }
  | { type: 'unsubscribe' };
```

**Outgoing Messages** (Server → Client):
```typescript
type ProgressOutgoing =
  | { type: 'step_start'; stepName: string; stepIndex: number }
  | { type: 'step_progress'; stepName: string; progress: number; message?: string }
  | { type: 'step_complete'; stepName: string; status: 'completed' | 'failed'; durationMs: number; error?: string }
  | { type: 'job_complete'; jobId: string; status: string; durationMs: number };
```

**Implementation Notes**:
- Daemon API: `workflow-daemon/src/api/steps-api.ts` - GET endpoint implementation
- CLI REST Handler: `workflow-cli/src/rest/job-steps-handler.ts` - Proxy to daemon
- CLI WebSocket Handler: `workflow-cli/src/ws/progress-channel.ts` - WebSocket handler
- Data Source: Need to track step state in `WorkflowEngine` (may need enhancement)
- Manifest: Add to `workflow-cli/src/manifest.ts` (rest.routes + ws.channels)

---

### 3. Workflow Run History (REST only)

**REST Endpoint**: `GET /api/v1/plugins/workflow/workflows/:id/runs`

**Purpose**: Get historical executions of a specific workflow (for run history table).

**Query Parameters**:
- `limit?: number` - Max number of runs (default: 10)
- `offset?: number` - Pagination offset (default: 0)
- `status?: 'all' | 'completed' | 'failed' | 'running' | 'cancelled'` - Filter by status

**Response**: `WorkflowRunHistoryResponse`
```typescript
{
  workflowId: string;
  runs: Array<{
    id: string; // Run ID
    workflowId: string;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
    trigger: {
      type: 'manual' | 'api' | 'cron';
      user?: string;
    };
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    error?: string;
  }>;
  total: number;
}
```

**Implementation Notes**:
- Daemon API: `workflow-daemon/src/api/history-api.ts` - GET endpoint implementation
- CLI REST Handler: `workflow-cli/src/rest/workflow-runs-handler.ts` - Proxy to daemon
- Data Source: Redis snapshots (`workflow:snapshot:{runId}`) - ADR-0011 Local Replay
- Storage: `RunSnapshotStorage` stores run state with 7-day TTL
- Manifest: Add to `workflow-cli/src/manifest.ts` (rest.routes)

---

### 4. Stats Handler (REST proxy)

**REST Endpoint**: `GET /api/v1/plugins/workflow/stats` (proxy)

**Purpose**: Proxy stats endpoint through workflow-cli REST handler.

**Implementation Notes**:
- Daemon API: Already implemented in `workflow-daemon/src/api/stats-api.ts` ✅
- CLI REST Handler: `workflow-cli/src/rest/stats-handler.ts` - NEW (proxy to daemon)
- Manifest: Add to `workflow-cli/src/manifest.ts` (rest.routes)

---

## 🏗️ Architecture Overview

### 3-Tier Architecture

```
┌─────────────────────────────────────────────────┐
│ UI (React/Vue)                                  │
│ - Dashboard, Workflows, Jobs, Crons tabs       │
│ - Real-time logs/progress via WebSocket        │
└─────────────────────────────────────────────────┘
                      ↓ HTTP/WS
┌─────────────────────────────────────────────────┐
│ REST API Server (port 5050)                     │
│ - Mounts plugin routes from manifests           │
│ - Handles WebSocket upgrades                    │
│ - Routes: /api/v1/plugins/workflow/*            │
│ - WS: /v1/ws/plugins/workflow/*                 │
└─────────────────────────────────────────────────┘
                      ↓ Proxy
┌─────────────────────────────────────────────────┐
│ Workflow CLI Handlers (workflow-cli)            │
│ - REST handlers: Proxy HTTP requests to daemon  │
│ - WS handlers: Proxy WebSocket to daemon        │
└─────────────────────────────────────────────────┘
                      ↓ HTTP/WS
┌─────────────────────────────────────────────────┐
│ Workflow Daemon (port 7778)                     │
│ - Fastify server with REST + WebSocket support  │
│ - JobBroker, WorkflowEngine, CronScheduler      │
│ - Direct access to engine logs/metrics          │
└─────────────────────────────────────────────────┘
```

### Data Flow

**REST Request**:
```
UI → REST API (5050) → CLI Handler → Daemon API (7778) → Engine/Broker → Response
```

**WebSocket Connection**:
```
UI → REST API (5050) → CLI WS Handler → Daemon WS Channel → Engine Events → Real-time updates
```

---

## 📂 File Structure

### Daemon Layer (`workflow-daemon/src/api/`)

```
workflow-daemon/src/api/
├── stats-api.ts       ✅ Dashboard stats
├── workflows-api.ts   ✅ Workflow management
├── jobs-api.ts        ✅ Job management
├── cron-api.ts        ✅ Cron management
├── logs-api.ts        🆕 Job logs (REST)
├── steps-api.ts       🆕 Job steps/progress (REST)
└── history-api.ts     🆕 Workflow run history
```

### CLI REST Handlers (`workflow-cli/src/rest/`)

```
workflow-cli/src/rest/
├── workflows-list-handler.ts      ✅ List workflows
├── workflow-detail-handler.ts     ✅ Workflow details
├── workflow-run-handler.ts        ✅ Run workflow
├── jobs-list-handler.ts           ✅ List jobs
├── job-detail-handler.ts          ✅ Job details
├── job-cancel-handler.ts          ✅ Cancel job
├── cron-list-handler.ts           ✅ List crons
├── stats-handler.ts               🆕 Dashboard stats (proxy)
├── job-logs-handler.ts            🆕 Job logs (proxy)
├── job-steps-handler.ts           🆕 Job steps (proxy)
└── workflow-runs-handler.ts       🆕 Workflow history (proxy)
```

### CLI WebSocket Handlers (`workflow-cli/src/ws/`)

```
workflow-cli/src/ws/
├── logs-channel.ts       🆕 Real-time logs streaming
└── progress-channel.ts   🆕 Real-time progress updates
```

### Manifest (`workflow-cli/src/manifest.ts`)

```typescript
export const manifest: ManifestV3 = {
  // ... existing fields

  rest: {
    basePath: '/plugins/workflow',
    routes: [
      // ✅ Existing routes (workflows, jobs, cron)

      // 🆕 New routes
      { method: 'GET', path: '/stats', handler: './rest/stats-handler.js' },
      { method: 'GET', path: '/jobs/:jobId/logs', handler: './rest/job-logs-handler.js' },
      { method: 'GET', path: '/jobs/:jobId/steps', handler: './rest/job-steps-handler.js' },
      { method: 'GET', path: '/workflows/:id/runs', handler: './rest/workflow-runs-handler.js' },
    ]
  },

  // 🆕 WebSocket channels
  ws: {
    basePath: '/v1/ws/plugins/workflow',
    channels: [
      {
        path: '/logs/:jobId',
        handler: './ws/logs-channel.js',
        description: 'Real-time job logs streaming'
      },
      {
        path: '/progress/:jobId',
        handler: './ws/progress-channel.js',
        description: 'Real-time job progress updates'
      }
    ]
  }
};
```

---

## 🚀 Implementation Plan

### Phase 1: Stats Handler (Proxy) - 15 min

**Goal**: Add REST handler for stats endpoint to make it accessible via REST API.

**Tasks**:
1. Create `workflow-cli/src/rest/stats-handler.ts` (proxy to daemon)
2. Add route to manifest: `{ method: 'GET', path: '/stats', handler: './rest/stats-handler.js' }`
3. Add to tsup.config.ts entry points
4. Build and test: `curl http://localhost:5050/api/v1/plugins/workflow/stats`

**Files**:
- ✅ Daemon API already done
- 🆕 `workflow-cli/src/rest/stats-handler.ts`
- 🆕 Update `workflow-cli/src/manifest.ts`
- 🆕 Update `workflow-cli/tsup.config.ts`

---

### Phase 2: Job Logs (REST + WebSocket) - 45 min

**Goal**: Implement job logs retrieval (REST) and real-time streaming (WebSocket).

**Tasks**:

**2.1. Daemon API (REST)**
1. Create `workflow-daemon/src/api/logs-api.ts`
   - `GET /api/v1/jobs/:jobId/logs` endpoint
   - Use `WorkflowDaemonClient.getJobLogs(jobId)` (already exists)
   - Query params: limit, offset, level
   - Return `JobLogsResponse`
2. Register in `workflow-daemon/src/server.ts`
3. Build daemon

**2.2. CLI REST Handler**
1. Create `workflow-cli/src/rest/job-logs-handler.ts`
   - Proxy to daemon: `GET /jobs/:jobId/logs`
   - Forward query params
2. Add to manifest.rest.routes
3. Add to tsup.config.ts entry points

**2.3. CLI WebSocket Handler**
1. Create `workflow-cli/src/ws/logs-channel.ts`
   - Implement `defineWebSocket({ path: '/logs/:jobId', handler: { onConnect, onMessage } })`
   - `onConnect`: Subscribe to job logs stream
   - `onMessage`: Handle subscribe/unsubscribe
   - Stream logs as they arrive
2. Add to manifest.ws.channels
3. Add to tsup.config.ts entry points

**2.4. Testing**
- REST: `curl http://localhost:5050/api/v1/plugins/workflow/jobs/:jobId/logs`
- WebSocket: Use `wscat -c "ws://localhost:5050/v1/ws/plugins/workflow/logs/:jobId"`

**Files**:
- 🆕 `workflow-daemon/src/api/logs-api.ts`
- 🆕 `workflow-cli/src/rest/job-logs-handler.ts`
- 🆕 `workflow-cli/src/ws/logs-channel.ts`
- ✅ Update `workflow-daemon/src/server.ts`
- ✅ Update `workflow-cli/src/manifest.ts`
- ✅ Update `workflow-cli/tsup.config.ts`

---

### Phase 3: Job Steps/Progress (REST + WebSocket) - 45 min

**Goal**: Implement job steps retrieval (REST) and real-time progress updates (WebSocket).

**Tasks**:

**3.1. Daemon API (REST)**
1. Create `workflow-daemon/src/api/steps-api.ts`
   - `GET /api/v1/jobs/:jobId/steps` endpoint
   - Get job run from engine
   - Extract step information (name, status, progress, timing)
   - Return `JobStepsResponse`
2. Register in `workflow-daemon/src/server.ts`
3. Build daemon

**3.2. CLI REST Handler**
1. Create `workflow-cli/src/rest/job-steps-handler.ts`
   - Proxy to daemon: `GET /jobs/:jobId/steps`
2. Add to manifest.rest.routes
3. Add to tsup.config.ts entry points

**3.3. CLI WebSocket Handler**
1. Create `workflow-cli/src/ws/progress-channel.ts`
   - Implement `defineWebSocket({ path: '/progress/:jobId', handler: { onConnect, onMessage } })`
   - `onConnect`: Subscribe to job progress events
   - `onMessage`: Handle subscribe/unsubscribe
   - Stream step updates (start, progress, complete)
2. Add to manifest.ws.channels
3. Add to tsup.config.ts entry points

**3.4. Testing**
- REST: `curl http://localhost:5050/api/v1/plugins/workflow/jobs/:jobId/steps`
- WebSocket: Use `wscat -c "ws://localhost:5050/v1/ws/plugins/workflow/progress/:jobId"`

**Files**:
- 🆕 `workflow-daemon/src/api/steps-api.ts`
- 🆕 `workflow-cli/src/rest/job-steps-handler.ts`
- 🆕 `workflow-cli/src/ws/progress-channel.ts`
- ✅ Update `workflow-daemon/src/server.ts`
- ✅ Update `workflow-cli/src/manifest.ts`
- ✅ Update `workflow-cli/tsup.config.ts`

---

### Phase 4: Workflow Run History (REST) - 30 min

**Goal**: Implement workflow run history retrieval.

**Tasks**:

**4.1. Daemon API (REST)**
1. Create `workflow-daemon/src/api/history-api.ts`
   - `GET /api/v1/workflows/:id/runs` endpoint
   - Query Redis for snapshots: `workflow:snapshot:{workflowId}:*`
   - Filter by status if provided
   - Paginate with limit/offset
   - Return `WorkflowRunHistoryResponse`
2. Register in `workflow-daemon/src/server.ts`
3. Build daemon

**4.2. CLI REST Handler**
1. Create `workflow-cli/src/rest/workflow-runs-handler.ts`
   - Proxy to daemon: `GET /workflows/:id/runs`
   - Forward query params
2. Add to manifest.rest.routes
3. Add to tsup.config.ts entry points

**4.3. Testing**
- REST: `curl http://localhost:5050/api/v1/plugins/workflow/workflows/:id/runs`

**Files**:
- 🆕 `workflow-daemon/src/api/history-api.ts`
- 🆕 `workflow-cli/src/rest/workflow-runs-handler.ts`
- ✅ Update `workflow-daemon/src/server.ts`
- ✅ Update `workflow-cli/src/manifest.ts`
- ✅ Update `workflow-cli/tsup.config.ts`

---

## 🧪 Testing Strategy

### REST API Testing

```bash
# 1. Dashboard stats
curl http://localhost:5050/api/v1/plugins/workflow/stats | jq

# 2. Job logs
curl "http://localhost:5050/api/v1/plugins/workflow/jobs/:jobId/logs?limit=50" | jq

# 3. Job steps
curl http://localhost:5050/api/v1/plugins/workflow/jobs/:jobId/steps | jq

# 4. Workflow run history
curl "http://localhost:5050/api/v1/plugins/workflow/workflows/:id/runs?limit=10" | jq
```

### WebSocket Testing

```bash
# Install wscat
npm install -g wscat

# 1. Logs channel
wscat -c "ws://localhost:5050/v1/ws/plugins/workflow/logs/:jobId"
> {"type":"subscribe","jobId":"job-123"}

# 2. Progress channel
wscat -c "ws://localhost:5050/v1/ws/plugins/workflow/progress/:jobId"
> {"type":"subscribe","jobId":"job-123"}
```

### Integration Testing

Create test workflow that:
1. Runs for 30 seconds with multiple steps
2. Generates logs at each step
3. Reports progress (0% → 100%)
4. Verify real-time updates work

---

## 📊 Success Criteria

### Phase 1 (Stats)
- ✅ `GET /api/v1/plugins/workflow/stats` returns dashboard data
- ✅ Response matches `DashboardStatsResponse` schema

### Phase 2 (Logs)
- ✅ `GET /api/v1/plugins/workflow/jobs/:jobId/logs` returns logs
- ✅ WebSocket `/logs/:jobId` streams real-time logs
- ✅ Log levels filtering works
- ✅ Pagination works

### Phase 3 (Steps)
- ✅ `GET /api/v1/plugins/workflow/jobs/:jobId/steps` returns steps
- ✅ WebSocket `/progress/:jobId` streams step updates
- ✅ Progress percentage updates work
- ✅ Step status changes are captured

### Phase 4 (History)
- ✅ `GET /api/v1/plugins/workflow/workflows/:id/runs` returns history
- ✅ Pagination works
- ✅ Status filtering works
- ✅ Runs are sorted by date (newest first)

---

## 🎨 UI Components Enabled

After implementation, UI can build:

1. **Dashboard** (`/`)
   - Quick stats cards (workflows, jobs, crons, runs)
   - Active executions list with real-time progress
   - Recent activity feed

2. **Workflows Tab** (`/workflows`)
   - List of workflow definitions
   - Run button, details view
   - Run history table

3. **Jobs Tab** (`/jobs`)
   - Active/pending/completed jobs list
   - Real-time status updates
   - Progress bars

4. **Job Detail Page** (`/jobs/:id`)
   - GitHub Actions-style step viewer
   - Real-time logs streaming
   - Step progress indicators
   - Cancel button

5. **Workflow Detail Page** (`/workflows/:id`)
   - Workflow info
   - Configuration YAML viewer
   - Run history table

---

## 🔧 Technical Notes

### WebSocket Handler Pattern

```typescript
import { defineWebSocket } from '@kb-labs/sdk';

export default defineWebSocket({
  path: '/logs/:jobId',
  handler: {
    async onConnect(ctx, sender) {
      const { jobId } = ctx.params;

      // Subscribe to logs
      // Send initial logs
      await sender.send({ type: 'ready', jobId });
    },

    async onMessage(ctx, message, sender) {
      if (message.type === 'subscribe') {
        // Start streaming
      } else if (message.type === 'unsubscribe') {
        // Stop streaming
      }
    },

    async onDisconnect(ctx) {
      // Cleanup subscriptions
    }
  }
});
```

### Daemon API Pattern

```typescript
export function registerLogsAPI(options: RegisterLogsAPIOptions): void {
  const { server, jobBroker, logger } = options;

  server.get<{ Params: { jobId: string }; Querystring: { limit?: number } }>(
    '/api/v1/jobs/:jobId/logs',
    async (request, reply) => {
      try {
        const { jobId } = request.params;
        const { limit = 100 } = request.query;

        const logs = await jobBroker.getJobLogs(jobId, { limit });

        return { ok: true, data: { jobId, logs, total: logs.length, hasMore: false } };
      } catch (error) {
        logger.error('[logs-api] Error', error);
        reply.code(500);
        return { ok: false, error: error.message };
      }
    }
  );
}
```

---

## 📅 Timeline

**Total Estimated Time**: ~2.5 hours

- Phase 1 (Stats): 15 min
- Phase 2 (Logs): 45 min
- Phase 3 (Steps): 45 min
- Phase 4 (History): 30 min
- Testing & Fixes: 15 min

---

## 🚦 Current Progress

- [x] Dashboard stats endpoint (daemon)
- [ ] Stats REST handler (CLI proxy)
- [ ] Job logs REST endpoint
- [ ] Job logs WebSocket channel
- [ ] Job steps REST endpoint
- [ ] Job steps WebSocket channel
- [ ] Workflow run history REST endpoint
- [ ] Testing & documentation

---

## 📝 Notes

- All TypeScript contracts already defined ✅
- WebSocket support already implemented in REST API infrastructure ✅
- Daemon has `WorkflowDaemonClient.getJobLogs()` ✅
- Redis snapshots store run history (ADR-0011) ✅
- Need to enhance `WorkflowEngine` to expose step-level state
- Consider adding EventBus for real-time events propagation

---

**Next Step**: Start with Phase 1 (Stats Handler) to validate the approach, then proceed to Phases 2-4.
