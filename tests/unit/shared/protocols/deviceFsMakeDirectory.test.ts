import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listDeviceDirectory, makeDeviceDirectory } from '@gugu/core/cloud/deviceFs'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gugu-devicefs-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('fs.make-directory(远端选文件夹时「新建文件夹」)', () => {
  it('在父目录里建一层,~ 按那台机器的主目录展开', async () => {
    const response = await makeDeviceDirectory({ path: '~/app' }, { homedir: () => home })
    expect(response).toEqual({ result: { path: join(home, 'app') } })
    expect(statSync(join(home, 'app')).isDirectory()).toBe(true)
  })

  it('同名已存在报 already_exists,❌ 不当成功', async () => {
    writeFileSync(join(home, 'taken'), 'x')
    const response = await makeDeviceDirectory({ path: join(home, 'taken') }, { homedir: () => home })
    expect(response.error?.code).toBe('already_exists')
  })

  it('父目录不存在报 not_found(只建一层)', async () => {
    const response = await makeDeviceDirectory({ path: join(home, 'a', 'b') }, { homedir: () => home })
    expect(response.error?.code).toBe('not_found')
  })

  it('列目录时带上主目录,选择器据此判「选的是不是主目录本身」', async () => {
    const response = await listDeviceDirectory({ path: '~' }, { homedir: () => home })
    expect(response.result?.home).toBe(home)
  })
})
