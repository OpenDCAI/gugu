import { describe, expect, it } from 'vitest'
import {
  GUGU_PLATFORM_BLOCK,
  GUGU_PLATFORM_PROMPT_TOKEN_BUDGET,
  estimatePromptTokens,
  GUGU_ACKNOWLEDGEMENT, personalAssistantPlatformPrompt,
} from '../../../../apps/desktop/electron/product-platform-prompt'
import { GUGU_APPS_SEARCH_LINE, guguSessionSurfaceBlock } from '../../../../apps/desktop/electron/capability-bundle'
import { z } from 'zod'
import { listRowsSchema, agentStatusFilterSchema } from '../../../../apps/desktop/electron/mcp/list-window.mjs'
import { EXTENSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-extension-tool'
import { assistantBrief } from '../../../../packages/core/src/shared/assistantPolicy'
import { SESSION_TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-session-tool'
// @ts-expect-error -- the MCP tool implementation is an untyped ESM module.
import { TOOL_DEFS } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

describe('GUGU platform prompt budget', () => {
  it('keeps the static platform contract within its paid token budget', () => {
    expect(estimatePromptTokens(GUGU_PLATFORM_BLOCK)).toBeLessThanOrEqual(GUGU_PLATFORM_PROMPT_TOKEN_BUDGET)
  })
})

// #6192(原在 capabilityBundle.test.ts,被 #6177 删掉):平台块是常量,❌ 不带按家的工具名清单 ——
// 那张清单漏掉哪家,哪家的模型就按裸名去找;按家的形态只在会话自述块里(taskTuiCapabilityLaunchContract 守)。
describe('platform block carries no per-harness tool naming (#6192)', () => {
  it('keeps harness tool-name decoration out of the constant platform block', () => {
    expect(GUGU_PLATFORM_BLOCK).not.toMatch(/mcp__|gugu_<tool>|Pi `|Claude `|Codex `/)
    expect(GUGU_PLATFORM_BLOCK).not.toContain('canonical suffix')
    expect(guguSessionSurfaceBlock('acp', 'claude', true)).toContain("follow that tool definition's invocation form")
    const fallback = 'Call the tool exactly as your tool list names it, not by the bare suffix.'
    expect(GUGU_PLATFORM_BLOCK).not.toContain(fallback)
    for (const provider of ['amp', 'antigravity']) {
      expect(guguSessionSurfaceBlock('acp', provider, true).split(fallback)).toHaveLength(2)
      expect(guguSessionSurfaceBlock('acp', provider, false)).not.toContain(fallback)
    }
  })
})

/**
 * #6634 问题 15 One owner per sentence across everything a session-page agent reads every turn: the platform block, its session
 * surface block and the tool descriptions. A tool's own usage lives in its description; the prompt keeps only which tool to
 * reach for. Each phrase below was said twice before (W-21 metric 1, eight candidates); now exactly one place says it.
 */
describe('a routing or usage sentence has one owner (#6634 问题 15)', () => {
  const descriptions = [...(TOOL_DEFS as { description: string }[]), ...SESSION_TOOL_DEFS].map((def) => def.description)
  const everything = [GUGU_PLATFORM_BLOCK, guguSessionSurfaceBlock('acp', 'claude', true), ...descriptions].join('\n')
  const count = (phrase: string) => everything.split(phrase).length - 1

  it.each([
    // message_rules: the send gate and the backlog hint are the tool's; the prompt says the rules bind you and arrive in deliveries.
    ['counts as read', 'message_rules description'],
    ['advisory and never blocks', 'message_rules description'],
    // contact_friend / message_invite: who accepts and what pending means are theirs.
    ['must accept before joining', 'contact_friend description'],
    ['Humans accept for themselves', 'message_invite description'],
    // session_spawn vs a harness worker: which one to reach for is the surface's routing sentence.
    ['not a session agent', 'surface routing'],
    // session_open_in_tab: when to call it is the surface's; its parameters are the tool's.
    ['instead of only reporting its path', 'surface routing'],
    // A typed turn is answered in printed output: said once, in <gugu_transport>.
    ['answered in your own printed output', '<gugu_transport>'],
  ])('%s — only in the %s', (phrase) => {
    expect(count(phrase)).toBe(1)
  })

  it('the prompt no longer restates what the tools say', () => {
    for (const gone of [
      'Sending tools refuse', 'also waits for the human friend', 'people accept for themselves', 'what you print IS the answer',
      'intent=preview', 'A harness Task, Agent', 'GUI-visible Gugu conversation',
    ]) {
      expect(everything).not.toContain(gone)
    }
  })
})

describe('tool usage belongs to schemas and assistant duplicates keep one owner', () => {
  it('retains product-specific delegation triggers and the catalog search boundary', () => {
    const surface = guguSessionSurfaceBlock('acp', 'claude', true)
    expect(surface).toContain('「起一个 agent」「创建一个小弟」')
    expect(surface).toContain('Never substitute one for a requested Gugu session')
    expect(GUGU_PLATFORM_BLOCK).toContain("these tools are invisible to your harness's tool search")
  })

  it('keeps the shared list contract once in the platform instead of repeating it in fields', () => {
    expect(GUGU_PLATFORM_BLOCK).toContain('`rows` is 1-based ("20" / "41-60"), default 20, all for catalogs')
    expect(GUGU_PLATFORM_BLOCK).toContain('pass `next` as `rows`')
    expect(GUGU_PLATFORM_BLOCK).toContain('`name` matches a substring, `pinned` a boolean, `status` a status/detail')
    expect(GUGU_PLATFORM_BLOCK).toContain('`total` is after filtering')
    expect(GUGU_PLATFORM_BLOCK).toContain('not a current observation')
    expect(listRowsSchema.description).toBeUndefined()
    expect(agentStatusFilterSchema.description).toBeUndefined()
  })

  it('keeps App mutation rules in app_install and leaves its game example intact', () => {
    const install = EXTENSION_TOOL_DEFS.find(tool => tool.name === 'app_install')!
    expect(install.description).toContain('never edit installed files')
    expect(install.description).toContain('Switching an App on belongs to the person')
    expect(GUGU_APPS_SEARCH_LINE).not.toContain('Never edit')
    expect(GUGU_APPS_SEARCH_LINE).toContain('To install an App or change its version, use app_install.')
    expect(GUGU_APPS_SEARCH_LINE).toContain('来一局狼人杀')
  })

  it('keeps all group guidance and general style when suppressing only the assistant acknowledgement duplicate', () => {
    const assistant = personalAssistantPlatformPrompt(GUGU_PLATFORM_BLOCK)
    for (const tag of ['gugu_transport', 'gugu_silence', 'gugu_collaboration', 'gugu_examples']) {
      const section = GUGU_PLATFORM_BLOCK.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`))![0]
      expect(assistant).toContain(section)
    }
    expect(assistant).toContain('Short. Lead with the answer')
    expect(assistant).toContain('In mathematical prose')
    expect(assistant).not.toContain(GUGU_ACKNOWLEDGEMENT)
    expect(GUGU_PLATFORM_BLOCK).toContain(GUGU_ACKNOWLEDGEMENT)
    const brief = assistantBrief('cloud', '/reference', '/memory')
    expect(brief).toContain('多步工作先用 message_send 短句承接')
    expect(brief).toContain('中文。')
    expect(brief).not.toContain('简洁，先说结果')
    expect(brief).not.toContain('schedule_create')
    expect(brief).toContain('session_spawn，默认挂在你名下')
    expect(brief).not.toContain('session_spawn(nest:')
    for (const name of ['session_spawn', 'session_message']) {
      const schema = SESSION_TOOL_DEFS.find(tool => tool.name === name)!.schema
      const json = z.toJSONSchema(schema, { io: 'input' })
      expect((json.properties!.source_link as { description: string }).description).toContain('Copy delivery source_link')
    }
  })
})
