import { useState } from 'react'
import type { FormEvent } from 'react'

// Windowed page list: first/last plus two neighbours of the current page.
export function pageItems(page: number, pages: number): Array<number | 'gap'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const wanted = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter(value => value >= 1 && value <= pages))
  const sorted = [...wanted].sort((a, b) => a - b), items: Array<number | 'gap'> = []
  sorted.forEach((value, index) => {
    if (index > 0 && value - sorted[index - 1] > 1) items.push('gap')
    items.push(value)
  })
  return items
}

export default function Pagination({ page, pages, onChange, label }: {
  page: number; pages: number; onChange: (page: number) => void; label: string;
}) {
  const [jump, setJump] = useState('')
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const target = Number(jump)
    if (Number.isSafeInteger(target) && target >= 1 && target <= pages) onChange(target)
    setJump('')
  }
  return <nav className="pagination" aria-label={label}>
    <div className="pagination-pages">
      <button type="button" className="button secondary small" disabled={page <= 1} onClick={() => onChange(page - 1)}>Sebelumnya</button>
      {pageItems(page, pages).map((item, index) => item === 'gap'
        ? <span className="pagination-gap" key={`gap-${index}`} aria-hidden="true">…</span>
        : <button type="button" key={item} className={`button secondary small pagination-number ${item === page ? 'is-current' : ''}`} aria-current={item === page ? 'page' : undefined} aria-label={`Halaman ${item}`} onClick={() => onChange(item)}>{item}</button>)}
      <button type="button" className="button secondary small" disabled={page >= pages} onClick={() => onChange(page + 1)}>Berikutnya</button>
    </div>
    <form className="pagination-jump" onSubmit={submit}>
      <label>Lompat ke halaman<input type="number" inputMode="numeric" min={1} max={pages} value={jump} placeholder={`cth. ${page}`} onChange={event => setJump(event.target.value)} /></label>
      <button type="submit" className="button secondary small" disabled={!jump.trim()}>Buka</button>
    </form>
  </nav>
}
