/** Optional inventory work must not compete with a cloud assistant's first model request. */
export class StartupDiscovery {
  private released: boolean
  private readonly waiting: Array<() => void> = []

  constructor(deferred: boolean) { this.released = !deferred }

  schedule(work: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = () => { void Promise.resolve().then(work).then(resolve, reject) }
      if (this.released) start()
      else this.waiting.push(start)
    })
  }

  /** A model-issued tool has settled; this is later than tools/list and the first API response. */
  release(): void {
    if (this.released) return
    this.released = true
    const waiting = this.waiting.splice(0)
    setImmediate(() => { for (const start of waiting) start() })
  }
}

export const startupDiscovery = new StartupDiscovery(process.env.GUGU_CLOUD_COMPUTER === '1')
