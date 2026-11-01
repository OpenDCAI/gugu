import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { WorkerAttributionReporter } from '../../../scripts/test-infra/vitest-worker-attribution-reporter'

export default defineConfig({
  test: {
    environment: 'node',
    include: [resolve(__dirname, '*.mutation.ts')],
    // 心跳周期只在这套变异装置里可调:blocked-case 那格要在两秒的阻塞里看到它报出来。
    reporters: [
      'default',
      new WorkerAttributionReporter(undefined, Number(process.env.GUGU_IN_FLIGHT_HEARTBEAT_MS) || undefined),
    ],
  },
})
