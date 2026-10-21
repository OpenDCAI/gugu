import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter'

declare class PlaywrightCollectionGuard implements Reporter {
  collectedTestCount: number | undefined
  onBegin(config: FullConfig, suite: Suite): void
  onEnd(result: FullResult): { status: 'failed' } | undefined
}

export default PlaywrightCollectionGuard
