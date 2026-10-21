import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyMacDmg } from '../../../scripts/verify-pr-dmg.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('required PR macOS DMG gate', () => {
  it('fails when the installer is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-pr-dmg-'))
    roots.push(root)
    mkdirSync(join(root, 'release'))
    expect(() => verifyMacDmg(join(root, 'release'))).toThrow(/packaging stage \(not renderer compilation\).*found 0/)
  })

  it('fails when the installer is zero bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-pr-dmg-'))
    roots.push(root)
    mkdirSync(join(root, 'release'))
    writeFileSync(join(root, 'release', 'gugu-0.0.0-arm64.dmg'), Buffer.alloc(0))
    expect(() => verifyMacDmg(join(root, 'release'))).toThrow(/DMG is empty/)
  })

  it('passes only a regular non-empty arm64 installer', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-pr-dmg-'))
    roots.push(root)
    mkdirSync(join(root, 'release'))
    writeFileSync(join(root, 'release', 'gugu-0.0.0-arm64.dmg'), Buffer.from('dmg'))
    expect(verifyMacDmg(join(root, 'release')).size).toBe(3)
  })
})
