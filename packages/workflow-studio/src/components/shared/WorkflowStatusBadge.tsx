import { UIBadge } from '@kb-labs/sdk/studio';
import type { WorkflowRun, JobRun } from '@kb-labs/workflow-contracts'

type WorkflowLikeStatus = WorkflowRun['status'] | JobRun['status']

const STATUS_VARIANTS: Record<WorkflowLikeStatus, 'info' | 'success' | 'warning' | 'error'> = {
  queued: 'info',
  running: 'warning',
  success: 'success',
  failed: 'error',
  cancelled: 'warning',
  skipped: 'info',
  waiting_approval: 'warning',
}

const STATUS_LABELS: Partial<Record<WorkflowLikeStatus, string>> = {
  waiting_approval: 'WAITING APPROVAL',
}

export function WorkflowStatusBadge({ status }: { status: WorkflowLikeStatus }) {
  const variant = STATUS_VARIANTS[status] ?? 'info'
  const label = STATUS_LABELS[status] ?? status.toUpperCase()
  return <UIBadge variant={variant}>{label}</UIBadge>
}
