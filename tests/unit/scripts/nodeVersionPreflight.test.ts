import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { assertNodeVersion } from '../../../scripts/build/node-version-preflight.mts'

describe('node version preflight', () => {
  it('accepts the exact repository pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-node-pin-'))
    try {
      writeFileSync(join(root, '.node-version'), '24.14.0\n')
      expect(assertNodeVersion({ rootDir: root, currentVersion: 'v24.14.0' })).toEqual({
        current: '24.14.0',
        pin: '24.14.0',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails loudly when the pin differs from the current Node', () => {
    const root = mkdtempSync(join(tmpdir(), 'gugu-node-pin-'))
    try {
      writeFileSync(join(root, '.node-version'), '25.9.0\n')
      expect(() => assertNodeVersion({ rootDir: root, currentVersion: 'v24.14.0' })).toThrow(
        /current version=v24\.14\.0[\s\S]*repository pin=25\.9\.0[\s\S]*fix PATH/,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
