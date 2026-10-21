// #2545 — protocol-mcp-injection-parity 探针用的最小 MCP server：只有一个 echo 工具，回声里带一个
// 唯一 token，证明「引擎真的连上了这个 server、把工具暴露给模型、且模型完成了调用」——
// 不依赖 gugu-im/Supabase，纯协议层。用官方 SDK（同 apps/desktop/electron/mcp/gugu-im-server.mjs 的框架），
// 不手搓 JSON-RPC，避免协议细节不对付导致引擎拒绝加载。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export function createProbeEchoServer(token) {
  const server = new McpServer({ name: 'probe-echo', version: '0.2.0' })
  server.registerTool(
    'probe_echo',
    {
      description: 'Echo back the given message together with a verification marker. Call this tool exactly once with any short message.',
      inputSchema: { message: z.string().describe('any short message to echo back') },
    },
    async ({ message }) => ({
      content: [{ type: 'text', text: `PROBE-ECHO-${token}: ${message}` }],
    }),
  )
  return server
}
