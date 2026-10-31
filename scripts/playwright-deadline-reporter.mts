export interface PlaywrightDeadlineReporterOptions {
  env?: NodeJS.ProcessEnv
  signal?: (name: NodeJS.Signals) => void
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
}

function positiveMilliseconds(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer in milliseconds`)
  }
  return Number(value)
}

export class PlaywrightDeadlineReporter {
  private readonly env: NodeJS.ProcessEnv
  private readonly signal: (name: NodeJS.Signals) => void
  private readonly schedule: typeof setTimeout
  private readonly cancel: typeof clearTimeout
  private softTimer: ReturnType<typeof setTimeout> | undefined
  private hardTimer: ReturnType<typeof setTimeout> | undefined

  constructor({
    env = process.env,
    signal = (name) => process.kill(process.pid, name),
    schedule = setTimeout,
    cancel = clearTimeout,
  }: PlaywrightDeadlineReporterOptions = {}) {
    this.env = env
    this.signal = signal
    this.schedule = schedule
    this.cancel = cancel
  }

  onBegin(): void {
    const softMs = positiveMilliseconds(
      'GUGU_PLAYWRIGHT_SOFT_TIMEOUT_MS',
      this.env.GUGU_PLAYWRIGHT_SOFT_TIMEOUT_MS,
    )
    const killAfterMs = positiveMilliseconds(
      'GUGU_PLAYWRIGHT_KILL_AFTER_MS',
      this.env.GUGU_PLAYWRIGHT_KILL_AFTER_MS,
    )
    if (softMs === undefined && killAfterMs === undefined) return
    if (softMs === undefined || killAfterMs === undefined) {
      throw new Error('Playwright deadline requires both soft timeout and kill-after values')
    }

    this.softTimer = this.schedule(() => {
      console.error(`[playwright-deadline] ${softMs}ms elapsed; sending SIGINT so reporters can finish`)
      this.hardTimer = this.schedule(() => {
        console.error(`[playwright-deadline] ${killAfterMs}ms grace elapsed; sending SIGKILL`)
        this.signal('SIGKILL')
      }, killAfterMs)
      this.signal('SIGINT')
    }, softMs)
  }

  onEnd(): void {
    if (this.softTimer !== undefined) this.cancel(this.softTimer)
    if (this.hardTimer !== undefined) this.cancel(this.hardTimer)
  }
}

export default PlaywrightDeadlineReporter
