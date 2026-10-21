// guide_* —— 要用时才读的长篇用法。平台提示词只说「有 guide 可查」,正文不进提示词、也不进工具说明:
// 需要它的会话自己来取,不需要的一个字节也不付。

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { EXTENSION_GUIDE_TOPICS } from '../../src/session/shared/extensions/authoring-guide'
import type { ExtensionPicture } from '../../src/session/shared/extensions/extension-check'
import { assertMcpToolDescriptionWithinBudget, TOOL_OUTPUT_BYTE_BUDGET } from './mcp-tool-description-budget.mjs'

/** 每篇指南的字节上限 = 一次工具输出的预算(为什么是 8 000 见 @@@tool-output-budget)。 */
export const GUIDE_TOPIC_BYTE_BUDGET = TOOL_OUTPUT_BYTE_BUDGET

export const GUIDE_TOPICS: readonly { topic: string; about: string; text: string; picture?: 'look' }[] = [...EXTENSION_GUIDE_TOPICS]

const GUIDE_DESCRIPTIONS = {
  // F7 Agents never open the guides unasked (L7, both runs): the one line every agent sees says an App is an option.
  guide_topics: 'The how-to guides guide_read can open, one line each.',
  guide_read: 'Read one how-to guide in full.',
} as const

// apps-ui 那张图:这一版的样子,由 main 在隐藏页里现画(extension-look-picture.ts)。只有能开隐藏页的宿主给得出 ——
// 咕咕 server 上是 null,那篇指南就只有字(它的正文本来就自足)。进程级的一件事实,加载会话页模块时定一次(main.ts)。
let lookPicture: (() => Promise<ExtensionPicture>) | null = null

export function setGuideLookPicture(take: (() => Promise<ExtensionPicture>) | null): void {
  lookPicture = take
}

export function registerGuguGuideTools(server: McpServer): void {
  for (const [name, description] of Object.entries(GUIDE_DESCRIPTIONS)) assertMcpToolDescriptionWithinBudget(name, description)
  server.registerTool(
    'guide_topics',
    { description: GUIDE_DESCRIPTIONS.guide_topics, inputSchema: z.object({}).strict() },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(GUIDE_TOPICS.map(({ topic, about }) => ({ topic, about }))) }],
    }),
  )
  server.registerTool(
    'guide_read',
    {
      description: GUIDE_DESCRIPTIONS.guide_read,
      inputSchema: z.object({ topic: z.string().min(1).describe('A topic from guide_topics.') }).strict(),
    },
    async ({ topic }) => {
      const guide = GUIDE_TOPICS.find((entry) => entry.topic === topic)
      if (!guide) throw new Error(`no guide named ${topic}; guide_topics lists them`)
      if (guide.picture !== 'look' || !lookPicture) return { content: [{ type: 'text', text: guide.text }] }
      // The picture fails loudly into the answer, never silently: the text still stands on its own.
      const picture = await lookPicture().catch((error: unknown) => error instanceof Error ? error : new Error(String(error)))
      if (picture instanceof Error) {
        return { content: [{ type: 'text', text: `${guide.text}\n(The picture of the look could not be drawn here: ${picture.message})` }] }
      }
      return {
        content: [
          { type: 'text', text: guide.text },
          { type: 'text', text: `Picture: ${picture.label}` },
          { type: 'image', data: picture.data, mimeType: picture.mimeType },
        ],
      }
    },
  )
}
