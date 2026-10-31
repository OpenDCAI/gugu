#!/usr/bin/env node
// #6492 闸:agent 的 IM MCP server(apps/desktop/electron/mcp/gugu-im-server.mjs)拿的是**主人**的 JWT。
// 用它直读直写 chat schema 的表,判权的就是主人的 RLS —— agent 不在的群也读得到(workspace 就这样漏过)。
// 所以:
//   1. workspace_items 一个 REST 路径都不许有 —— 要碰一律走 chat.workspace_*_as(按 agent 自己的成员身份判);
//   2. workspace 私有桶一个字节都不碰 —— 群文件夹的文件是群文件夹 App 的工具读写的(gugu.files,群文件夹工具搬进 App);
//   3. 其余直读直写 REST 的表按「现状白名单」放行、只拦新增 —— 新代码要读写 chat 的东西,先去库里写一条 *_as RPC。
// 纯源码检查,不连库、不起进程。用法:node scripts/check-im-server-direct-access.mjs [file]
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const IM_SERVER_PATH = 'apps/desktop/electron/mcp/gugu-im-server.mjs'

/** 现状白名单(#6492 时点):动词 → 允许的表。❌ 往这里加 workspace_items;加别的表先问「为什么不是 *_as RPC」。 */
export const DIRECT_REST_ALLOWLIST = Object.freeze({
  restGet: ['chats', 'active_members', 'messages', 'users', 'active_friendships', 'contact_overrides'],
  restInsert: ['messages'],
  restPatch: ['users'],
  // group_update 判的就是主人的权限(与人在群设置里改群资料同一个写口,chats_update_owner 判),不是 agent 自己的成员身份。
  restPatchReturning: ['chats'],
})

const REST_CALL = /\bdeps\.(rest(?:Get|Insert|InsertReturning|Patch|PatchReturning|Delete|DeleteReturning))\(\s*([^\s)])/g
const TABLE_HEAD = /^[`'"]([A-Za-z_]+)/

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/** @returns {Array<{ line: number, rule: string, detail: string }>} */
export function findImServerDirectAccessViolations(source) {
  const violations = []
  const push = (index, rule, detail) => violations.push({ line: lineOf(source, index), rule, detail })

  for (const match of source.matchAll(/[`'"]workspace_items\b/g)) {
    push(match.index, 'workspace-items-rest', 'workspace_items must go through chat.workspace_*_as (agent membership), not a REST path')
  }

  for (const match of source.matchAll(/\bWORKSPACE_BUCKET\b|\bstorage\w*\(\s*[`'"]workspace[`'"]/g)) {
    push(match.index, 'workspace-bucket', "the workspace bucket is the folder App's (gugu.files): this server never touches it")
  }

  for (const match of source.matchAll(REST_CALL)) {
    const verb = match[1]
    const rest = source.slice(match.index + match[0].length - 1)
    const table = TABLE_HEAD.exec(rest)?.[1]
    if (!table) {
      push(match.index, 'rest-non-literal-path', `deps.${verb}(...) needs a literal table path so this gate can read it`)
      continue
    }
    const allowed = DIRECT_REST_ALLOWLIST[verb] ?? []
    if (!allowed.includes(table)) {
      push(match.index, 'rest-not-allowlisted', `deps.${verb}('${table}…') is a new direct owner-token access; add a *_as RPC instead`)
    }
  }
  return violations
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const target = resolve(repoRoot, process.argv[2] ?? IM_SERVER_PATH)
  const violations = findImServerDirectAccessViolations(readFileSync(target, 'utf8'))
  for (const v of violations) console.error(`${target}:${v.line} [${v.rule}] ${v.detail}`)
  if (violations.length) process.exit(1)
  console.log(`im-server direct access gate OK — ${target}`)
}
