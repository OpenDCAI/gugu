import { mkdir, mkdtemp, lstat, readFile, readlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { prepareLocalAssistantHome, wipeLocalAssistantHome } from '../../../../apps/desktop/electron/assistant-home-prepare'
import { assistantGuide, assistantHomePaths } from '../../../../packages/core/src/shared/assistantPolicy'
import { refreshAssistantContext } from '../../../../apps/desktop/electron/sessionpage/assistant-instructions'

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-assistant-home-'))
  const home = join(root, 'home')
  const guguHome = join(root, 'gugu')
  await mkdir(home, { recursive: true })
  return { home, guguHome, paths: (workdir: string) => assistantHomePaths(home, workdir, 'computer') }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

// #7199 非会员装在自己的电脑上:它的一切在它的工作目录里,人自己的 ~/.claude 不被写进说明 / 设置。
describe('prepareLocalAssistantHome', () => {
  it('建工作目录、写说明和设置、写「关于主人」,Claude 认的记忆夹链到工作目录里', async () => {
    const { home, guguHome, paths } = await scratch()
    const result = await prepareLocalAssistantHome({ ownerProfile: '- 称呼：小明' }, { home, guguHome })
    const p = paths(result.workdir)
    expect(result.workdir).toBe(join(guguHome, 'assistant'))
    const brief = await readFile(p.instructions, 'utf8')
    expect(brief).toContain('电脑开着你就在')
    expect(brief.length).toBeLessThan(2400)
    expect(brief).not.toContain('"batches"')
    expect(await readFile(join(result.workdir, '.gugu-assistant-reference.md'), 'utf8')).toBe(assistantGuide('computer'))
    expect(JSON.parse(await readFile(p.settings, 'utf8')).permissions.deny).toContain('CronCreate')
    expect(await readFile(join(p.memoryDir, 'owner-profile.md'), 'utf8')).toContain('- 称呼：小明')
    expect(await readFile(p.memoryIndex, 'utf8')).toContain('(owner-profile.md)')
    expect((await lstat(p.claudeMemoryDir)).isSymbolicLink()).toBe(true)
    expect(await readlink(p.claudeMemoryDir)).toBe(p.memoryDir)
    // 人自己的 ~/.claude 里没有说明、没有设置。
    await expect(lstat(join(home, '.claude', 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(home, '.claude', 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // 搬家的预览与读旧家都只问家在哪:人还没点确认之前,往它家里一个字节都不写(也不建目录)。
  it('dryRun 只告诉家在哪个目录,什么都不建不写', async () => {
    const { home, guguHome } = await scratch()
    const result = await prepareLocalAssistantHome({ dryRun: true, ownerProfile: '- 称呼：小明' }, { home, guguHome })
    expect(result.workdir).toBe(join(guguHome, 'assistant'))
    await expect(lstat(result.workdir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(home, '.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('再来一遍(每次打开 App 刷说明):人在说明里写的性格、记忆都不动', async () => {
    const { home, guguHome, paths } = await scratch()
    const first = await prepareLocalAssistantHome({ ownerProfile: '- 称呼：小明' }, { home, guguHome })
    const p = paths(first.workdir)
    const written = await readFile(p.instructions, 'utf8')
    await writeFile(p.instructions, `${written}\n说话再随和一点。\n`)
    await writeFile(join(p.memoryDir, 'owner-profile.md'), '被主人改过的记忆\n')
    await prepareLocalAssistantHome({}, { home, guguHome })
    expect(await readFile(p.instructions, 'utf8')).toContain('说话再随和一点。')
    expect(await readFile(join(p.memoryDir, 'owner-profile.md'), 'utf8')).toBe('被主人改过的记忆\n')
    const index = await readFile(p.memoryIndex, 'utf8')
    expect(index.match(/owner-profile\.md/g)).toHaveLength(1)
  })

  it('开通刷新与原生启动并发时,设置由同一串行入口合并', async () => {
    const { home, guguHome, paths } = await scratch()
    const first = await prepareLocalAssistantHome({}, { home, guguHome })
    const p = paths(first.workdir)
    await writeFile(p.settings, JSON.stringify({ model: 'keep', permissions: { deny: ['Read(secret)'] }, claudeMdExcludes: ['/custom.md'] }))
    await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2
      ? prepareLocalAssistantHome({}, { home, guguHome })
      : refreshAssistantContext(first.workdir, guguHome, 'computer', home)))
    const settings = JSON.parse(await readFile(p.settings, 'utf8'))
    expect(settings.model).toBe('keep')
    expect(settings.permissions.deny).toEqual(['Read(secret)', 'CronCreate'])
    expect(settings.claudeMdExcludes).toContain('/custom.md')
    expect(settings.claudeMdExcludes).toContain(join(guguHome, '.claude/CLAUDE.md'))
    expect((await readFile(p.instructions, 'utf8')).length).toBeLessThan(2400)
  })

  it('Claude Code 已经在那一夹里记过东西(真目录):搬进工作目录再换成链接,❌ 丢', async () => {
    const { home, guguHome, paths } = await scratch()
    const p = paths(join(guguHome, 'assistant'))
    await mkdir(p.claudeMemoryDir, { recursive: true })
    await writeFile(join(p.claudeMemoryDir, 'earlier.md'), '先前记下的\n')
    await prepareLocalAssistantHome({}, { home, guguHome })
    expect((await lstat(p.claudeMemoryDir)).isSymbolicLink()).toBe(true)
    expect(await readFile(join(p.memoryDir, 'earlier.md'), 'utf8')).toBe('先前记下的\n')
  })

  it('已有的设置读不懂 = 抛,原文不动(❌ 盖掉人写的设置)', async () => {
    const { home, guguHome, paths } = await scratch()
    const p = paths(join(guguHome, 'assistant'))
    await mkdir(join(guguHome, 'assistant', '.claude'), { recursive: true })
    await writeFile(p.settings, '{broken')
    await expect(prepareLocalAssistantHome({}, { home, guguHome })).rejects.toThrow()
    expect(await readFile(p.settings, 'utf8')).toBe('{broken')
  })
})

// #7350 关闭咕咕 / 开通全新的一位:它在这台电脑上的家清干净,但只清我们建的那些。
describe('wipeLocalAssistantHome / prepare fresh', () => {
  async function oldHome() {
    const ctx = await scratch()
    const result = await prepareLocalAssistantHome({ ownerProfile: '- 称呼:旧主人' }, { home: ctx.home, guguHome: ctx.guguHome })
    const p = ctx.paths(result.workdir)
    await writeFile(p.instructions, (await readFile(p.instructions, 'utf8')) + '\n旧性格:每句话以喵结尾\n')
    await writeFile(join(p.memoryDir, 'learned.md'), '旧记忆:主人喜欢周三开会')
    // Claude Code 自己的会话记录住在那一夹的上一级:不是我们的,清家时 ❌ 碰。
    await writeFile(join(p.claudeMemoryDir, '..', 'transcript.jsonl'), '{}')
    return { ...ctx, workdir: result.workdir, p }
  }

  it('整个工作目录删掉,链到它家的那一夹记忆拆掉,Claude Code 的会话记录留着', async () => {
    const { home, guguHome, workdir, p } = await oldHome()
    expect(await wipeLocalAssistantHome({ home, guguHome })).toEqual({ workdir, existed: true })
    await expect(lstat(workdir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(p.claudeMemoryDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(p.claudeMemoryDir, '..', 'transcript.jsonl'), 'utf8')).toBe('{}')
  })

  it('那一夹是真目录(不是我们建的链接)= ❌ 碰', async () => {
    const { home, guguHome, paths } = await scratch()
    const p = paths(join(guguHome, 'assistant'))
    await mkdir(p.claudeMemoryDir, { recursive: true })
    await writeFile(join(p.claudeMemoryDir, 'mine.md'), '人自己的')
    await wipeLocalAssistantHome({ home, guguHome })
    expect(await readFile(join(p.claudeMemoryDir, 'mine.md'), 'utf8')).toBe('人自己的')
  })

  it('本来就没有家:照常返回,existed=false', async () => {
    const { home, guguHome } = await scratch()
    expect(await wipeLocalAssistantHome({ home, guguHome })).toEqual({ workdir: join(guguHome, 'assistant'), existed: false })
  })

  it('开通全新的一位(fresh):上一位的性格和记忆都不在,只有这次开通写的', async () => {
    const { home, guguHome, p } = await oldHome()
    await prepareLocalAssistantHome({ ownerProfile: '- 称呼:新主人', fresh: true }, { home, guguHome })
    expect(await readFile(p.instructions, 'utf8')).not.toContain('旧性格')
    await expect(lstat(join(p.memoryDir, 'learned.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(p.memoryDir, 'owner-profile.md'), 'utf8')).toContain('- 称呼:新主人')
    expect((await lstat(p.claudeMemoryDir)).isSymbolicLink()).toBe(true)
  })

  it('不带 fresh(每次打开 App 的刷新):上一位……也就是它自己的性格和记忆照旧', async () => {
    const { home, guguHome, p } = await oldHome()
    await prepareLocalAssistantHome({}, { home, guguHome })
    expect(await readFile(p.instructions, 'utf8')).toContain('旧性格')
    expect(await readFile(join(p.memoryDir, 'learned.md'), 'utf8')).toContain('旧记忆')
  })
})
