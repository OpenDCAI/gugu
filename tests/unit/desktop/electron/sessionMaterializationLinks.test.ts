import { lstat, mkdir, mkdtemp, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySessionMaterialization } from '../../../../apps/desktop/electron/session-materialization'

describe('会话扩展 skill 链接', () => {
  it('为目录创建可解析的链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-session-links-'))
    try {
      const source = join(root, 'extension-skill')
      const guguHome = join(root, 'gugu-home')
      const target = join(guguHome, 'skills', 'extension-skill')
      await mkdir(source, { recursive: true })

      await applySessionMaterialization({
        cwd: join(root, 'workspace'),
        guguHome,
        materialization: {
          symlinks: [{ sourcePath: source, path: target, optionalSource: false }],
        },
      })

      expect((await lstat(target)).isSymbolicLink()).toBe(true)
      expect(resolve(dirname(target), await readlink(target))).toBe(source)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
