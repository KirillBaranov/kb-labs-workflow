import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  JobRun,
  StepRun,
  WorkflowRun,
  StepSpec,
} from '@kb-labs/workflow-contracts'
import { JobRunner, type JobDispatchResult } from '../job-runner'
import type {
  JobHandler,
  JobHandlerResult,
  JobExecutionContext,
} from '../job-runner'
import { WorkflowJobHandler } from '../job-handler'
import type { StepExecutionResult as RuntimeStepExecutionResult } from '@kb-labs/workflow-runtime'
import type { StateStore } from '../state-store'

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const events = {
  publish: vi.fn(() => Promise.resolve()),
}

const concurrency = {
  release: vi.fn(() => Promise.resolve()),
}

describe('JobRunner timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.resetAllMocks()
  })

  it('aborts job when timeout is exceeded and marks it failed with JOB_TIMEOUT', async () => {
    const fixture = createRunFixture({
      jobTimeoutMs: 50,
      stepTimeoutMs: undefined,
    })

    const store = createStateStore(fixture.run)
    const stateStore = store as unknown as StateStore
    const handler: JobHandler = {
      execute: (context: JobExecutionContext) =>
        new Promise<JobHandlerResult>((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              resolve({
                status: 'cancelled',
                error: { message: 'aborted' },
              })
            },
            { once: true },
          )
        }),
    }

    const jobRunner = new JobRunner(
      {
        stateStore,
        events: events as any,
        concurrency: concurrency as any,
        logger,
      },
      handler,
    )

    const dispatchPromise = jobRunner.dispatch({
      entry: fixture.entry,
      signal: new AbortController().signal,
      heartbeat: vi.fn(() => Promise.resolve()),
      now: new Date(fixture.now),
    })

    await vi.advanceTimersByTimeAsync(100)
    const result = await dispatchPromise

    expectResultFailure(result, 'JOB_TIMEOUT')

    const updatedRun = await store.getRun(fixture.run.id)
    expect(updatedRun?.status).toBe('failed')
    const [job] = updatedRun?.jobs ?? []
    expect(job).toBeDefined()
    expect(job?.status).toBe('failed')
    expect(job?.error?.code).toBe('JOB_TIMEOUT')
  })

  it('aborts step when timeout is exceeded and records STEP_TIMEOUT', async () => {
    const fixture = createRunFixture({
      jobTimeoutMs: undefined,
      stepTimeoutMs: 40,
    })

    const store = createStateStore(fixture.run)
    const stateStore = store as unknown as StateStore
    const resolver = {
      resolve: vi.fn(),
      ensureReady: vi.fn(() => Promise.resolve()),
      dispose: vi.fn(() => Promise.resolve()),
    }

    const jobHandler = new WorkflowJobHandler({
      logger,
      events: events as any,
      resolver: resolver as any,
    })

    const localRunnerMock = vi.fn().mockImplementation(
      (
        request: { signal?: AbortSignal },
      ): Promise<RuntimeStepExecutionResult> =>
        new Promise((resolve) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              resolve({
                status: 'cancelled',
                error: { message: 'cancelled' },
              })
            },
            { once: true },
          )
        }),
    )

    ;(jobHandler as any).localRunner = { execute: localRunnerMock }

    const jobRunner = new JobRunner(
      {
        stateStore,
        events: events as any,
        concurrency: concurrency as any,
        logger,
      },
      jobHandler,
    )

    const dispatchPromise = jobRunner.dispatch({
      entry: fixture.entry,
      signal: new AbortController().signal,
      heartbeat: vi.fn(() => Promise.resolve()),
      now: new Date(fixture.now),
    })

    await vi.advanceTimersByTimeAsync(100)
    const result = await dispatchPromise

    expect(result.outcome).toBe('completed')
    expect(result.error?.code).toBe('STEP_TIMEOUT')

    const updatedRun = await store.getRun(fixture.run.id)
    expect(updatedRun?.status).toBe('failed')
    const [job] = updatedRun?.jobs ?? []
    expect(job).toBeDefined()
    expect(job?.status).toBe('failed')
    const [step] = job?.steps ?? []
    expect(step).toBeDefined()
    expect(step?.status).toBe('failed')
    expect(step?.error?.code).toBe('STEP_TIMEOUT')
  })
})

function createRunFixture(options: {
  jobTimeoutMs?: number
  stepTimeoutMs?: number
}) {
  const now = new Date().toISOString()
  const runId = 'run-1'
  const jobId = `${runId}:job`
  const stepId = `${jobId}:0`

  const stepSpec: StepSpec = {
    name: 'slow-step',
    uses: 'builtin:shell',
    with: {
      command: 'echo "hello"',
    },
    timeoutMs: options.stepTimeoutMs,
  }

  const stepRun: StepRun = {
    id: stepId,
    runId,
    jobId,
    name: stepSpec.name,
    index: 0,
    status: 'queued',
    queuedAt: now,
    attempt: 0,
    timeoutMs: options.stepTimeoutMs,
    continueOnError: false,
    spec: stepSpec,
  } as StepRun

  const job: JobRun = {
    id: jobId,
    runId,
    jobName: 'job',
    status: 'queued',
    runsOn: 'local',
    queuedAt: now,
    attempt: 0,
    steps: [stepRun],
    concurrency: undefined,
    retries: undefined,
    timeoutMs: options.jobTimeoutMs,
    artifacts: undefined,
    env: undefined,
    secrets: undefined,
    needs: [],
    pendingDependencies: [],
    blocked: false,
    priority: 'normal',
  } as JobRun

  const run: WorkflowRun = {
    id: runId,
    name: 'timeout-run',
    version: '1',
    status: 'queued',
    createdAt: now,
    queuedAt: now,
    trigger: {
      type: 'manual',
    },
    jobs: [job],
    metadata: {},
    artifacts: [],
  } as WorkflowRun

  const entry = {
    id: `${jobId}:entry`,
    runId,
    jobId,
    jobName: job.jobName,
    priority: job.priority ?? 'normal',
    enqueuedAt: now,
    availableAt: Date.parse(now),
  }

  return { run, entry, now }
}

function createStateStore(initialRun: WorkflowRun) {
  let currentRun = clone(initialRun)

  return {
    async getRun(runId: string): Promise<WorkflowRun | null> {
      if (runId !== currentRun.id) {
        return null
      }
      return clone(currentRun)
    },
    async updateRun(
      runId: string,
      mutator: (draft: WorkflowRun) => WorkflowRun | void,
    ): Promise<WorkflowRun | null> {
      if (runId !== currentRun.id) {
        return null
      }
      const draft = clone(currentRun)
      const result = mutator(draft)
      currentRun = clone((result ?? draft) as WorkflowRun)
      return clone(currentRun)
    },
    async updateJob(
      runId: string,
      jobId: string,
      mutator: (job: JobRun) => JobRun | void,
    ): Promise<JobRun | null> {
      if (runId !== currentRun.id) {
        return null
      }
      const runDraft = clone(currentRun)
      const index = runDraft.jobs.findIndex((job) => job.id === jobId)
      if (index === -1) {
        return null
      }
      const originalJob = runDraft.jobs[index]
      if (!originalJob) {
        return null
      }
      const jobDraft = clone(originalJob)
      const result = mutator(jobDraft)
      runDraft.jobs[index] = clone((result ?? jobDraft) as JobRun)
      currentRun = clone(runDraft)
      return clone(currentRun.jobs[index]!)
    },
    async updateStep(
      runId: string,
      jobId: string,
      stepId: string,
      mutator: (step: StepRun) => StepRun | void,
    ): Promise<StepRun | null> {
      if (runId !== currentRun.id) {
        return null
      }
      const runDraft = clone(currentRun)
      const jobIndex = runDraft.jobs.findIndex((job) => job.id === jobId)
      if (jobIndex === -1) {
        return null
      }
      const originalJob = runDraft.jobs[jobIndex]
      if (!originalJob) {
        return null
      }
      const jobDraft = clone(originalJob)
      const stepIndex = jobDraft.steps.findIndex((step) => step.id === stepId)
      if (stepIndex === -1) {
        return null
      }
      const originalStep = jobDraft.steps[stepIndex]
      if (!originalStep) {
        return null
      }
      const stepDraft = clone(originalStep)
      const result = mutator(stepDraft)
      const nextStep = clone((result ?? stepDraft) as StepRun)
      jobDraft.steps[stepIndex] = nextStep
      runDraft.jobs[jobIndex] = clone(jobDraft)
      currentRun = clone(runDraft)
      return clone(nextStep)
    },
    async releaseBlockedJobs(
      _runId: string,
      _completedJobName: string,
    ): Promise<JobRun[]> {
      return []
    },
  }
}

function clone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}

function expectResultFailure(result: JobDispatchResult, code: string) {
  expect(result.outcome).toBe('completed')
  expect(result.error?.code).toBe(code)
}

