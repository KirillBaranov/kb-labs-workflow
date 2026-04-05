import styles from './artifacts.module.css'

export function LogViewer({ data }: { data: unknown }) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return <pre className={styles.logPre}>{text}</pre>
}
