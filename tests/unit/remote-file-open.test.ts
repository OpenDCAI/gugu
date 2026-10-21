import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBytesInSystemApp, sanitizeRemoteFileName } from '../../apps/desktop/electron/remoteFileOpen'

const roots: string[] = []

async function testRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gugu-remote-open-test-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const bytes = (text: string) => new TextEncoder().encode(text)

// 字节由渲染层给(lib/attachmentBytes 从 Cache Storage / 签名链接取到的那一份),主进程只落盘、交给系统应用。
describe('system-app handoff of attachment bytes', () => {
  it('writes once per content and reuses that file for repeated and concurrent opens', async () => {
    const tempRoot = await testRoot()
    const opened: string[] = []
    const deps = { tempRoot, openPath: async (path: string) => { opened.push(path); return '' } }
    const [a, b] = await Promise.all([
      openBytesInSystemApp({ bytes: bytes('<p>hi</p>'), filename: 'page.html' }, deps),
      openBytesInSystemApp({ bytes: bytes('<p>hi</p>'), filename: 'page.html' }, deps),
    ])
    const again = await openBytesInSystemApp({ bytes: bytes('<p>hi</p>'), filename: 'page.html' }, deps)
    expect(new Set([a.path, b.path, again.path]).size).toBe(1)
    expect(await readFile(a.path, 'utf8')).toBe('<p>hi</p>')
    expect(opened).toHaveLength(3)
    // 没有写了一半的临时文件留下。
    expect(await readdir(a.directory)).toEqual(['page.html'])
  })

  it('keeps different contents apart, even under the same name', async () => {
    const tempRoot = await testRoot()
    const deps = { tempRoot, openPath: async () => '' }
    const one = await openBytesInSystemApp({ bytes: bytes('v1'), filename: 'report.pdf' }, deps)
    const two = await openBytesInSystemApp({ bytes: bytes('v2'), filename: 'report.pdf' }, deps)
    expect(one.directory).not.toBe(two.directory)
    expect(await readFile(one.path, 'utf8')).toBe('v1')
    expect(await readFile(two.path, 'utf8')).toBe('v2')
  })

  it('refuses bytes over the limit without writing anything', async () => {
    const tempRoot = await testRoot()
    await expect(openBytesInSystemApp({ bytes: bytes('too big'), filename: 'a.bin' }, { tempRoot, openPath: async () => '', maxBytes: 3 })).rejects.toThrow('byte limit')
    expect(await readdir(tempRoot)).toEqual([])
  })

  it('reports a system open failure loudly and keeps the bytes for the next open', async () => {
    const tempRoot = await testRoot()
    let refuse = true
    const deps = { tempRoot, openPath: async () => (refuse ? 'no application' : '') }
    await expect(openBytesInSystemApp({ bytes: bytes('x'), filename: 'a.rtf' }, deps)).rejects.toThrow('Could not open file: no application')
    refuse = false
    const opened = await openBytesInSystemApp({ bytes: bytes('x'), filename: 'a.rtf' }, deps)
    expect(await readFile(opened.path, 'utf8')).toBe('x')
  })

  it('sanitizes host path syntax while preserving a useful extension', () => {
    expect(sanitizeRemoteFileName('../../Quarter:Plan?.pptx')).toBe('Quarter_Plan_.pptx')
    expect(sanitizeRemoteFileName('..')).toBe('attachment')
  })

  it.each(['.html', '.HTM', '.pptx'])('preserves %s when shortening a long attachment name', (extension) => {
    const name = sanitizeRemoteFileName(`${'a'.repeat(201)}${extension}`)
    expect(name).toHaveLength(200)
    expect(name.endsWith(extension)).toBe(true)
  })

})
