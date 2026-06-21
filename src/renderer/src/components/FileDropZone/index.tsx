import { useState, useCallback, type DragEvent } from 'react'
import styles from './dropzone.module.scss'
import clsx from 'clsx'

interface FileDropZoneProps {
  onDrop: (files: File[]) => void
  children: React.ReactNode
}

export function FileDropZone({ onDrop, children }: FileDropZoneProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])
  const handleDragLeave = useCallback(() => setDragging(false), [])
  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length) onDrop(files)
    },
    [onDrop]
  )

  return (
    <div
      className={clsx(styles.zone, dragging && styles.active)}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {dragging && <div className={styles.overlay}>拖放文件到此处上传到知识库</div>}
    </div>
  )
}
