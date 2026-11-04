// M0 only. Served by the isolated test HTTP server, never included in public/.
import { engineRomInput } from '../../src/lib/engine-assets'
type Snapshot = { progress: number[]; metadata: { runtimeBuild: string; coreBuild: string; engineVersion: string; variant: string; formatVersion: number } }
type Configure = { mode: 'url' | 'prepared'; url: string; biosUrl: string; rom?: File; bios?: Blob; saveId: string; initial?: Snapshot }
type Engine = {
  fileName: string; mainduluCoreFile: string;
  gameManager: { writeFile: (path: string, bytes: Uint8Array) => void };
}
const scope = window as unknown as Record<string, unknown>
const urls: string[] = []
let configured = false
window.addEventListener('pagehide', () => { for (const url of urls) URL.revokeObjectURL(url) })
window.addEventListener('unhandledrejection', event => {
  if (/wake\s?lock/i.test(event.reason?.message ?? '')) event.preventDefault()
})
window.addEventListener('message', async event => {
  if (event.source !== parent || event.origin !== location.origin || event.data?.type !== 'spike-configure' || configured) return
  configured = true
  const config = event.data.config as Configure
  const input = config.mode === 'prepared' ? engineRomInput(config.rom!) : undefined
  window.addEventListener('pagehide', () => input?.release(), { once: true })
  const builds = await (await fetch('/player/builds.json', { cache: 'no-store' })).json()
  function metadata(e: Engine) {
    return { formatVersion: 1, engineVersion: builds.engineVersion, runtimeBuild: builds.runtimeBuild, coreBuild: builds.cores[e.mainduluCoreFile], variant: e.mainduluCoreFile.includes('-legacy-') ? 'legacy' : 'normal' }
  }
  Object.assign(scope, {
    EJS_player: '#game', EJS_core: 'fceumm', EJS_gameName: config.saveId,
    EJS_gameUrl: config.mode === 'prepared' ? input!.file : config.url,
    EJS_biosUrl: config.biosUrl, EJS_pathtodata: '/vendor/emulatorjs/4.2.3/data/',
    EJS_disableDatabases: true, EJS_CacheLimit: 0, EJS_mainduluMemorySaves: true,
    EJS_disableLocalStorage: true, EJS_threads: false, EJS_startOnLoaded: false,
    EJS_startButtonName: 'Mulai bermain', EJS_language: 'en-US', EJS_disableAutoLang: true,
    EJS_volume: 0, EJS_defaultOptions: { 'save-state-location': 'browser', ejs_threads: 'disabled' },
    EJS_ready: () => {
      const button = document.querySelector('.ejs_start_button')!
      button.setAttribute('role', 'button')
      parent.postMessage({ type: 'spike-ready' }, location.origin)
    },
    EJS_mainduluBeforeBoot: (e: Engine) => {
      const value = metadata(e)
      if (config.initial && Object.keys(value).some(key => value[key as keyof typeof value] !== config.initial!.metadata[key as keyof Snapshot['metadata']])) throw new Error('Build mismatch in M0 spike')
      const progressPath = `/data/saves/FCEUmm/${e.fileName.replace(/\.[^.]+$/, '')}.srm`
      if (config.initial) e.gameManager.writeFile(progressPath, new Uint8Array(config.initial.progress))
      scope.spikeMetadata = value
      scope.spikeBeforeBootPath = progressPath
    },
    EJS_onGameStart: () => { input?.release(); scope.spikeStarted = true },
  })
  if (config.mode === 'prepared') {
    const url = URL.createObjectURL(config.bios!)
    urls.push(url)
    scope.EJS_biosUrl = url
    scope.spikeClone = { isFile: config.rom instanceof File, name: config.rom!.name, size: config.rom!.size }
  }
  const script = document.createElement('script')
  script.src = '/vendor/emulatorjs/4.2.3/data/loader.js'
  document.head.appendChild(script)
})
parent.postMessage({ type: 'spike-frame-ready' }, location.origin)
