/** The window must accept unload before any backend resources are dismantled. */
export function createQuitFlow(deps: { hasWindow: () => boolean; closeWindow: () => void; shutdown: () => Promise<void>; quit: () => void }) {
  let requested = false, shuttingDown = false, finished = false
  return {
    beforeQuit(event: { preventDefault(): void }) {
      if (finished) return
      event.preventDefault()
      if (shuttingDown) return
      if (deps.hasWindow()) { requested = true; deps.closeWindow(); return }
      shuttingDown = true
      void deps.shutdown().finally(() => { finished = true; deps.quit() })
    },
    cancelClose() { requested = false },
    windowClosed() { if (requested) { requested = false; deps.quit() } }
  }
}
