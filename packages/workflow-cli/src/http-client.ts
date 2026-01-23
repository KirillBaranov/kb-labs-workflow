/**
 * HTTP client for interacting with Workflow Daemon
 */

const DEFAULT_DAEMON_URL = 'http://localhost:7778';

export interface DaemonClientOptions {
  url?: string;
}

/**
 * Get workflow daemon URL from environment or default
 */
export function getWorkflowDaemonUrl(): string {
  return process.env.WORKFLOW_DAEMON_URL ?? DEFAULT_DAEMON_URL;
}

export class WorkflowDaemonClient {
  private readonly baseUrl: string;

  constructor(options: DaemonClientOptions = {}) {
    this.baseUrl = options.url ?? process.env.WORKFLOW_DAEMON_URL ?? DEFAULT_DAEMON_URL;
  }

  /**
   * Health check
   */
  async health(): Promise<{ ok: boolean; service: string }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Get workflow metrics
   */
  async getMetrics(): Promise<any> {
    const response = await fetch(`${this.baseUrl}/metrics`);
    if (!response.ok) {
      throw new Error(`Failed to get metrics: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data;
  }

  /**
   * Get job status
   */
  async getJobStatus(jobId: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/jobs/${jobId}/status`);
    if (response.status === 404) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get job status: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data;
  }

  /**
   * Get job logs
   */
  async getJobLogs(jobId: string): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/jobs/${jobId}/logs`);
    if (response.status === 404) {
      throw new Error(`Job ${jobId} not found`);
    }
    if (!response.ok) {
      throw new Error(`Failed to get job logs: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data.logs;
  }

  /**
   * Get active executions
   */
  async getExecutions(): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/executions`);
    if (!response.ok) {
      throw new Error(`Failed to get executions: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data.executions;
  }

  /**
   * Get cron jobs
   */
  async getCronJobs(): Promise<{
    cronJobs: any[];
    total: number;
    running: boolean;
  }> {
    const response = await fetch(`${this.baseUrl}/cron/jobs`);
    if (!response.ok) {
      throw new Error(`Failed to get cron jobs: ${response.statusText}`);
    }
    const data = await response.json();
    return data.data;
  }

  /**
   * Submit a job for execution
   */
  async submitJob(params: {
    handler: string;
    input?: unknown;
    priority?: number;
  }): Promise<{ id: string; status: string }> {
    const response = await fetch(`${this.baseUrl}/jobs/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({ error: response.statusText }))) as {
        error?: string;
      };
      throw new Error(error.error || `Failed to submit job: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data;
  }
}
