// #6492 闸:agent 的 IM MCP server 不许用主人令牌直读直写 workspace_items,也不碰 workspace 桶(群文件夹的文件归群文件夹
// App 的工具),其余直读直写只拦新增。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DIRECT_REST_ALLOWLIST,
  IM_SERVER_PATH,
  findImServerDirectAccessViolations,
} from '../../../scripts/check-im-server-direct-access.mjs'

const rules = (source: string) => findImServerDirectAccessViolations(source).map((v) => v.rule)

describe('check-im-server-direct-access', () => {
  it('the real MCP server passes the gate', () => {
    const source = readFileSync(resolve(__dirname, '../../..', IM_SERVER_PATH), 'utf8')
    expect(findImServerDirectAccessViolations(source)).toEqual([])
  })

  // 阴控:每条规则喂一段必然违规的合成源码,证明它会红(❌ 只证明「现在是绿的」)。
  it('flags a workspace_items REST path, in any verb or quoting', () => {
    expect(rules(`await deps.restGet(\`workspace_items?chat_id=eq.\${id}\`)`)).toEqual(['workspace-items-rest', 'rest-not-allowlisted'])
    expect(rules(`await deps.restPatchReturning(\n  'workspace_items?id=eq.1', patch)`)).toEqual(['workspace-items-rest', 'rest-not-allowlisted'])
  })

  // Control (the parent commit): the bucket was allowed inside the @@@workspace-bucket block; the folder's tools are the App's now.
  it('flags any touch of the workspace bucket, by its constant or its name', () => {
    expect(rules("const WORKSPACE_BUCKET = 'workspace'")).toEqual(['workspace-bucket'])
    expect(rules('await deps.storageRemove(WORKSPACE_BUCKET, p)')).toEqual(['workspace-bucket'])
    expect(rules("await deps.storageUpload('workspace', p, bytes)")).toEqual(['workspace-bucket'])
    // The chat's own media bucket is not the folder's.
    expect(rules("await deps.storageUpload('chat-media', p, bytes)")).toEqual([])
  })

  it('lets the allowlisted direct accesses through and stops a new table or a non-literal path', () => {
    const allowed = Object.entries(DIRECT_REST_ALLOWLIST)
      .flatMap(([verb, tables]) => tables.map((table) => `await deps.${verb}(\`${table}?id=eq.1\`)`))
      .join('\n')
    expect(rules(allowed)).toEqual([])
    expect(rules("await deps.restGet('widgets?chat_id=eq.1')")).toEqual(['rest-not-allowlisted'])
    expect(rules("await deps.restInsert('chat_members', row)")).toEqual(['rest-not-allowlisted'])
    expect(rules('await deps.restGet(path)')).toEqual(['rest-non-literal-path'])
  })

  it('the allowlist never admits workspace_items', () => {
    for (const tables of Object.values(DIRECT_REST_ALLOWLIST)) expect(tables).not.toContain('workspace_items')
  })
})
