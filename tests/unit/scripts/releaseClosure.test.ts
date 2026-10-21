import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { PLATFORM_FILES, preflight } from '../../../scripts/release-closure.mjs'

describe('release closure preflight', () => {
  test('requires every versioned and alias object for every shipping platform', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-release-closure-'))
    const release = path.join(root, 'release')
    fs.mkdirSync(release)
    for (const files of Object.values(PLATFORM_FILES)) {
      for (const file of files) fs.writeFileSync(path.join(release, file.replace('{version}', '0.2.99')), 'fixture')
    }
    const statePath = path.join(root, 'state.json')
    const state = await preflight({ directory: release, version: '0.2.99', statePath })
    expect(state.state).toBe('preflight_passed')
    expect(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).manifest)).toEqual(['mac', 'linux', 'windows', 'android'])
  })

  test('fails closed when a versioned Android asset is absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-release-closure-'))
    const release = path.join(root, 'release')
    fs.mkdirSync(release)
    for (const files of Object.values(PLATFORM_FILES)) {
      for (const file of files) {
        const name = file.replace('{version}', '0.2.99')
        if (name === 'gugu-0.2.99-android-release.apk') continue
        fs.writeFileSync(path.join(release, name), 'fixture')
      }
    }
    await expect(preflight({ directory: release, version: '0.2.99', statePath: path.join(root, 'state.json') })).rejects.toThrow('android/gugu-0.2.99-android-release.apk')
  })
})
