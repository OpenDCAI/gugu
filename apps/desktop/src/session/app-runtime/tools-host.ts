import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { PROGRAM_CALL_META_KEY } from '@shared/extensions/app-runtime-protocol';
import { programCall } from './program-call';

/**
 * 摩擦单 F77 (真源 §4, 统筹 11:42) An App's tools module, served as its MCP program: the protocol and who called are
 * gugu's, the tools are the App's. Every export of the module (`tools.js`) is one MCP tool — the Tool's own fields
 * (`description`, `inputSchema`, and `annotations` / `_meta` if it has them) plus `run(args, { agent })`. Before, giving
 * agents a tool meant hand-writing a stdio JSON-RPC server with no SDK in the bundle (S22: 96 lines, 29 calls, three
 * installs), so agents kept a list in the data file instead.
 *
 * - `agent` is the caller's `user:<uuid>` from `_meta['gugu/agent']`, stamped by gugu's gateway — never the agent's
 *   word; absent when no agent called (a page's `callProgram`).
 * - `session` and `workspaceRoot` are the caller's session and its working copy, from the same stamp
 *   (`gugu/sessionId`, `gugu/workspaceRoot`) — what a command's program reads off `_meta`, as the guide says; each absent
 *   when the gateway did not stamp it.
 * - `model` is the model gugu runs that session on (`gugu/model`, as `listAgents()` gives it), absent when it never chose one.
 * - `run` runs inside its call (`_meta['gugu/call']`, minted by main for this one call): every `gugu.*` verb made from
 *   it, awaited or not, says that call, and is answered as its agent while the call runs (program-call.ts).
 * - What `run` returns is the answer: a string as it is, anything else as its JSON. A throw is an error answer with
 *   its message — what happened, said (F31).
 * - A call that answered says so to the App's pages (`tools/called`, the tool's name): a tool usually changes what a page
 *   shows, and a tools module has no server of its own to tell them with (看板 N1). One per call, never held back to
 *   merge: calls come seconds apart, and a page that wants fewer redraws merges them itself. A throw changed nothing it
 *   vouches for, and says nothing.
 * - A module that is not all tools does not start, loudly, naming the export and what to do: ignoring it quietly
 *   would be a rule nobody wrote down.
 */

/** Who called and from where: each field from its `_meta` key, as gugu's gateway stamped it; one it did not stamp is absent, never empty. */
const STAMP = { agent: 'gugu/agent', session: 'gugu/sessionId', workspaceRoot: 'gugu/workspaceRoot', model: 'gugu/model' } as const;
export type ToolCall = { [field in keyof typeof STAMP]?: string };

function callOf(meta: Record<string, unknown> | undefined): ToolCall {
  return Object.fromEntries(Object.entries(STAMP).filter(([, key]) => typeof meta?.[key] === 'string' && meta[key]).map(([field, key]) => [field, meta![key]])) as ToolCall;
}

export interface AppTool {
  description: string;
  inputSchema: Tool['inputSchema'];
  run(args: Record<string, unknown>, call: ToolCall): unknown;
  [field: string]: unknown;
}

/** MCP's tool-name rule; an export name that breaks it cannot be called. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** What a tool is, said once for every refusal below. */
const SHAPE = '{ description, inputSchema: { type: "object", properties }, run(args, { agent }) }';

/** Why this export is not a tool; null when it is one. */
function notATool(name: string, value: unknown): string | null {
  if (name === 'default') return 'a default export has no tool name: export each tool under its own (export const follow = …)';
  if (!TOOL_NAME.test(name)) return `"${name}" cannot be a tool name (letters, digits, _ and -, up to 64)`;
  if (typeof value !== 'object' || value === null) return `"${name}" is a ${typeof value}, not a tool ${SHAPE}`;
  const tool = value as Partial<AppTool>;
  if (typeof tool.description !== 'string' || !tool.description.trim()) return `"${name}" has no description`;
  const schema = tool.inputSchema as { type?: unknown } | undefined;
  if (typeof schema !== 'object' || schema === null || schema.type !== 'object') {
    return `"${name}" has no inputSchema of type "object" (for no arguments: { type: "object", properties: {} })`;
  }
  if (typeof tool.run !== 'function') return `"${name}" has no run(args, { agent }) function`;
  return null;
}

/** The module's exports as tools; one that is not a tool stops the program, naming it and what to do instead. */
export function toolsOf(moduleExports: Record<string, unknown>, file: string): Map<string, AppTool> {
  const names = Object.keys(moduleExports);
  if (names.length === 0) throw new Error(`${file} exports no tools: export const follow = ${SHAPE}`);
  const tools = new Map<string, AppTool>();
  for (const name of names) {
    const why = notATool(name, moduleExports[name]);
    if (why) {
      throw new Error(`${file}: ${why}. Every export of ${file} is a tool; a helper goes in another module that ${file} imports.`);
    }
    tools.set(name, moduleExports[name] as AppTool);
  }
  return tools;
}

/** What the App's pages hear after one of its tools answered (`programNotification`). */
export const TOOLS_CALLED = 'tools/called';

const text = (value: string): CallToolResult => ({ content: [{ type: 'text', text: value }] });

/** Serve these tools over `transport` (stdio in the program; in memory in tests). */
export async function serveTools(tools: ReadonlyMap<string, AppTool>, transport: Transport, info: { name: string; version: string }): Promise<Server> {
  const server = new Server(info, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...tools].map(([name, { run: _run, ...fields }]) => ({ ...fields, name }) as Tool),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args, _meta: meta } = request.params;
    const tool = tools.get(name);
    if (!tool) return { ...text(`no tool "${name}" here; there are: ${[...tools.keys()].join(', ')}`), isError: true };
    const callId = meta?.[PROGRAM_CALL_META_KEY];
    const run = () => tool.run(args ?? {}, callOf(meta));
    try {
      const value = await (typeof callId === 'string' ? programCall.run(callId, run) : run());
      void server.notification({ method: TOOLS_CALLED, params: { tool: name } });
      return text(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Host refusals and Node system errors carry a code (fetch puts it on its cause).
      // Keep those answers as they are; a fork cannot repair the environment.
      const cause = error instanceof Error ? error.cause : undefined;
      const coded = (typeof error === 'object' && error !== null && 'code' in error)
        || (typeof cause === 'object' && cause !== null && 'code' in cause);
      const hint = coded ? '' : '\nIf this looks like a bug in the App, you may offer the person a fork (guide_read apps-fork).';
      return { ...text(message + hint), isError: true };
    }
  });
  await server.connect(transport);
  return server;
}
