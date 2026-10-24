import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'

export default function Dialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus()
    return () => { document.body.style.overflow = bodyOverflow; previous?.focus() }
  }, [])
  useEffect(() => {
    // Disabling the focused submit button can move focus to document.body.
    // Restore the dialog boundary so Escape/Tab still work after a failed
    // request or when switching to the one-time recovery-code screen.
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus()
  }, [busy, title])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
    <div className="dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabIndex={-1} onKeyDown={e => {
      if (e.key === 'Escape' && !busy) onClose()
      if (e.key !== 'Tab') return
      const items = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')
      if (!items?.length) return
      const first = items[0], last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus() }
    }}>
      <div className="dialog-heading"><div><span className="eyebrow">SEDIKIT LAGI, MULAI MAIN</span><h2 id="dialog-title">{title}</h2></div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Tutup dialog"><X size={21} /></button></div>
      {children}
    </div>
  </div>
}
