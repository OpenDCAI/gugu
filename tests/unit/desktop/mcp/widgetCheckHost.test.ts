import { beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerSessionpageTools } from '../../../../apps/desktop/electron/mcp/sessionpage-tool-registrar'

const scope = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs', () => ({
  widgetCheckScopeOf: scope, extensionCheckScopeOf: vi.fn(), extensionAttachmentOf: vi.fn(), groupDataFileOf: vi.fn(), sendExtensionCardOf: vi.fn(),
}))
const { runAppAction } = await import('../../../../apps/desktop/electron/mcp/app-tool-host')
const { EXTENSION_TOOL_DEFS } = await import('../../../../apps/desktop/electron/mcp/gugu-extension-tool')
const context = { kind: 'social', agentId: 'agent-1' } as Parameters<typeof runAppAction>[1]
const widget = { id: 'm1', messageId: 'm1', senderId: 'sender', text: 'Dinner', data: { poll: 'p1' } }
beforeEach(() => { scope.mockReset().mockResolvedValue({ tabKind: 'vote.poll', chatId: 'chat-1', widget }) })

describe('app_check resolves widgets before native dispatch', () => {
  it('accepts a typed message_id through the real registrar without decoding it twice', async () => {
    const server = new McpServer({ name: 'widget-check', version: '1' })
    const register = vi.spyOn(server, 'registerTool')
    const run = vi.fn(async () => ({ loaded: true }))
    const def = EXTENSION_TOOL_DEFS.find(tool => tool.name === 'app_check')!
    registerSessionpageTools(server, [def], action => runAppAction(action, context, run, undefined), name => name, work => work)
    const callback = register.mock.calls[0]![2] as (args: unknown, extra: { signal: AbortSignal }) => Promise<{ isError?: boolean }>
    const result = await callback({ message_id: 'msg:m1' }, { signal: new AbortController().signal })
    expect(result.isError).not.toBe(true)
    expect(scope).toHaveBeenCalledWith(context, 'm1')
    expect(run).toHaveBeenCalledWith({ action: 'check', tab_kind: 'vote.poll', chat_id: 'chat-1', widget })
  })
  it.each(['message_id', 'widget_id'])('infers the view for %s', async target => {
    const run = vi.fn(async (action: unknown) => action)
    await runAppAction({ action: 'check', [target]: target === 'message_id' ? 'm1' : 'msg:m1', look: false }, context, run, undefined)
    expect(scope).toHaveBeenCalledWith(context, 'm1')
    expect(run).toHaveBeenCalledWith({ action: 'check', tab_kind: 'vote.poll', chat_id: 'chat-1', widget, look: false })
  })
  it('does not dispatch after denial or view mismatch', async () => {
    const run = vi.fn()
    scope.mockRejectedValueOnce(new Error('unreadable'))
    await expect(runAppAction({ action: 'check', message_id: 'msg:m1' }, context, run, undefined)).rejects.toThrow('unreadable')
    await expect(runAppAction({ action: 'check', message_id: 'msg:m1', tab_kind: 'other.main' }, context, run, undefined)).rejects.toThrow('this widget uses vote.poll')
    expect(run).not.toHaveBeenCalled()
  })
  it('rejects mixed targets at tool and direct-host boundaries', async () => {
    const schema = EXTENSION_TOOL_DEFS.find(tool => tool.name === 'app_check')!.schema
    for (const conflict of [{ widget_id: 'msg:m2' }, { chat_id: 'chat-1' }, { item_id: 'item-1' }, { file_path: 'poll.json' }]) {
      const args = { message_id: 'msg:m1', ...conflict }
      expect(schema.safeParse(args).success).toBe(false)
      await expect(runAppAction({ action: 'check', ...args }, context, vi.fn(), undefined)).rejects.toThrow('app_check:')
    }
    expect(schema.safeParse({ message_id: 'msg:m1', phone: true }).success).toBe(true)
    expect(schema.safeParse({ tab_kind: 'vote.poll', page: 'p1', steps: [{ click: { role: 'button', name: 'Vote' } }] }).success).toBe(true)
    expect(schema.safeParse({ widget: { messageId: 'm1' } }).success).toBe(false)
    expect(scope).not.toHaveBeenCalled()
  })
})
