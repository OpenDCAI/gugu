export default class PlaywrightCollectionGuard {
  collectedTestCount = undefined

  onBegin(_config, suite) {
    this.collectedTestCount = suite.allTests().length
  }

  onEnd(result) {
    if (this.collectedTestCount !== 0) return

    console.error('[playwright-collection-guard] 收集到 0 条用例; refusing to report a false-green run.')
    if (result.status === 'passed') return { status: 'failed' }
  }
}
