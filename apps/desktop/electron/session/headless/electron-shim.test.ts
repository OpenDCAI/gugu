import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// file-logger 靠 app.setAppLogsPath 是否存在决定要不要落文件;无头替身必须提供它,否则宿主日志静默丢失。
describe('headless electron shim: app logs path', () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(path.join(tmpdir(), 'gugu-headless-'))
    process.env.GUGU_TASK_HOST_USER_DATA = userData
  })
  afterEach(() => {
    delete process.env.GUGU_TASK_HOST_USER_DATA
    rmSync(userData, { recursive: true, force: true })
  })

  it('exposes setAppLogsPath and serves it back through getPath("logs")', async () => {
    const { app } = await import('./electron-shim')
    expect(typeof (app as { setAppLogsPath?: unknown }).setAppLogsPath).toBe('function')
    const target = path.join(userData, 'custom-logs')
    app.setAppLogsPath(target)
    expect(app.getPath('logs')).toBe(target)
    expect(existsSync(target)).toBe(true)
  })

  it('defaults to <userData>/logs when called without an argument', async () => {
    const { app } = await import('./electron-shim')
    app.setAppLogsPath()
    expect(app.getPath('logs')).toBe(path.join(app.getPath('userData'), 'logs'))
  })
})

// No image decoder headless: resizing gives nothing to re-encode (an App's icon falls back), while an image still hands
// its own bytes back (a picture dropped into a server's terminal is saved through toPNG, persist-dropped-blob.ts).
describe('headless electron shim: nativeImage', () => {
  it('resize gives an empty image; the image itself keeps its bytes', async () => {
    const { nativeImage } = await import('./electron-shim')
    const image = nativeImage.createFromBuffer(Buffer.from([1, 2, 3]))
    const resized = image.resize({ width: 32, height: 32, quality: 'best' })
    expect(resized.isEmpty()).toBe(true)
    expect(resized.toPNG().length).toBe(0)
    expect(image.isEmpty()).toBe(false)
    expect(image.toPNG()).toEqual(Buffer.from([1, 2, 3]))
  })
})
