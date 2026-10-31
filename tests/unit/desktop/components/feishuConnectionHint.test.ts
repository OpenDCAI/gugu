import { expect, it } from 'vitest'
import { enUSCapabilityMessages, zhCNCapabilityMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages-capabilities'
import { provider } from '../../../../packages/session-plugins/src/integrations/impl/feishu'

it.each([
  ['zh-CN', '用飞书扫码授权', zhCNCapabilityMessages],
  ['en', 'Scan with Feishu to authorize', enUSCapabilityMessages],
] as const)('shows the same immediate Feishu action in %s without promising a fixed number of stages', (locale, expected, catalog) => {
  expect(catalog['integrations.cliFeishuHint']).toBe(expected)
  const method = provider.capabilities.auth.methods.find(method => method.kind === 'cli')
  expect(method?.kind === 'cli' && method.prerequisite?.text[locale]).toBe(expected)
})
