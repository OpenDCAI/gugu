import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { serializeWidgetMessage } from '@gugu/core/shared/ui/widgetModels'
import type { AppSearchSource } from './gugu-app-search-tool'
import { assertMcpToolDescriptionWithinBudget } from './mcp-tool-description-budget.mjs'

const schema = z.object({
  chat_id: z.string().min(1), app: z.string().min(1), view: z.string().min(1), text: z.string(),
  data: z.record(z.string(), z.unknown()).optional(), reply_to_message_id: z.string().optional(),
}).strict()
export type WidgetSendArgs = z.infer<typeof schema>

export function registerGuguWidgetTool(server: McpServer, source: AppSearchSource,
  send: (args: WidgetSendArgs, content: string) => Promise<string>): void {
  const description = 'Send an App view in a chat message. The installed, enabled App must declare this widget view. text is the plain preview (1–200 characters); data is immutable JSON, at most 4096 UTF-8 bytes. Does not wake agents. guide_read widgets explains callbacks.'
  assertMcpToolDescriptionWithinBudget('widget_send', description)
  server.registerTool('widget_send', { description, inputSchema: schema }, async args => {
    const found = source()
    if (!found) throw new Error('widget_send is unavailable here: Apps reach a session of yours, not a side chat')
    const { app, view, text, data } = args
    const content = serializeWidgetMessage({ v: 2, text, app, view, ...(data === undefined ? {} : { data }) })
    const installed = (await found).apps.find(hit => hit.manifest.id === app && hit.state === 'on')
    if (!installed) throw new Error(`widget_send: ${app} must be installed, enabled and available to this session`)
    if (!installed.widgetViews?.some(tab => tab.view === view)) throw new Error(`widget_send: ${app} does not declare widget view ${view}`)
    return { content: [{ type: 'text', text: await send(args, content) }] }
  })
}
