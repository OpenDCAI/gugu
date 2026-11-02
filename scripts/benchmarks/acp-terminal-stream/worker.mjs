import { bootAcpRuntimeProcess } from '../../../packages/session-runtime/src/acp-agents/node/boot.ts'
import { createPluginRegistry } from '../../../packages/session-core/src/agents/plugins/index.ts'
import { connectStdioAcpV2 } from '../../../packages/session-plugins/src/agents/helpers/acp-v2.ts'
const registry = createPluginRegistry()
const absent = { kind: 'none', degraded: { code: 'unverified', reason: 'memory fixture' } }
registry.register({
  metadata: {
    id: 'codex',
    name: 'Memory fixture',
    description: 'Memory fixture',
    websiteUrl: 'https://example.com'
  },
  capabilities: {
    acp: { kind: 'supported', liveSettings: {} },
    auth: { kind: 'none' },
    autoApprove: { kind: 'none' },
    hostDependency: { binaryNames: ['node'], installCommands: {}, updates: { kind: 'none' } },
    sessionBundle: {
      injectionMode: 'runtime',
      platform: { kind: 'unsupported', reason: 'fixture' },
      surfaces: ['acp'],
      sessionpage: { acp: { identity: 'none', messageTransport: 'router' } },
      units: { mcp: absent, env: absent, model: absent, autonomy: absent, promptBlocks: absent },
      extension: absent
    }
  },
  behavior: {
    acp: {
      buildSpawn: (ctx) => ({
        command: process.execPath,
        args: [process.env.BENCH_PROVIDER],
        env: ctx.env
      }),
      connect: connectStdioAcpV2
    }
  }
})
process.on('message', (message) => {
  if (message?.kind === 'benchmark-measure')
    process.send?.({
      kind: 'benchmark-result',
      pid: process.pid,
      usage: process.resourceUsage(),
      memory: process.memoryUsage()
    })
})
bootAcpRuntimeProcess({
  pluginRegistry: registry,
  mergeEnvelopes: (texts) => texts.join('\n'),
  recoverDelivery: (text) => text
})
