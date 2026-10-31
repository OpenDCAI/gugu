// #7199 个人助理住在这台电脑上(owner 10-16「未充会员的用户……在本地创建」):它的家在本机准备。
// 云上那一份由管家在那台机器上写(gugu-supabase services/cloud-computer),这里照同一份说明(@gugu/core/shared/assistantPolicy)写本机这份,
// 只是位置不同:人自己的 ~/.claude 是他自己的 Claude Code 每个会话都读的,❌ 往里写 —— 一切都在它的工作目录里(项目级说明 / 设置 / 记忆),
// Claude Code 认的那一夹记忆目录链到那里。不依赖 electron,可单测。
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveGuguHome } from '@gugu/core/local/state/paths'
import {
  ASSISTANT_COMPUTER_WORKDIR_NAME,
  OWNER_PROFILE_MEMORY_FILE,
  assistantHomePaths,
  ownerProfileMemoryFile,
  withOwnerProfileIndex,
} from '@gugu/core/shared/assistantPolicy'
import type { PrepareLocalHomeInput, PrepareLocalHomeResult, WipeLocalHomeResult } from '../src/lib/assistantHomeIpc'
import { createLogger } from './lib/logger'
import { refreshAssistantContext } from './sessionpage/assistant-instructions'

const log = createLogger('assistant-home')

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** 先写临时文件再换上去:写到一半崩了也不留半截说明 / 半截设置。 */
async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, path)
}

/**
 * Claude Code 认的那一夹(`~/.claude/projects/<目录名>/memory`)链到它家里的 `.claude/memory`。
 * 那里已经是一个真目录(链之前 Claude Code 先跑过)= 把里面的搬进来再换成链接,❌ 丢它记下的东西。
 * Windows 用 junction(目录链接不要管理员)。
 */
async function linkClaudeMemory(claudeMemoryDir: string, memoryDir: string): Promise<void> {
  const stat = await lstat(claudeMemoryDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isSymbolicLink()) {
    if (resolve(dirname(claudeMemoryDir), await readlink(claudeMemoryDir)) === resolve(memoryDir)) return
    await rm(claudeMemoryDir)
  } else if (stat?.isDirectory()) {
    for (const name of await readdir(claudeMemoryDir)) {
      const target = join(memoryDir, name)
      if (await lstat(target).then(() => true, () => false)) continue
      await rename(join(claudeMemoryDir, name), target)
    }
    await rm(claudeMemoryDir, { recursive: true })
  } else if (stat) {
    throw new Error(`${claudeMemoryDir} exists and is not a directory`)
  }
  await mkdir(dirname(claudeMemoryDir), { recursive: true })
  await symlink(memoryDir, claudeMemoryDir, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * 清掉它在这台电脑上的家(#7350 关闭咕咕;新开通一位前也先清)。工作目录整个删掉;Claude Code 认的那一夹
 * (`~/.claude/projects/<目录名>/memory`)只在它是链到这个家的链接时拆掉 —— 是真目录或链到别处 = 不是我们建的,❌ 碰;
 * 那一夹的上一级(Claude Code 自己的会话记录)不动。没有家 = 没东西可清,照常返回。
 */
export async function wipeLocalAssistantHome(env: { guguHome?: string; home?: string } = {}): Promise<WipeLocalHomeResult> {
  const home = env.home ?? homedir()
  const workdir = join(env.guguHome ?? resolveGuguHome(), ASSISTANT_COMPUTER_WORKDIR_NAME)
  const paths = assistantHomePaths(home, workdir, 'computer')
  const link = await lstat(paths.claudeMemoryDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (link?.isSymbolicLink() && resolve(dirname(paths.claudeMemoryDir), await readlink(paths.claudeMemoryDir)) === resolve(paths.memoryDir)) {
    await rm(paths.claudeMemoryDir)
  }
  const existed = await lstat(workdir).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
  await rm(workdir, { recursive: true, force: true })
  log.info({ workdir, existed }, 'local assistant home wiped')
  return { workdir, existed }
}

export async function prepareLocalAssistantHome(
  input: PrepareLocalHomeInput,
  env: { guguHome?: string; home?: string } = {},
): Promise<PrepareLocalHomeResult> {
  const home = env.home ?? homedir()
  const workdir = join(env.guguHome ?? resolveGuguHome(), ASSISTANT_COMPUTER_WORKDIR_NAME)
  const paths = assistantHomePaths(home, workdir, 'computer')
  // 只问不写:搬家的预览与读旧家都走这里,人还没点确认之前不往它家里写任何东西。
  if (input.dryRun) return { workdir, home }
  if (input.fresh) await wipeLocalAssistantHome(env)
  await mkdir(workdir, { recursive: true })
  await mkdir(paths.resourcesDir, { recursive: true })
  await mkdir(paths.memoryDir, { recursive: true })
  await linkClaudeMemory(paths.claudeMemoryDir, paths.memoryDir)
  await refreshAssistantContext(workdir, env.guguHome ?? resolveGuguHome(), 'computer', home)
  const profile = input.ownerProfile?.trim()
  if (profile) {
    await writeAtomic(join(paths.memoryDir, OWNER_PROFILE_MEMORY_FILE), ownerProfileMemoryFile(profile))
    await writeAtomic(paths.memoryIndex, withOwnerProfileIndex(await readOrNull(paths.memoryIndex)))
  }
  log.info({ workdir, wroteProfile: !!profile }, 'local assistant home prepared')
  return { workdir, home }
}
