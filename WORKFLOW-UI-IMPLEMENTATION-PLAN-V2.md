# Workflow UI Implementation Plan V2
**Объединенный план: REST API + WebSocket + Type-Safe Messages**

**Date**: 2026-01-24
**Status**: Ready to Execute
**Estimated Time**: 3-4 hours

---

## 🎯 Цель

Реализовать complete REST API + WebSocket для Workflow UI Dashboard (GitHub Actions-style):
- **REST API** - snapshot data (logs, steps, history)
- **WebSocket** - real-time updates (live logs, progress streaming)
- **Type-Safe** - typed messages с автодополнением
- **Pattern Matching** - MessageRouter для элегантной обработки

---

## ✅ Что уже готово

### Инфраструктура
- ✅ WebSocket support в REST API (из оригинального плана)
- ✅ `defineWebSocket()` helper в SDK
- ✅ `MessageBuilder` и `MessageRouter` для type-safe messages
- ✅ Connection registry для broadcast
- ✅ `mountWebSocketChannels()` в plugin-execution

### Endpoints
- ✅ Dashboard stats (`GET /stats`)
- ✅ Workflows CRUD (`GET /workflows`, `GET /workflows/:id`, `POST /workflows/:id/run`)
- ✅ Jobs management (`GET /jobs`, `GET /jobs/:jobId`, `POST /jobs/:jobId/cancel`)
- ✅ Cron management (`GET /cron`)

### Type Contracts
- ✅ Все interfaces в `workflow-contracts/src/rest-api.ts`:
  - `DashboardStatsResponse`
  - `JobLogsResponse`
  - `JobStepsResponse`
  - `WorkflowRunHistoryResponse`
- ✅ Все Zod schemas готовы

---

## 🚀 План реализации (4 фазы)

### Phase 1: Stats Handler (15 мин)
**Цель**: Добавить REST proxy для stats endpoint.

**Задачи**:
1. Create `workflow-cli/src/rest/stats-handler.ts` (proxy to daemon)
2. Add route to manifest
3. Add to tsup entry points
4. Build & test

**Files**:
- 🆕 `workflow-cli/src/rest/stats-handler.ts`
- ✅ Update `workflow-cli/src/manifest.ts`
- ✅ Update `workflow-cli/tsup.config.ts`

---

### Phase 2: Job Logs (REST + WebSocket) - 45 мин

#### 2.1 Daemon REST API
**File**: `workflow-daemon/src/api/logs-api.ts` (NEW)

```typescript
export function registerLogsAPI(options: RegisterLogsAPIOptions): void {
  const { server, jobBroker, logger } = options;

  server.get<{
    Params: { jobId: string };
    Querystring: { limit?: number; offset?: number; level?: string };
  }>('/api/v1/jobs/:jobId/logs', async (request, reply) => {
    const { jobId } = request.params;
    const { limit = 100, offset = 0, level = 'all' } = request.query;

    const logs = await jobBroker.getJobLogs(jobId, { limit, offset, level });

    const response: JobLogsResponse = {
      jobId,
      logs,
      total: logs.length,
      hasMore: logs.length === limit,
    };

    return { ok: true, data: response };
  });
}
```

#### 2.2 CLI REST Handler
**File**: `workflow-cli/src/rest/job-logs-handler.ts` (NEW)

```typescript
import { defineHandler, type RestInput, type PluginContextV3 } from '@kb-labs/sdk';
import type { JobLogsResponse } from '@kb-labs/workflow-contracts';
import { getWorkflowDaemonUrl } from '../http-client';

export default defineHandler({
  async execute(
    ctx: PluginContextV3,
    input: RestInput<unknown, { limit?: string; offset?: string; level?: string }, { jobId: string }>
  ): Promise<JobLogsResponse> {
    const daemonUrl = getWorkflowDaemonUrl();
    const { jobId } = input.params!;
    const { limit, offset, level } = input.query || {};

    const params = new URLSearchParams();
    if (limit) params.append('limit', limit);
    if (offset) params.append('offset', offset);
    if (level) params.append('level', level);

    const url = `${daemonUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/logs?${params}`;

    const response = await fetch(url);
    const result = (await response.json()) as { ok: boolean; data?: JobLogsResponse; error?: string };

    if (!result.ok || !result.data) {
      throw new Error(result.error || 'Failed to fetch logs');
    }

    return result.data;
  },
});
```

#### 2.3 CLI WebSocket Handler (Type-Safe!)
**File**: `workflow-cli/src/ws/logs-channel.ts` (NEW)

```typescript
import { defineWebSocket, defineMessage, MessageRouter } from '@kb-labs/sdk';

// ✨ Define typed messages
const SubscribeMsg = defineMessage<{ jobId: string; level?: string }>('subscribe');
const UnsubscribeMsg = defineMessage<{}>('unsubscribe');

const LogMsg = defineMessage<{
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  context?: Record<string, unknown>;
}>('log');

const CompleteMsg = defineMessage<{ jobId: string; status: string }>('complete');
const ErrorMsg = defineMessage<{ error: string }>('error');

// Incoming/Outgoing types (discriminated unions)
type Incoming =
  | ReturnType<typeof SubscribeMsg.create>
  | ReturnType<typeof UnsubscribeMsg.create>;

type Outgoing =
  | ReturnType<typeof LogMsg.create>
  | ReturnType<typeof CompleteMsg.create>
  | ReturnType<typeof ErrorMsg.create>;

export default defineWebSocket<unknown, Incoming, Outgoing>({
  path: '/logs/:jobId',
  description: 'Real-time job logs streaming',

  handler: {
    async onConnect(ctx, sender) {
      const { jobId } = ctx.params as { jobId: string };

      ctx.logger.info('[logs-channel] Client connected', { jobId, connectionId: sender.getConnectionId() });

      // TODO: Subscribe to job logs stream from daemon
    },

    async onMessage(ctx, message, sender) {
      const router = new MessageRouter()
        .on(SubscribeMsg, async (ctx, payload, rawSender) => {
          const { jobId, level } = payload;

          ctx.logger.info('[logs-channel] Subscribing to logs', { jobId, level });

          // TODO: Start streaming logs from daemon
          // For now, simulate:
          await sender.send(LogMsg.create({
            timestamp: new Date().toISOString(),
            level: 'info',
            message: 'Log streaming started',
          }));
        })
        .on(UnsubscribeMsg, async (ctx, payload, rawSender) => {
          ctx.logger.info('[logs-channel] Unsubscribing from logs');
          // TODO: Stop streaming
        });

      await router.handle(ctx, message as any, sender.raw);
    },

    async onDisconnect(ctx, code, reason) {
      ctx.logger.info('[logs-channel] Client disconnected', { code, reason });
      // TODO: Cleanup subscriptions
    },

    async onError(ctx, error, sender) {
      ctx.logger.error('[logs-channel] Error', error);
      await sender.send(ErrorMsg.create({ error: error.message }));
    },
  },
});
```

#### 2.4 Update Manifest
**File**: `workflow-cli/src/manifest.ts`

```typescript
// Add to rest.routes:
{
  method: 'GET',
  path: WORKFLOW_ROUTES.JOB_LOGS,
  handler: './rest/job-logs-handler.js#default',
  describe: 'Get job execution logs',
  output: {
    zod: '@kb-labs/workflow-contracts#JobLogsResponseSchema',
  },
},

// Add ws section (if not exists):
ws: {
  basePath: '/v1/ws/plugins/workflow',
  defaults: {
    timeoutMs: 600000, // 10 minutes
    maxMessageSize: 1048576, // 1MB
    auth: 'none',
    idleTimeoutMs: 300000, // 5 minutes
  },
  channels: [
    {
      path: '/logs/:jobId',
      handler: './ws/logs-channel.js#default',
      description: 'Real-time job logs streaming',
    },
  ],
},
```

#### 2.5 Update tsup.config.ts
```typescript
entry: [
  // ... existing entries
  'src/rest/job-logs-handler.ts',
  'src/ws/logs-channel.ts',
],
```

---

### Phase 3: Job Steps/Progress (REST + WebSocket) - 45 мин

#### 3.1 Daemon REST API
**File**: `workflow-daemon/src/api/steps-api.ts` (NEW)

```typescript
export function registerStepsAPI(options: RegisterStepsAPIOptions): void {
  const { server, engine, logger } = options;

  server.get<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/steps',
    async (request, reply) => {
      const { jobId } = request.params;

      // Get workflow run from engine
      const run = await engine.getRun(jobId);

      if (!run) {
        reply.code(404);
        return { ok: false, error: 'Job not found' };
      }

      const steps: JobStepInfo[] = run.steps?.map((step) => ({
        name: step.name,
        handler: step.handler,
        status: step.status,
        progress: step.progress,
        startedAt: step.startedAt?.toISOString(),
        finishedAt: step.finishedAt?.toISOString(),
        durationMs: step.durationMs,
        error: step.error,
        output: step.output,
      })) || [];

      const response: JobStepsResponse = {
        jobId,
        workflowName: run.workflowName,
        status: run.status,
        steps,
        currentStep: run.currentStepIndex,
      };

      return { ok: true, data: response };
    }
  );
}
```

#### 3.2 CLI REST Handler
**File**: `workflow-cli/src/rest/job-steps-handler.ts` (NEW)

Similar to job-logs-handler, proxy to daemon.

#### 3.3 CLI WebSocket Handler
**File**: `workflow-cli/src/ws/progress-channel.ts` (NEW)

```typescript
import { defineWebSocket, defineMessage, MessageRouter } from '@kb-labs/sdk';

const SubscribeMsg = defineMessage<{ jobId: string }>('subscribe');
const UnsubscribeMsg = defineMessage<{}>('unsubscribe');

const StepStartMsg = defineMessage<{ stepName: string; stepIndex: number }>('step_start');
const StepProgressMsg = defineMessage<{ stepName: string; progress: number; message?: string }>('step_progress');
const StepCompleteMsg = defineMessage<{
  stepName: string;
  status: 'completed' | 'failed';
  durationMs: number;
  error?: string;
}>('step_complete');
const JobCompleteMsg = defineMessage<{ jobId: string; status: string; durationMs: number }>('job_complete');

type Incoming =
  | ReturnType<typeof SubscribeMsg.create>
  | ReturnType<typeof UnsubscribeMsg.create>;

type Outgoing =
  | ReturnType<typeof StepStartMsg.create>
  | ReturnType<typeof StepProgressMsg.create>
  | ReturnType<typeof StepCompleteMsg.create>
  | ReturnType<typeof JobCompleteMsg.create>;

export default defineWebSocket<unknown, Incoming, Outgoing>({
  path: '/progress/:jobId',
  description: 'Real-time job progress updates',

  handler: {
    async onConnect(ctx, sender) {
      const { jobId } = ctx.params as { jobId: string };
      ctx.logger.info('[progress-channel] Client connected', { jobId });
    },

    async onMessage(ctx, message, sender) {
      const router = new MessageRouter()
        .on(SubscribeMsg, async (ctx, payload, rawSender) => {
          // Subscribe to progress events
          ctx.logger.info('[progress-channel] Subscribed', { jobId: payload.jobId });

          // TODO: Stream progress updates from engine
        })
        .on(UnsubscribeMsg, async (ctx, payload, rawSender) => {
          ctx.logger.info('[progress-channel] Unsubscribed');
        });

      await router.handle(ctx, message as any, sender.raw);
    },

    async onDisconnect(ctx, code, reason) {
      ctx.logger.info('[progress-channel] Client disconnected', { code, reason });
    },
  },
});
```

#### 3.4 Update Manifest
Add to `rest.routes` and `ws.channels`.

---

### Phase 4: Workflow Run History (REST Only) - 30 мин

#### 4.1 Daemon REST API
**File**: `workflow-daemon/src/api/history-api.ts` (NEW)

```typescript
export function registerHistoryAPI(options: RegisterHistoryAPIOptions): void {
  const { server, engine, logger } = options;

  server.get<{
    Params: { id: string };
    Querystring: { limit?: number; offset?: number; status?: string };
  }>('/api/v1/workflows/:id/runs', async (request, reply) => {
    const { id } = request.params;
    const { limit = 10, offset = 0, status = 'all' } = request.query;

    // Get run history from engine/Redis snapshots
    const runs = await engine.getRunHistory(id, { limit, offset, status });

    const runInfos: WorkflowRunInfo[] = runs.map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString(),
      durationMs: run.durationMs,
      error: run.error,
    }));

    const response: WorkflowRunHistoryResponse = {
      workflowId: id,
      runs: runInfos,
      total: runInfos.length,
    };

    return { ok: true, data: response };
  });
}
```

#### 4.2 CLI REST Handler
**File**: `workflow-cli/src/rest/workflow-runs-handler.ts` (NEW)

Proxy to daemon (similar pattern).

#### 4.3 Update Manifest
Add to `rest.routes`.

---

## 📂 Complete File Structure

```
workflow-daemon/src/api/
├── stats-api.ts          ✅ (готово)
├── workflows-api.ts      ✅ (готово)
├── jobs-api.ts           ✅ (готово)
├── cron-api.ts           ✅ (готово)
├── logs-api.ts           🆕 Phase 2.1
├── steps-api.ts          🆕 Phase 3.1
└── history-api.ts        🆕 Phase 4.1

workflow-cli/src/rest/
├── stats-handler.ts          🆕 Phase 1
├── job-logs-handler.ts       🆕 Phase 2.2
├── job-steps-handler.ts      🆕 Phase 3.2
└── workflow-runs-handler.ts  🆕 Phase 4.2

workflow-cli/src/ws/
├── logs-channel.ts       🆕 Phase 2.3
└── progress-channel.ts   🆕 Phase 3.3

workflow-cli/src/
└── manifest.ts           ✅ Update all phases
```

---

## 🧪 Testing Commands

### REST API
```bash
# Stats
curl http://localhost:5050/api/v1/plugins/workflow/stats | jq

# Logs
curl "http://localhost:5050/api/v1/plugins/workflow/jobs/:jobId/logs?limit=50" | jq

# Steps
curl http://localhost:5050/api/v1/plugins/workflow/jobs/:jobId/steps | jq

# History
curl "http://localhost:5050/api/v1/plugins/workflow/workflows/:id/runs?limit=10" | jq
```

### WebSocket
```bash
# Install wscat
npm install -g wscat

# Logs channel
wscat -c "ws://localhost:5050/v1/ws/plugins/workflow/logs/:jobId"
> {"type":"subscribe","payload":{"jobId":"job-123"},"timestamp":1234567890}

# Progress channel
wscat -c "ws://localhost:5050/v1/ws/plugins/workflow/progress/:jobId"
> {"type":"subscribe","payload":{"jobId":"job-123"},"timestamp":1234567890}
```

---

## ✨ Key Advantages

### Type Safety
```typescript
// ✅ Autocomplete works!
await sender.send(Progress.create({
  phase: 'analyzing',  // ← TypeScript knows this field exists
  progress: 50,
}));

// ❌ Compile error!
await sender.send(Progress.create({
  fase: 'analyzing',  // ← Typo caught at compile time!
}));
```

### Pattern Matching
```typescript
// Instead of messy if/else
const router = new MessageRouter()
  .on(SubscribeMsg, handler1)
  .on(UnsubscribeMsg, handler2)
  .on(CancelMsg, handler3);

await router.handle(ctx, message, sender.raw);
```

### Manifest-Driven
```typescript
// REST + WebSocket in one manifest
export const manifest: ManifestV3 = {
  rest: { routes: [...] },
  ws: { channels: [...] },
};
```

---

## 📅 Timeline

**Total**: 3-4 hours

- Phase 1 (Stats): 15 min
- Phase 2 (Logs): 45 min
- Phase 3 (Steps): 45 min
- Phase 4 (History): 30 min
- Testing & Fixes: 45-75 min

---

## 🚦 Progress Tracker

- [ ] Phase 1: Stats handler
- [ ] Phase 2: Job logs (REST + WS)
- [ ] Phase 3: Job steps (REST + WS)
- [ ] Phase 4: Workflow history (REST)
- [ ] Testing & documentation

---

**Next Step**: Start with Phase 1 to validate approach, then proceed sequentially through phases 2-4.
