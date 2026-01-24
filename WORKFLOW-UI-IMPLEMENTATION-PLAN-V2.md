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

### Backend (COMPLETED ✅)
- ✅ WebSocket support в REST API (из оригинального плана)
- ✅ `defineWebSocket()` helper в SDK
- ✅ `MessageBuilder` и `MessageRouter` для type-safe messages
- ✅ Connection registry для broadcast
- ✅ `mountWebSocketChannels()` в plugin-execution

### REST API Endpoints (COMPLETED ✅)
- ✅ Dashboard stats (`GET /api/v1/plugins/workflow/stats`)
- ✅ Workflows (`GET /workflows`, `GET /workflows/:id`, `POST /workflows/:id/run`)
- ✅ Jobs (`GET /jobs`, `GET /jobs/:jobId`, `POST /jobs/:jobId/cancel`)
- ✅ Job logs (`GET /jobs/:jobId/logs?limit&offset&level`)
- ✅ Job steps (`GET /jobs/:jobId/steps`)
- ✅ Workflow runs (`GET /workflows/:id/runs?limit&offset&status`)
- ✅ Cron management (`GET /cron`)

### WebSocket Channels (COMPLETED ✅)
- ✅ Logs channel (`/v1/ws/plugins/workflow/logs/:jobId`)
- ✅ Progress channel (`/v1/ws/plugins/workflow/progress/:jobId`)

### Type Contracts (COMPLETED ✅)
- ✅ Все interfaces в `workflow-contracts/src/rest-api.ts`:
  - `DashboardStatsResponse`
  - `JobLogsResponse`
  - `JobStepsResponse`
  - `WorkflowRunHistoryResponse`
- ✅ Все Zod schemas готовы

### Studio Data Client (READY ✅)
- ✅ `WorkflowDataSource` interface
- ✅ `HttpWorkflowSource` implementation
- ✅ `MockWorkflowSource` для разработки
- ✅ `useWorkflowRuns`, `useWorkflowRun`, `useCancelWorkflowRun` hooks
- ✅ `useWorkflowLogs`, `useWorkflowEvents` hooks (EventSource)
- ✅ Type contracts: `WorkflowRun`, `JobRun`, `StepRun`

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

---

## 🎨 Phase 5: UI Implementation (NEW)

### Архитектура UI

**Pattern**: Module-based UI (как в `kb-labs-commit-plugin`), **НЕ виджеты**

**Scope v1**: **READ-ONLY** - только просмотр, запуск, отмена. Создание/редактирование workflow и cron schedules - НЕ в scope v1.

### UI Structure (FINALIZED)

**Главная страница** - 4 таба:
- **[Workflows]** - список всех workflow (можно запустить)
- **[Jobs]** - список всех jobs с фильтрами (активные, завершенные и тд)
- **[Crons]** - список всех cron jobs
- **[History]** - глобальная история выполнений

**Running Now Panel** - сворачиваемая панель вверху страницы:
- Показывает активные/running workflow/jobs/crons
- Кнопки Cancel/Stop
- Автообновление каждые 2-3 секунды

**Detail Page** (для jobs) - GitHub Actions style:
- Левая сторона: Steps timeline (вертикальный, с прогрессом)
- Правая сторона: Live logs viewer (auto-scroll, SSE)
- Табы внутри: [Logs] [Result] [History]

```
kb-labs-studio/
├── packages/studio-data-client/src/
│   ├── sources/workflow-source.ts          ✅ ГОТОВО (нужно расширить)
│   ├── sources/http-workflow-source.ts     ✅ ГОТОВО (нужно расширить)
│   ├── contracts/workflows.ts              ✅ ГОТОВО
│   └── hooks/use-workflows.ts              ✅ ГОТОВО
│
└── apps/studio/src/modules/workflow/       🆕 NEW MODULE
    ├── pages/
    │   ├── workflow-page.tsx               🆕 Main page (4 tabs + Running Now panel)
    │   └── job-detail-page.tsx             🆕 Job detail (logs + steps timeline)
    ├── components/
    │   ├── running-now-panel.tsx           🆕 Collapsible panel with active items
    │   ├── workflows-tab.tsx               🆕 Workflows list tab
    │   ├── jobs-tab.tsx                    🆕 Jobs list tab
    │   ├── crons-tab.tsx                   🆕 Cron jobs list tab
    │   ├── history-tab.tsx                 🆕 Global history tab
    │   ├── job-logs-viewer.tsx             🆕 Live logs (EventSource SSE)
    │   ├── job-steps-timeline.tsx          🆕 Steps timeline (GitHub Actions style)
    │   └── workflow-status-badge.tsx       ✅ ГОТОВО (exists)
    └── hooks/
        └── use-live-updates.ts             🆕 Auto-refresh for running items
```

---

### 5.1 Main Workflow Page (3-4 часа)

**File**: `apps/studio/src/modules/workflow/pages/workflow-page.tsx`

**UI Layout** (FINALIZED):

```tsx
/**
 * Main Workflow Page
 * - Running Now Panel (collapsible, auto-refresh)
 * - 4 Tabs: [Workflows] [Jobs] [Crons] [History]
 */
import { useDataSources } from '@/providers/data-sources-provider';
import { useQuery } from '@tanstack/react-query';
import { Tabs, Collapse } from 'antd';

export function WorkflowPage() {
  const sources = useDataSources();
  const [activeTab, setActiveTab] = useState('workflows');

  // Fetch running items для Running Now Panel
  const { data: runningItems } = useQuery({
    queryKey: ['workflow', 'running'],
    queryFn: () => sources.workflow.listJobs({ status: 'running' }), // TODO: Add
    refetchInterval: 2000, // Auto-refresh every 2s
  });

  return (
    <KBPageContainer>
      <KBPageHeader title="Workflows" description="Automation workflows dashboard" />

      {/* Running Now Panel - Collapsible */}
      <RunningNowPanel items={runningItems?.jobs || []} />

      {/* 4 Main Tabs */}
      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        <TabPane tab="Workflows" key="workflows">
          <WorkflowsTab />
        </TabPane>
        <TabPane tab="Jobs" key="jobs">
          <JobsTab />
        </TabPane>
        <TabPane tab="Crons" key="crons">
          <CronsTab />
        </TabPane>
        <TabPane tab="History" key="history">
          <HistoryTab />
        </TabPane>
      </Tabs>
    </KBPageContainer>
  );
}
```

**Components**:

1. **RunningNowPanel** - сворачиваемая панель вверху:
   - Badge с количеством активных (например, "🟢 3 Running")
   - Таблица: Job ID, Workflow Name, Status, Started At, Duration, Actions (View, Cancel)
   - Auto-refresh каждые 2s

2. **WorkflowsTab** - список всех workflow:
   - Таблица: Name, Description, Last Run, Status, Actions (Run, View)
   - Кнопка Run открывает modal для запуска

3. **JobsTab** - список всех jobs:
   - Фильтры: Status (all/running/completed/failed), Date range
   - Таблица: Job ID, Workflow, Status, Started At, Duration, Actions (View)

4. **CronsTab** - список всех cron jobs:
   - Таблица: Name, Schedule (cron expression), Enabled, Last Run, Next Run, Actions (View)

5. **HistoryTab** - глобальная история:
   - Фильтры: Workflow, Status, Date range
   - Таблица: Job ID, Workflow, Trigger, Status, Started At, Duration, Actions (View)

---

### 5.2 Job Detail Page (3-4 часа)

**File**: `apps/studio/src/modules/workflow/pages/job-detail-page.tsx`

**UI Layout** (GitHub Actions-style + Tabs):

```tsx
/**
 * Job Detail Page
 * - Job metadata header
 * - Left: Steps timeline (vertical, GitHub Actions style)
 * - Right: Tabs [Logs] [Result] [History]
 */
import { useParams } from 'react-router-dom';
import { useDataSources } from '@/providers/data-sources-provider';
import { useQuery } from '@tanstack/react-query';
import { useWorkflowLogs } from '@kb-labs/studio-data-client'; // ✅ Already exists!
import { Tabs } from 'antd';

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const sources = useDataSources();
  const [activeTab, setActiveTab] = useState('logs');

  // Fetch job details
  const { data: job } = useQuery({
    queryKey: ['workflow', 'jobs', jobId],
    queryFn: () => sources.workflow.getJob(jobId!), // TODO: Add to WorkflowDataSource
    enabled: !!jobId,
  });

  // Fetch job steps
  const { data: steps } = useQuery({
    queryKey: ['workflow', 'jobs', jobId, 'steps'],
    queryFn: () => sources.workflow.getJobSteps(jobId!), // TODO: Add to WorkflowDataSource
    enabled: !!jobId,
    refetchInterval: job?.status === 'running' ? 2000 : false, // Live updates
  });

  // Real-time logs (EventSource SSE)
  const { events: logs, isConnected } = useWorkflowLogs(job?.runId || null, {
    follow: job?.status === 'running',
  });

  return (
    <KBPageContainer>
      <JobHeader job={job} />

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24 }}>
        {/* Left: Steps Timeline */}
        <JobStepsTimeline steps={steps?.steps || []} currentStep={steps?.currentStep} />

        {/* Right: Tabs */}
        <Tabs activeKey={activeTab} onChange={setActiveTab}>
          <TabPane tab="Logs" key="logs">
            <JobLogsViewer logs={logs} isLive={isConnected} />
          </TabPane>
          <TabPane tab="Result" key="result">
            <JobResultViewer job={job} />
          </TabPane>
          <TabPane tab="History" key="history">
            <JobHistoryViewer jobId={jobId!} />
          </TabPane>
        </Tabs>
      </div>
    </KBPageContainer>
  );
}
```

**Key Components**:

1. **JobStepsTimeline** - вертикальный timeline (GitHub Actions style):
   - ✅ Completed (green checkmark)
   - ⏳ Running (spinner)
   - ⏸️ Queued (gray)
   - ❌ Failed (red X)
   - Duration for each step
   - Click на step -> scroll к его логам

2. **JobLogsViewer** - live logs (tab):
   - Auto-scroll to bottom
   - Syntax highlighting (ANSI colors)
   - Filter by level (info/warn/error)
   - Download logs button
   - Live indicator (🟢 LIVE / 🔴 DISCONNECTED)

3. **JobResultViewer** - результат выполнения (tab):
   - Output data (JSON viewer)
   - Error details (если failed)
   - Artifacts (если есть)

4. **JobHistoryViewer** - история re-runs (tab):
   - Предыдущие запуски этого же workflow
   - Comparison с предыдущими runs

---

### 5.3 Removed - Упрощено

**Workflow Detail Page удален из scope v1.**

В v1: Workflows Tab показывает все workflow, можно кликнуть "Run" → открывается modal для запуска.
Detail page для workflow не нужен в v1 (read-only scope).

---

### 5.4 Data Source Extensions

**File**: `kb-labs-studio/packages/studio-data-client/src/sources/workflow-source.ts`

**Add missing methods**:

```typescript
export interface WorkflowDataSource {
  // ✅ Already exists
  listRuns(filters?: WorkflowRunsFilters): Promise<WorkflowRunsListResponse>;
  getRun(runId: string): Promise<WorkflowRun | null>;
  cancelRun(runId: string): Promise<WorkflowRun>;
  runWorkflow?(params: WorkflowRunParams): Promise<WorkflowRun>;
  listEvents?(runId: string, options?: {...}): Promise<{...}>;

  // 🆕 NEW - Need to add
  getStats(): Promise<DashboardStatsResponse>;
  listJobs(filters?: { status?: string; limit?: number }): Promise<JobsListResponse>;
  getJob(jobId: string): Promise<JobRun | null>;
  getJobSteps(jobId: string): Promise<JobStepsResponse>;
  getJobLogs(jobId: string, filters?: { limit?: number; offset?: number; level?: string }): Promise<JobLogsResponse>;
  listWorkflows(filters?: { limit?: number }): Promise<WorkflowsListResponse>;
  getWorkflow(workflowId: string): Promise<WorkflowSpec | null>;
  getWorkflowRuns(workflowId: string, filters?: { limit?: number; offset?: number; status?: string }): Promise<WorkflowRunHistoryResponse>;
  listCronJobs(): Promise<CronJobsListResponse>;
}
```

**Implementation** in `http-workflow-source.ts`:

```typescript
export class HttpWorkflowSource implements WorkflowDataSource {
  constructor(private readonly client: HttpClient) {}

  // 🆕 NEW methods
  async getStats(): Promise<DashboardStatsResponse> {
    return await this.client.fetch<DashboardStatsResponse>('/plugins/workflow/stats');
  }

  async listJobs(filters?: { status?: string; limit?: number }): Promise<JobsListResponse> {
    const query = buildQuery(filters);
    return await this.client.fetch<JobsListResponse>(`/plugins/workflow/jobs${query}`);
  }

  async getJob(jobId: string): Promise<JobRun | null> {
    try {
      return await this.client.fetch<JobRun>(`/plugins/workflow/jobs/${jobId}`);
    } catch (error) {
      if (error instanceof KBError && error.status === 404) return null;
      throw error;
    }
  }

  async getJobSteps(jobId: string): Promise<JobStepsResponse> {
    return await this.client.fetch<JobStepsResponse>(`/plugins/workflow/jobs/${jobId}/steps`);
  }

  async getJobLogs(jobId: string, filters?: {...}): Promise<JobLogsResponse> {
    const query = buildQuery(filters);
    return await this.client.fetch<JobLogsResponse>(`/plugins/workflow/jobs/${jobId}/logs${query}`);
  }

  // ... similar for workflows, crons
}
```

---

### 5.5 Routing

**File**: `apps/studio/src/app.tsx`

**Add routes**:

```tsx
<Route path="/workflows" element={<WorkflowDashboard />} />
<Route path="/workflows/:workflowId" element={<WorkflowDetailPage />} />
<Route path="/jobs/:jobId" element={<JobDetailPage />} />
```

**Navigation** in sidebar:

```tsx
{
  key: 'workflows',
  icon: <WorkflowIcon />,
  label: 'Workflows',
  path: '/workflows',
}
```

---

## 📅 Timeline (Updated)

**Backend (COMPLETED)**: 3-4 hours ✅
- Phase 1-4: REST API + WebSocket

**Frontend (NEW)**: 5-7 hours
- Phase 5.1: Main Workflow Page (4 tabs + Running Now panel) (3-4h)
- Phase 5.2: Job Detail Page (steps timeline + tabs) (3-4h)
- Phase 5.4: Data source extensions (1h)
- Phase 5.5: Routing + navigation (30min)

**Total**: 8-11 hours (Backend ✅ + Frontend 🆕)

---

## 🚦 Progress Tracker

### Backend
- [x] Phase 1: Stats handler ✅
- [x] Phase 2: Job logs (REST + WS) ✅
- [x] Phase 3: Job steps (REST + WS) ✅
- [x] Phase 4: Workflow history (REST) ✅

### Frontend (NEW)
- [ ] Phase 5.4: Data source extensions (WorkflowDataSource interface)
- [ ] Phase 5.1: Main Workflow Page (4 tabs + Running Now panel)
- [ ] Phase 5.2: Job Detail Page (steps timeline + tabs)
- [ ] Phase 5.5: Routing + navigation

---

**Next Step**: Start Phase 5.4 - extend `WorkflowDataSource` interface with new methods needed for UI.
