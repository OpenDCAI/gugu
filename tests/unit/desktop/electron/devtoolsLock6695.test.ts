/**
 * #6695 devtools-lock 的锁定判定(resolveDevtoolsLocked)——纯函数契约。
 * 口径(owner 2026-09-28):只有正式版(production tier)装机包锁,任何环境变量都解不开;
 * 非正式版装机包默认不锁,GUGU_DEVTOOLS=0 显式锁上,GUGU_DEBUG_PORT 优先于这个关闭开关;
 * 未打包(开发)一律不锁。四层守卫本身(webPreferences / 菜单 / 吃键 / devtools-opened)是
 * electron 运行时行为,由装机包真机读回验收,不在单测伪造。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {},
  Menu: {},
}))

const { resolveDevtoolsLocked } = await import('../../../../apps/desktop/electron/devtools-lock')

const locked = (isPackaged: boolean, tier: string, env: NodeJS.ProcessEnv = {}) =>
  resolveDevtoolsLocked({ isPackaged, tier, env })

describe('resolveDevtoolsLocked — 未打包', () => {
  it('任何 tier、任何环境变量都不锁', () => {
    expect(locked(false, 'production')).toBe(false)
    expect(locked(false, 'beta')).toBe(false)
    expect(locked(false, 'beta', { GUGU_DEVTOOLS: '0' })).toBe(false)
  })
})

describe('resolveDevtoolsLocked — production 装机包硬锁', () => {
  it('默认锁', () => {
    expect(locked(true, 'production')).toBe(true)
  })

  it('没有任何环境变量能解开', () => {
    expect(locked(true, 'production', { GUGU_DEVTOOLS: '1' })).toBe(true)
    expect(locked(true, 'production', { GUGU_DEBUG_PORT: '9222' })).toBe(true)
    expect(locked(true, 'production', { GUGU_DEVTOOLS: '1', GUGU_DEBUG_PORT: '9222' })).toBe(true)
  })
})

describe('resolveDevtoolsLocked — 非 production 装机包', () => {
  it('beta 与 acceptance-* 默认不锁', () => {
    expect(locked(true, 'beta')).toBe(false)
    expect(locked(true, 'acceptance-6695')).toBe(false)
    expect(locked(true, 'beta', { GUGU_DEVTOOLS: '1' })).toBe(false)
  })

  it('GUGU_DEVTOOLS=0 显式锁上', () => {
    expect(locked(true, 'beta', { GUGU_DEVTOOLS: '0' })).toBe(true)
    expect(locked(true, 'acceptance-6695', { GUGU_DEVTOOLS: '0' })).toBe(true)
  })

  it('GUGU_DEBUG_PORT 不锁,且优先于 GUGU_DEVTOOLS=0', () => {
    expect(locked(true, 'beta', { GUGU_DEBUG_PORT: '9222' })).toBe(false)
    expect(locked(true, 'beta', { GUGU_DEBUG_PORT: '9222', GUGU_DEVTOOLS: '0' })).toBe(false)
  })
})
