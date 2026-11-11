// Serializes state capture/upload work between manual slots, Autosave and the
// Save & exit coordinator. A ref-held lock is safer than React state here:
// two rapid clicks or an autosave tick must observe the same guard immediately.
export class OperationLock {
  private token: symbol | null = null
  acquire(): symbol | null {
    if (this.token) return null
    const token = Symbol('state-operation')
    this.token = token
    return token
  }
  release(token: symbol) {
    if (this.token === token) this.token = null
  }
  // Save & exit waits for an in-flight Autosave/manual upload instead of
  // failing immediately. The timeout prevents an unknown hung operation from
  // holding the player forever; the caller reports the failure and stays put.
  async acquireWithin(timeoutMs: number): Promise<symbol | null> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      const token = this.acquire()
      if (token) return token
      if (Date.now() >= deadline) return null
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  get busy() {
    return this.token !== null
  }
}
