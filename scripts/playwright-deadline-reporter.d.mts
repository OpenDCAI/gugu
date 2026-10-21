export interface PlaywrightDeadlineReporterOptions {
  env?: NodeJS.ProcessEnv
  signal?: (name: NodeJS.Signals) => void
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
}

export class PlaywrightDeadlineReporter {
  constructor(options?: PlaywrightDeadlineReporterOptions)
  onBegin(): void
  onEnd(): void
}

export default PlaywrightDeadlineReporter
