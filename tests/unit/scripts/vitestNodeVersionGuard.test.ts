import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertVitestNodeVersion } from '../../../scripts/vitest-node-version-guard'

describe('Vitest runner Node pin guard', () => {
  it('accepts an exact pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-vitest-node-pin-'))
    try {
      writeFileSync(join(root, '.node-version'), '24.14.0\n')
      expect(assertVitestNodeVersion('v24.14.0', root)).toEqual({
        current: '24.14.0',
        pin: '24.14.0',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails loudly on a mismatch without switching the process', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-vitest-node-pin-'))
    try {
      writeFileSync(join(root, '.node-version'), '24.14.0\n')
      expect(() => assertVitestNodeVersion('v24.15.0', root)).toThrow(
        /Node version mismatch: current version=v24\.15\.0[\s\S]*repository pin=24\.14\.0[\s\S]*fix PATH/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
