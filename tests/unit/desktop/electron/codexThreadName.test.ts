import { describe, expect, it } from 'vitest'
import { codexThreadName } from '../../../../apps/desktop/electron/sessionpage/codex-app-server-delivery'

// codex 0.150+ 的 TUI 自己给 thread 起名,app-server 把 `thread/name/updated {threadId, threadName}`
// 广播给每条连接(codex-rs app-server-protocol v2 `ThreadNameUpdatedNotification`)。
describe('codexThreadName', () => {
  const named = (threadId: string, threadName: unknown) => ({
    method: 'thread/name/updated',
    params: { threadId, threadName },
  })

  it('reads the name codex gave this thread', () => {
    expect(codexThreadName(named('t1', '  Fix login redirect '), 't1')).toBe('Fix login redirect')
  })

  it('ignores other threads (the ephemeral title thread, subagents) and other notifications', () => {
    expect(codexThreadName(named('t2', 'Other thread'), 't1')).toBeNull()
    expect(codexThreadName({ method: 'thread/started', params: { threadId: 't1', threadName: 'x' } }, 't1')).toBeNull()
  })

  it('a cleared or malformed name is not a name', () => {
    expect(codexThreadName(named('t1', ''), 't1')).toBeNull()
    expect(codexThreadName(named('t1', null), 't1')).toBeNull()
    expect(codexThreadName({ method: 'thread/name/updated' }, 't1')).toBeNull()
  })
})
