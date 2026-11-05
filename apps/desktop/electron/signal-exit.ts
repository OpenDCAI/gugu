// How the desktop / account process leaves on a signal. Everything it touches comes in through `deps`, so this
// file has no runtime imports: the boot smoke test runs it, transpiled as it is, inside a real child binary.

/** 128 + signal number; SIGUSR2 is the supervisor's "restart" (the legacy guard asks for it). */
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const

export type ExitSignal = 'SIGINT' | 'SIGTERM' | 'SIGUSR2'

export interface SignalExitDeps<Host> {
  serverMode: boolean
  exitRestart: number
  exitSignedOut: number
  stopActivity: () => void
  /** One account process run directly by the single-server supervisor (not under a guard). */
  singleRun: () => boolean
  sessionFileExists: () => boolean
  /** Who supervises this process, from GUGU_SERVER_SUPERVISED. */
  supervisedBy: () => string | undefined
  markStopped: () => void
  noteExitReason: () => void
  killEngines: (label: ExitSignal) => void
  exit: (code: number) => void
  host: () => Host | null
  /** Stops the device runtime host within its signal budget. */
  stopHost: (host: Host) => Promise<unknown>
  warn: (detail: Record<string, unknown>, message: string) => void
}

export function createSignalExit<Host>(deps: SignalExitDeps<Host>) {
  let stopping = false
  const exitOnSignal = (label: ExitSignal, code: number): void => {
    deps.stopActivity()
    if (deps.singleRun()) {
      if (code === SIGNAL_EXIT_CODES.SIGTERM && !deps.sessionFileExists()) code = deps.exitSignedOut
      if (code !== deps.exitRestart && !['systemd', 'launchd'].includes(deps.supervisedBy() ?? '')) deps.markStopped()
    }
    // 有人要它停(stop / systemd / 守护进程收账号进程):留一句,开机收残据此说「重启打断了这一轮」(守护进程换版时先写了 update,不改)。
    deps.noteExitReason()
    const finish = (): void => {
      deps.killEngines(label)
      deps.exit(code)
    }
    const host = deps.host()
    if (!deps.serverMode || !host || stopping) return finish()
    stopping = true
    void deps.stopHost(host)
      .catch((error: unknown) => deps.warn({ label, error: String(error) }, 'device runtime stop on signal failed'))
      .finally(finish)
  }
  return {
    exitOnSignal,
    /** A signal stop is under way: periodic work must not start again. */
    stopping: () => stopping,
    /** Registers the handlers on the process: SIGINT, SIGTERM, and in server mode SIGUSR2 (restart). */
    listen(on: (signal: ExitSignal, handler: () => void) => void): void {
      on('SIGINT', () => exitOnSignal('SIGINT', SIGNAL_EXIT_CODES.SIGINT))
      on('SIGTERM', () => exitOnSignal('SIGTERM', SIGNAL_EXIT_CODES.SIGTERM))
      if (deps.serverMode) on('SIGUSR2', () => exitOnSignal('SIGUSR2', deps.exitRestart))
    },
  }
}
