import { useLayoutEffect } from 'react'
import { rendererLogger } from '../lib/log'
import { isAndroidStartupRuntime, reportAndroidStartupFrame } from './androidStartupHandoff'

const log = rendererLogger('mobile/startup')

/** An observer only: the bootstrap owns the one brand document and native visual handoff. */
export function AndroidStartupFrame() {
  useLayoutEffect(() => {
    if (!isAndroidStartupRuntime()) return
    void reportAndroidStartupFrame().catch((error: unknown) => {
      log.error({ error: String(error) }, 'Android did not receive the first React commit')
    })
  }, [])
  return null
}
