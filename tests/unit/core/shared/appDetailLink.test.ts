import { describe, expect, it } from 'vitest'
import { guguLink, linkTargetOf, parseGuguLink } from '@gugu/core/shared/ui/guguLink'

describe('App resource references', () => {
  it.each(['gugu', 'gugu-beta', 'gugu-dev'])('round-trips market, installed App and device fork in %s', (scheme) => {
    for (const scope of [{}, { deviceId: 'registered-host' }, { deviceId: 'registered-host', variant: 'my-fork' }]) {
      const target = { kind: 'app-detail' as const, extensionId: 'kanban', ...scope }
      expect(parseGuguLink(guguLink(target, scheme))).toEqual(target)
      expect(linkTargetOf({ kind: target.kind, app: target.extensionId, device: scope.deviceId, variant: scope.variant }, { id: 'own', contributes: { tabs: [] } })).toEqual(target)
    }
  })
  it.each(['?variant=mine', '?device=', '?device=x&variant=中文', '?device=x&variant=UPPER', '?device=x&variant=../x', '?device=x&device=y', '?device=x&variant=mine&variant=other', '?profile=x', '#mine'])('refuses ambiguous or unscoped references %s', (suffix) => {
    expect(parseGuguLink(`gugu://app/kanban${suffix}`)).toBeNull()
  })
  it('keeps App content links separate and refuses a fork without device when generating', () => {
    expect(parseGuguLink('gugu://ext/kanban/main')).toMatchObject({ kind: 'app', extensionId: 'kanban' })
    expect(() => guguLink({ kind: 'app-detail', extensionId: 'kanban', variant: 'mine' }, 'gugu')).toThrow()
  })
})
