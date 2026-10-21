import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => null }));
vi.mock('@main/lib/logger', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }));

const { checkLibraryMcp } = await import('./check');

/** 最小的 stdio MCP server:回 initialize 与 tools/list;`fail` 模式只在 stderr 说一句就退出。 */
const FIXTURE = String.raw`
const mode = process.argv[2] ?? '';
if (mode === 'fail') { console.error('Error: missing API key'); process.exit(4); }
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
    const message = JSON.parse(buffer.slice(0, nl));
    buffer = buffer.slice(nl + 1);
    if (message.id === undefined) continue;
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    if (message.method === 'initialize') {
      reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
    } else if (message.method === 'tools/list') {
      reply({ tools: [{ name: 'echo', description: 'says it back', inputSchema: { type: 'object' } }, { name: 'env', inputSchema: { type: 'object' } }] });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-mcp-library-check-'));
const script = path.join(dir, 'server.mjs');
fs.writeFileSync(script, FIXTURE);
let unauthorized: Server;
let unauthorizedUrl = '';

beforeAll(async () => {
  unauthorized = createServer((_request, response) => {
    response.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
  });
  await new Promise<void>((resolve) => unauthorized.listen(0, '127.0.0.1', resolve));
  unauthorizedUrl = `http://127.0.0.1:${(unauthorized.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => unauthorized.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

const stdio = (args: string[], command = process.execPath) =>
  ({ name: 'probe', transport: 'stdio' as const, command, args, enabledByDefault: true });

describe('checkLibraryMcp —— 检测连接的四种结果', () => {
  it('stdio 连上:通过,带工具列表(名字与说明)', async () => {
    const result = await checkLibraryMcp(stdio([script]));
    expect(result.status).toBe('ok');
    expect(result.tools).toEqual([{ name: 'echo', description: 'says it back' }, { name: 'env' }]);
  });

  it('命令不存在:失败,原因是「找不到命令」并写出是哪一个', async () => {
    const result = await checkLibraryMcp(stdio([], '/nonexistent-gugu-mcp-bin'));
    expect(result).toEqual({ status: 'failed', at: expect.any(String), tools: [], failure: { kind: 'command-not-found', command: '/nonexistent-gugu-mcp-bin' } });
  });

  it('起来就退出:失败,带退出码和它自己在 stderr 上说的最后一行', async () => {
    const result = await checkLibraryMcp(stdio([script, 'fail']));
    expect(result.failure).toEqual({ kind: 'exited', code: 4, said: 'Error: missing API key' });
  });

  it('http 连不上(端口没人听):失败,原因是「连不上,配置可能有误」', async () => {
    const result = await checkLibraryMcp({ name: 'remote', transport: 'http', url: 'http://127.0.0.1:9/mcp', enabledByDefault: true });
    expect(result).toMatchObject({ status: 'failed', failure: { kind: 'unreachable' } });
  });

  it('http 回 401:需要登录', async () => {
    const result = await checkLibraryMcp({ name: 'remote', transport: 'http', url: unauthorizedUrl, enabledByDefault: true });
    expect(result).toMatchObject({ status: 'needs-login', tools: [] });
  });
});
