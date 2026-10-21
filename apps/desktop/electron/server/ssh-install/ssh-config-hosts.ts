/**
 * 读本机 ~/.ssh/config 里配好的主机别名,给「从本机 SSH 配置里挑」用(behavior「从本机 SSH 配置里已有的主机里挑」)。
 *
 * 跟随 `Include`(相对路径按 ssh_config(5) 的规定相对 ~/.ssh);通配只支持最后一段带 `*` / `?`
 * —— `Include config.d/*` 这类最常见的写法。只为了列名字:真正连的时候一切以 ssh 自己解析为准。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SshConfigHost } from '../../../src/lib/serverSshInstall'
import { includePatterns, parseSshConfigHosts } from './logic'

const MAX_INCLUDE_DEPTH = 8

function expandTilde(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

function globLastSegment(pattern: string): string[] {
  const dir = path.dirname(pattern)
  const base = path.basename(pattern)
  if (!/[*?]/.test(base)) return fs.existsSync(pattern) ? [pattern] : []
  const re = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => re.test(name))
      .sort()
      .map((name) => path.join(dir, name))
      .filter((file) => fs.statSync(file).isFile())
  } catch {
    return []
  }
}

function readWithIncludes(file: string, sshDir: string, depth: number, seen: Set<string>): string {
  const absolute = path.resolve(file)
  if (depth > MAX_INCLUDE_DEPTH || seen.has(absolute)) return ''
  seen.add(absolute)
  let content: string
  try {
    content = fs.readFileSync(absolute, 'utf8')
  } catch {
    return ''
  }
  const out: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const patterns = includePatterns(line)
    if (!patterns) {
      out.push(line)
      continue
    }
    for (const pattern of patterns) {
      const expanded = expandTilde(pattern)
      const resolved = path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded)
      for (const included of globLastSegment(resolved)) {
        out.push(readWithIncludes(included, sshDir, depth + 1, seen))
      }
    }
  }
  return out.join('\n')
}

export function readSshConfigHosts(configPath = path.join(os.homedir(), '.ssh', 'config')): SshConfigHost[] {
  return parseSshConfigHosts(readWithIncludes(configPath, path.dirname(configPath), 0, new Set()))
}
