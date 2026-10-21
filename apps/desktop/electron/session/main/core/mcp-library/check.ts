import { homedir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { LibraryMcpCheck, LibraryMcpFailure, LibraryMcpServer, LibraryMcpTool } from '@shared/mcp-library';
import { log } from '@main/lib/logger';
import { OwnedStdioTransport, lastStderrLine } from '@main/core/mcp/owned-stdio-transport';

/** 与 AionUi 同一个上限:连不上、不回 initialize 的 server 不让人一直等。 */
const CHECK_TIMEOUT_MS = 30_000;

class CheckTimeout extends Error {}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeout()), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * 失败按类给,界面照类出文案;异常原文只进日志。stdio 起来就退出时带上它自己在 stderr 上说的最后一行
 * (「missing API key」比「退出码 4」有用)和退出码。
 */
function failureOf(server: LibraryMcpServer, stdio: OwnedStdioTransport | null, error: unknown): LibraryMcpFailure {
  if (error instanceof CheckTimeout) return { kind: 'timeout' };
  if (error instanceof StreamableHTTPError && typeof error.code === 'number') return { kind: 'http', status: error.code };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const command = server.command ?? '';
  if (stdio && code === 'ENOENT') return { kind: 'command-not-found', command };
  if (stdio && code === 'EACCES') return { kind: 'permission-denied', command };
  const exit = stdio?.owned?.child.exitCode;
  const said = stdio ? lastStderrLine(stdio.stderrTail) : '';
  if (exit !== null && exit !== undefined) return { kind: 'exited', code: exit, ...(said ? { said } : {}) };
  return { kind: 'unreachable', ...(said ? { said } : {}) };
}

/**
 * 手动「检测连接」:照这条记录起一次(stdio 起进程,http 带 Authorization 连),`initialize` + `tools/list`,
 * 然后关掉(stdio 连进程树一起)。读的就是开任务时送给各家的那条记录 —— 同一个命令、参数、env、URL;
 * 不同的只有 cwd(这里是主目录,任务里是任务目录)和起进程的是咕咕而不是那一家。
 */
export async function checkLibraryMcp(server: LibraryMcpServer): Promise<LibraryMcpCheck> {
  const at = new Date().toISOString();
  const client = new Client({ name: 'gugu', version: '1.0.0' });
  const stdio = server.transport === 'stdio'
    ? new OwnedStdioTransport(() => ({
        command: server.command ?? '',
        args: server.args ?? [],
        cwd: server.cwd ?? homedir(),
        env: server.env ?? {},
      }))
    : null;
  const transport: Transport = stdio ?? new StreamableHTTPClientTransport(new URL(server.url ?? ''), {
    requestInit: { headers: server.headers ?? {} },
  });
  try {
    const tools = await within((async () => {
      await client.connect(transport);
      const listed: LibraryMcpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        listed.push(...page.tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) })));
        cursor = page.nextCursor;
      } while (cursor);
      return listed;
    })(), CHECK_TIMEOUT_MS);
    return { status: 'ok', at, tools };
  } catch (error) {
    if (error instanceof StreamableHTTPError && error.code === 401) return { status: 'needs-login', at, tools: [] };
    log.info('library MCP check failed', { server: server.name, error: String(error) });
    return { status: 'failed', at, tools: [], failure: failureOf(server, stdio, error) };
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
