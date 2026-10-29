import { expect, it } from 'vitest'
import { phoneParentRoute } from '../../../apps/desktop/src/mobile/assistant/phoneRoutes'

it.each([
  ['settings:connectors', 'settings'],
  ['settings:connector:feishu', 'settings:connectors'],
  ['settings:connector:feishu:connect', 'settings:connector:feishu'],
  ['settings:devices', 'settings'],
  ['settings:devices:this-phone', 'settings:devices'],
] as const)('returns %s to its immediate settings parent %s', (sub, parent) => {
  expect(phoneParentRoute({ tab: 'profile', sub })).toEqual({ tab: 'profile', sub: parent })
})
