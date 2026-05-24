import { useEffect, useRef, useState } from 'react'

export interface DragUploadState {
  /** True while a file is being dragged anywhere over the page. */
  isDragging: boolean
  /**
   * Filename + size of the dragged file when the browser exposes it
   * (Firefox + some Chromium variants), null otherwise. Pre-drop
   * metadata is unreliable across browsers — render a generic fallback.
   */
  fileHint: { name: string; size: number } | null
}

interface Options {
  /** Called once when a valid file is dropped on the window. */
  onFile: (file: File) => void
  /** Comma-separated MIME prefixes accepted (defaults to image only). */
  accept?: string[]
}

const DEFAULT_ACCEPT = ['image/png', 'image/jpeg', 'image/gif']

/**
 * Window-level drag-and-drop handler for image upload. Maintains a
 * drag-counter to avoid the dragenter/dragleave flicker that fires when
 * the cursor crosses child element boundaries (HTML5 drag fires both
 * events on every parent → child transition; counting them is the
 * standard mitigation).
 *
 * Single source of truth: this hook should be mounted exactly once at
 * the page root. The visual effect spans both the upload tile and the
 * canvas overlay, so the consumer (HomePage) reads `isDragging` and
 * threads it to both renderers.
 */
export function useWindowDragUpload({ onFile, accept = DEFAULT_ACCEPT }: Options): DragUploadState {
  const [state, setState] = useState<DragUploadState>({ isDragging: false, fileHint: null })
  // useRef so the listener closures see the live counter without
  // re-binding listeners on every state change.
  const counterRef = useRef(0)
  // Latest onFile pinned via ref so the effect's deps stay [accept] only,
  // avoiding listener churn when the parent re-renders.
  const onFileRef = useRef(onFile)
  onFileRef.current = onFile

  useEffect(() => {
    function hasFiles(e: DragEvent): boolean {
      const types = e.dataTransfer?.types
      if (!types) return false
      // The standard says "Files" appears in dataTransfer.types when
      // dragging files; some old browsers used "application/x-moz-file".
      for (let i = 0; i < types.length; i++) {
        if (types[i] === 'Files') return true
      }
      return false
    }

    function readHint(e: DragEvent): { name: string; size: number } | null {
      // Most browsers don't expose dataTransfer.files until drop. items[i]
      // gives kind/type but not name. Try; fall back to null.
      const items = e.dataTransfer?.items
      if (!items) return null
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === 'file') {
          const file = item.getAsFile?.()
          if (file) return { name: file.name, size: file.size }
        }
      }
      return null
    }

    function onDragEnter(e: DragEvent) {
      if (!hasFiles(e)) return
      counterRef.current += 1
      if (counterRef.current === 1) {
        setState({ isDragging: true, fileHint: readHint(e) })
      }
    }
    function onDragOver(e: DragEvent) {
      if (!hasFiles(e)) return
      // Required so `drop` fires; otherwise the browser refuses the drop.
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    }
    function onDragLeave(e: DragEvent) {
      if (!hasFiles(e)) return
      counterRef.current = Math.max(0, counterRef.current - 1)
      if (counterRef.current === 0) {
        setState({ isDragging: false, fileHint: null })
      }
    }
    function onDrop(e: DragEvent) {
      // Always prevent default on drop so the browser doesn't
      // navigate to the file URL when our handler can't accept it.
      e.preventDefault()
      counterRef.current = 0
      setState({ isDragging: false, fileHint: null })
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      const file = files[0]
      if (accept.length === 0 || accept.includes(file.type)) {
        onFileRef.current(file)
      }
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      counterRef.current = 0
    }
  }, [accept])

  return state
}
