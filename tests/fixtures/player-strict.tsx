// Development React is intentionally bundled only in memory by the M3 suite.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Player from '../../src/components/Player'
import type { LaunchSession } from '../../src/components/Player'

let root: ReturnType<typeof createRoot> | undefined
let starts = 0
export function mount(session: LaunchSession) {
  root?.unmount()
  starts = 0
  const target = document.createElement('div')
  document.body.appendChild(target)
  root = createRoot(target)
  root.render(<StrictMode><Player session={session} settings={{ volume: 0, history: false, widescreen: false }} favorite={false}
    onFavorite={() => {}} onStart={() => { starts++ }} onExit={() => root?.unmount()} onWidescreen={() => {}}
    account={{ status: 'anonymous', user: null, registrationOpen: true }} registerExitGuard={() => {}} onRestart={() => {}} /></StrictMode>)
}
export function startCount() { return starts }
export function unmount() { root?.unmount(); root = undefined }
