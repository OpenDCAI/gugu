import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../../..')
const builderConfig = readFileSync(join(root, 'electron-builder.cjs'), 'utf8')
const i18nConfig = readFileSync(join(root, 'i18next.config.ts'), 'utf8')

// Read literals without executing the build configuration and its environment checks.
function extractStringArray(source: string, key: string): string[] {
  const match = new RegExp(`\\b${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(source)
  if (match === null) return []
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
}

describe('packaged Chromium languages', () => {
  test('explicitly limits the languages included in the package', () => {
    expect(extractStringArray(builderConfig, 'electronLanguages')).not.toHaveLength(0)
  })

  test('matches the supported product UI languages', () => {
    const packaged = extractStringArray(builderConfig, 'electronLanguages')
    const supported = extractStringArray(i18nConfig, 'locales')
    expect(supported).not.toHaveLength(0)
    expect([...packaged].sort()).toEqual([...supported].sort())
  })

  test('distinguishes array literals from missing keys', () => {
    expect(extractStringArray("foo: ['a', 'b'],", 'foo')).toEqual(['a', 'b'])
    expect(extractStringArray("foo: ['a'],", 'bar')).toEqual([])
    expect(extractStringArray('foo: [],', 'foo')).toEqual([])
  })
})
