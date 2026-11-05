import { describe, expect, it } from 'vitest'
import { ensureUtf8Locale, isUtf8Locale, planUtf8Locale } from '../../../../apps/desktop/electron/server/server-locale'

// #6264 server 起的一切都跑在 UTF-8 locale 里(照 VS Code terminal.integrated.detectLocale)。
describe('server UTF-8 locale', () => {
  it('recognises UTF-8 spellings', () => {
    expect(isUtf8Locale('C.UTF-8')).toBe(true)
    expect(isUtf8Locale('zh_CN.utf8')).toBe(true)
    expect(isUtf8Locale('de_DE.UTF-8@euro')).toBe(true)
    expect(isUtf8Locale('POSIX')).toBe(false)
    expect(isUtf8Locale('C')).toBe(false)
    expect(isUtf8Locale(undefined)).toBe(false)
  })

  it('leaves an already UTF-8 environment alone and never lists locales', () => {
    let listed = false
    const env: NodeJS.ProcessEnv = { LANG: 'zh_CN.UTF-8' }
    const fix = ensureUtf8Locale(null, env, () => {
      listed = true
      return []
    })
    expect(fix).toEqual({ lang: null, override: [], source: 'already' })
    expect(listed).toBe(false)
    expect(env).toEqual({ LANG: 'zh_CN.UTF-8' })
  })

  it('an unset LANG on a minimal server gets C.UTF-8', () => {
    const env: NodeJS.ProcessEnv = {}
    const fix = ensureUtf8Locale(null, env, () => ['C', 'C.utf8', 'POSIX'])
    expect(fix.lang).toBe('C.UTF-8')
    expect(env.LANG).toBe('C.UTF-8')
  })

  it('prefers what the user exported in the login shell when that locale exists here', () => {
    expect(planUtf8Locale({ env: {}, loginEnv: { LANG: 'zh_CN.UTF-8' }, available: ['C.utf8', 'zh_CN.utf8'] })).toEqual({
      lang: 'zh_CN.UTF-8',
      override: [],
      source: 'login-shell',
    })
    // rc 里写了,但这台机器没生成这个 locale:用了只会得到 setlocale 警告 → 退到 C.UTF-8。
    expect(planUtf8Locale({ env: {}, loginEnv: { LANG: 'zh_CN.UTF-8' }, available: ['C.utf8'] }).lang).toBe('C.UTF-8')
  })

  it('falls back to en_US.UTF-8, then any UTF-8 locale, when C.UTF-8 is missing (old glibc)', () => {
    expect(planUtf8Locale({ env: {}, loginEnv: null, available: ['C', 'en_US.utf8'] }).lang).toBe('en_US.UTF-8')
    expect(planUtf8Locale({ env: {}, loginEnv: null, available: ['C', 'fr_FR.utf8'] }).lang).toBe('fr_FR.utf8')
  })

  it('without a `locale` command (Alpine/musl) still sets C.UTF-8', () => {
    expect(planUtf8Locale({ env: {}, loginEnv: null, available: null }).lang).toBe('C.UTF-8')
  })

  it('rewrites a non-UTF-8 LC_ALL / LC_CTYPE that would override LANG', () => {
    const env: NodeJS.ProcessEnv = { LC_ALL: 'POSIX', LC_CTYPE: 'C', LANG: 'C' }
    const fix = ensureUtf8Locale(null, env, () => ['C.utf8'])
    expect(fix.override).toEqual(['LC_ALL', 'LC_CTYPE'])
    expect(env).toEqual({ LC_ALL: 'C.UTF-8', LC_CTYPE: 'C.UTF-8', LANG: 'C.UTF-8' })
  })
})
