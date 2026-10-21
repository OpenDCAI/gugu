import { describe, expect, it } from 'vitest'
import {
  GUGU_PLATFORM_BLOCK,
  GUGU_PLATFORM_PROMPT_TOKEN_BUDGET,
  estimatePromptTokens,
} from '../../../../apps/desktop/electron/product-platform-prompt'
import { guguSessionSurfaceBlock } from '../../../../apps/desktop/electron/capability-bundle'
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
    expect(GUGU_PLATFORM_BLOCK).toContain('call the tool exactly as your tool list names it')
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
