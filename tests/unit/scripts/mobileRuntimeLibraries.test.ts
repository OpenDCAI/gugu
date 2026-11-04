import { describe, expect, it } from 'vitest'
import { mobileRuntimeClosure } from '../../../scripts/build/mobile-runtime-libraries.mts'
import { filterIcuLocaleIndex, retainIcuDependencies } from '../../../scripts/build/mobile-runtime-icu.mts'

describe('Android packaged native dependency closure', () => {
  const libraries = () => new Map([
    ['sqlite-current.so', { soname: null, needed: ['libc.so', 'libz.so.1'] }],
    ['sqlite-unused.so', { soname: null, needed: ['libc.so'] }],
    ['libz.so.1.2', { soname: 'libz.so.1', needed: ['libc.so'] }],
    ['libicutest.so.78.3', { soname: 'libicutest.so.78', needed: [] }],
  ])
  const aliases = [{ name: 'libsqlite3.so', target: 'sqlite-current.so' }, { name: 'libz.so.1', target: 'libz.so.1.2' }]

  it('retains the actual alias target and transitive dependencies, not other SQLite/ICU files', () => {
    const result = mobileRuntimeClosure({ needed: ['libsqlite3.so', 'libm.so'] }, libraries(), aliases)
    expect(result.files).toEqual(['libz.so.1.2', 'sqlite-current.so'])
    expect(result.aliases).toEqual(aliases)
    expect(result.edges).toEqual([
      { requested: 'libsqlite3.so', file: 'sqlite-current.so', soname: null },
      { requested: 'libz.so.1', file: 'libz.so.1.2', soname: 'libz.so.1' },
    ])
  })
  it('refuses missing, cyclic and escaping loader paths', () => {
    expect(() => mobileRuntimeClosure({ needed: ['missing.so'] }, libraries(), aliases)).toThrow('Unresolved')
    expect(() => mobileRuntimeClosure({ needed: ['a.so'] }, libraries(), [{ name: 'a.so', target: 'a.so' }])).toThrow('cycle')
    expect(() => mobileRuntimeClosure({ needed: ['a.so'] }, libraries(), [{ name: 'a.so', target: '../elsewhere.so' }])).toThrow('escapes')
  })
  it('refuses an alias that changes the dependency SONAME', () => {
    expect(() => mobileRuntimeClosure({ needed: ['wrong.so'] }, libraries(), [...aliases, { name: 'wrong.so', target: 'libz.so.1.2' }])).toThrow('resolved SONAME')
  })
})

describe('filtered ICU locale inventory', () => {
  it('preserves index metadata and advertises only the retained language families', () => {
    const source = 'res_index:table(nofallback) { CLDRVersion { "49" } InstalledLocales { en { "" } en_001 { "" } ja { "" } zh_Hant_TW { "" } de { "" } } }'
    const result = filterIcuLocaleIndex(source, ['en', 'zh', 'ja'])
    expect(result.locales).toEqual(['en', 'en_001', 'ja', 'zh_Hant_TW'])
    expect(result.source).toContain('CLDRVersion { "49" }')
    expect(result.source).not.toContain('de {')
    expect(result.source).toContain('res_index:table(nofallback)')
  })
  it('restores the standalone index attribute omitted by actual derb output', () => {
    const source = '// derb dump\nres_index{ CLDRVersion { "49" } InstalledLocales { en { "" } de { "" } } }'
    const result = filterIcuLocaleIndex(source, ['en'])
    expect(result.source).toContain('res_index:table(nofallback) { CLDRVersion { "49" }')
    expect(result.locales).toEqual(['en'])
    expect(() => filterIcuLocaleIndex(source.replace('res_index{', 'other{'), ['en'])).toThrow('index header')
  })
  it('retains ICU alias targets transitively instead of deleting a requested Chinese locale', () => {
    const removed = new Set(['rbnf/yue.res', 'rbnf/yue_Hant.res', 'de.res'])
    expect(retainIcuDependencies('Item rbnf/zh_Hant_HK.res depends on missing item rbnf/yue.res\n', removed)).toEqual(['rbnf/yue.res'])
    expect(retainIcuDependencies('Item rbnf/yue.res depends on missing item rbnf/yue_Hant.res\n', removed)).toEqual(['rbnf/yue_Hant.res'])
    expect([...removed]).toEqual(['de.res'])
  })
  it('refuses unknown dependency diagnostics or a target absent from the removal set', () => {
    expect(() => retainIcuDependencies('cannot open data file', new Set(['de.res']))).toThrow('diagnostic')
    expect(() => retainIcuDependencies('Item res_index.res depends on missing item res.res', new Set(['de.res']))).toThrow('diagnostic')
  })
  it('refuses a changed or malformed binary-tool text contract', () => {
    expect(() => filterIcuLocaleIndex('res_index { }', ['en'])).toThrow('no InstalledLocales')
    expect(() => filterIcuLocaleIndex('InstalledLocales { en { "unexpected data" } }', ['en'])).toThrow('Unexpected')
    expect(() => filterIcuLocaleIndex('InstalledLocales { en { "" }', ['en'])).toThrow('Unterminated')
  })
})
