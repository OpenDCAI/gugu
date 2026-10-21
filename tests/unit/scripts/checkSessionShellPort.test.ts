import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error — 守卫脚本是无类型的 .mjs,这里只跑它导出的扫描函数。
import { scanSessionShellPort, SCANNED_ROOTS, SHELL_PORT_MODULE } from '../../../scripts/check-session-shell-port.mjs'

const repoRoot = join(import.meta.dirname, '../../..')
const tempRoots: string[] = []

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'task-shell-port-'))
  tempRoots.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('check-session-shell-port', () => {
  it('passes on the real tree (the port module is the only place channel names live)', () => {
    expect(scanSessionShellPort(repoRoot)).toEqual([])
  })

  it('flags a raw invoke literal and a shell channel literal (mutation control)', () => {
    const root = fixtureRoot({
      [`${SCANNED_ROOTS[0]}/renderer/x.tsx`]: [
        "const a = await api.invoke('sessionpage:agent-card', id)",
        "const CH = 'sessionpage:share-agent'",
        '// api.invoke(\'commented-out\') 注释不算',
        "void rpc.workspace.gitWorktree.clone('https://x')",
      ].join('\n'),
      [`${SCANNED_ROOTS[1]}/Frame.tsx`]: 'bridge.invoke(`sessionpage:fatal-boot`, m)',
      [`${SCANNED_ROOTS[0]}/renderer/x.test.tsx`]: "expect(invoke).toHaveBeenCalledWith('sessionpage:agent-card')",
      [SHELL_PORT_MODULE]: "export const SESSION_SHELL_CHANNELS = { agentCard: 'sessionpage:agent-card' }",
    })
    const found = scanSessionShellPort(root)
    expect(found.map((v: { file: string; line: number; rule: string }) => `${v.file}:${v.line}:${v.rule}`)).toEqual([
      `${SCANNED_ROOTS[0]}/renderer/x.tsx:1:raw-invoke`,
      `${SCANNED_ROOTS[0]}/renderer/x.tsx:2:shell-channel-literal`,
      `${SCANNED_ROOTS[1]}/Frame.tsx:1:raw-invoke`,
    ])
  })

  it('keeps the typed proxy call shape (computed channel) green', () => {
    const root = fixtureRoot({
      [`${SCANNED_ROOTS[0]}/shared/lib/ipc/rpc.ts`]: 'return invoke(parts.join("."), ...args)',
      [`${SCANNED_ROOTS[0]}/renderer/lib/shell-port.ts`]:
        'createSessionShellPort((channel, ...args) => bridge.invoke(channel, ...args))',
    })
    expect(scanSessionShellPort(root)).toEqual([])
  })
})
