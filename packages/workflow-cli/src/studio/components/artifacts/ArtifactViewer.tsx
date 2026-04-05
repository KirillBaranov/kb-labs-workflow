/**
 * Polymorphic artifact viewer.
 * Routes to the appropriate sub-component based on artifact type.
 */

import { UIJsonViewer } from '@kb-labs/sdk/studio'
import { MarkdownViewer } from './MarkdownViewer'
import { IssuesViewer } from './IssuesViewer'
import { TableViewer } from './TableViewer'
import { DiffViewer } from './DiffViewer'
import { LogViewer } from './LogViewer'
import { LinkViewer } from './LinkViewer'

export interface ArtifactViewerProps {
  type: 'markdown' | 'issues' | 'table' | 'diff' | 'log' | 'json' | 'link'
  data: unknown
  label?: string
  editable?: boolean
  onEdit?: (newValue: unknown) => void
}

export function ArtifactViewer({ type, data, label, editable, onEdit }: ArtifactViewerProps) {
  if (type === 'link') {
    return <LinkViewer data={data} label={label} />
  }
  if (type === 'markdown') {
    return <MarkdownViewer data={data} editable={editable} onEdit={onEdit} />
  }
  if (type === 'issues') {
    return <IssuesViewer data={data} />
  }
  if (type === 'table') {
    return <TableViewer data={data} />
  }
  if (type === 'diff') {
    return <DiffViewer data={data} />
  }
  if (type === 'log') {
    return <LogViewer data={data} />
  }
  if (type === 'json') {
    return <UIJsonViewer data={data} />
  }
  return null
}
