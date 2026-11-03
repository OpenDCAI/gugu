// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { createAvatar } from '../../../../apps/desktop/node_modules/@dicebear/core'
vi.mock('../../../../apps/desktop/node_modules/@dicebear/core', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/node_modules/@dicebear/core')>()
  return { ...actual, createAvatar: vi.fn(actual.createAvatar) }
})
beforeEach(() => { vi.resetModules(); vi.mocked(createAvatar).mockClear() })
it.each(['uri-first', 'color-first'])('shares one real generation and cache entry when requested %s', async order => {
  const { dicebearAvatarDataUri, dicebearAvatarMainColor } = await import('../../../../apps/desktop/src/lib/dicebearAvatar')
  const id = `human-ui4-cache-${order}`
  if (order === 'uri-first') dicebearAvatarDataUri(id)
  else dicebearAvatarMainColor(id)
  const uri = dicebearAvatarDataUri(id), color = dicebearAvatarMainColor(id)
  expect(createAvatar).toHaveBeenCalledTimes(1)
  const actual = vi.mocked(createAvatar).mock.results[0].value.toJson()
  expect(color).toBe(actual.extra.primaryBackgroundColor)
  expect(decodeURIComponent(uri)).toContain(color)
  expect(dicebearAvatarDataUri(` ${id} `)).toBe(uri)
  expect(dicebearAvatarMainColor(` ${id} `)).toBe(color)
  expect(createAvatar).toHaveBeenCalledTimes(1)
})
