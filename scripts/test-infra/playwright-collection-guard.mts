import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter'

export default class PlaywrightCollectionGuard implements Reporter {
  collectedTestCount: number | undefined = undefined

  onBegin(_config: FullConfig, suite: Suite): void {
    this.collectedTestCount = suite.allTests().length
  }

  async onEnd(result: FullResult): Promise<{ status: 'failed' } | undefined> {
    if (this.collectedTestCount !== 0) return undefined

    console.error('[playwright-collection-guard] 收集到 0 条用例; refusing to report a false-green run.')
    if (result.status === 'passed') return { status: 'failed' }
    return undefined
  }
}
