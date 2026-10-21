import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createEnvRegistryRuntime } from './env-registry.cjs'

const { announceActiveDb, applyActiveDbEnv, assertNoLegacyEnvLocal } = createEnvRegistryRuntime({
  existsSync,
  readFileSync,
  join: path.join,
})

// @@@env-registry (#2782) - 这是 node 侧唯一的 env bootstrap（e2e account 工厂、集成测试、
// admin:create-account、seed:yatu-accounts、chpay 探针…都走它）。库凭据搬进 .envs/<target>.env
// 之后，激活点必须在这里，否则搬迁完这些消费者全部失去凭据。
// 函数名与签名不变，8 个调用点无需改动。
export function loadDotEnvLocal(rootDir = process.cwd()): void {
  assertNoLegacyEnvLocal(rootDir)

  // 显式声明的那一套整体覆盖 —— shell 里的残留 export 正是连错库的老源头，
  // 点名要哪套时它就该输给点名的那套。没声明 target 时这一步是空操作。
  applyActiveDbEnv(rootDir, process.env as Record<string, string>)

  const envPath = path.join(rootDir, '.env.local')
  if (existsSync(envPath)) {
    for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const rawValue = line.slice(eq + 1).trim()
      if (!key || process.env[key] !== undefined) continue
      process.env[key] = unquoteEnvValue(rawValue)
    }
  }

  // @@@db-announce 播报放在最后：未声明 target 时库地址正是上面这一段才写进 env 的，
  // 提前播就只能播出「无库地址」。缺 .env.local 也要播 —— 那种情况更该说话。
  announceActiveDb(rootDir, process.env as Record<string, string>)
}

// Unquoted values may carry a trailing `  # comment` (seen in real onboarding-kit env files) or be a
// comment on an otherwise-empty value (`KEY= # note`) — only strip when the value isn't quoted; a value
// that must start with a literal `#` (e.g. a hex color) should be quoted instead. A quoted value's closing
// quote isn't necessarily the last character of the raw slice — a trailing ` # comment` can follow it — so
// find the matching quote rather than requiring the whole trimmed value to end in one.
function unquoteEnvValue(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0]
    const closeIndex = value.indexOf(quote, 1)
    if (closeIndex !== -1) return value.slice(1, closeIndex)
  }
  if (value.startsWith('#')) return ''
  const commentIndex = value.search(/\s#/)
  return commentIndex === -1 ? value : value.slice(0, commentIndex).trimEnd()
}
