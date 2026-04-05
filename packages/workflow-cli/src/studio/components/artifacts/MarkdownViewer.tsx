import { useState } from 'react'
import { UIMarkdownViewer, UIButton } from '@kb-labs/sdk/studio'
import styles from './artifacts.module.css'

interface Props {
  data: unknown
  editable?: boolean
  onEdit?: (v: unknown) => void
}

export function MarkdownViewer({ data, editable, onEdit }: Props) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(text)

  if (editing && editable) {
    return (
      <div>
        <textarea
          className={styles.textarea}
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
        />
        <div className={styles.editActions}>
          <UIButton size="small" variant="primary" onClick={() => { onEdit?.(editValue); setEditing(false) }}>
            Save
          </UIButton>
          <UIButton size="small" variant="default" onClick={() => { setEditValue(text); setEditing(false) }}>
            Cancel
          </UIButton>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      {editable && (
        <UIButton size="small" variant="text" style={{ float: 'right' }} onClick={() => setEditing(true)}>
          Edit
        </UIButton>
      )}
      <UIMarkdownViewer content={text} />
    </div>
  )
}
