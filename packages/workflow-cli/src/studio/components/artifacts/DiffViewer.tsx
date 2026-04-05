import { UIDiffViewer } from '@kb-labs/sdk/studio'

export function DiffViewer({ data }: { data: unknown }) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return <UIDiffViewer diff={text} maxHeight={500} />
}
