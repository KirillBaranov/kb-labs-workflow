import styles from './artifacts.module.css'

export function LinkViewer({ data, label }: { data: unknown; label?: string }) {
  const url = typeof data === 'string' ? data : null

  if (!url) {
    return <span className={styles.empty}>—</span>
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={styles.link}>
      {label ?? url}
      <span className={styles.linkArrow}>↗</span>
    </a>
  )
}
