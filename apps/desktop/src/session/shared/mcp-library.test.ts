import { describe, expect, it } from 'vitest';
import { libraryMcpConflict, libraryMcpServerSchema, parseLibraryMcpJson } from './mcp-library';

describe('parseLibraryMcpJson —— 粘进来的三种写法', () => {
  it('{ "mcpServers": {...} }:stdio 与 http 各一台', () => {
    const result = parseLibraryMcpJson(JSON.stringify({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { A: '1' } },
        remote: { type: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer x' } },
      },
    }));
    expect(result.problems).toEqual([]);
    expect(result.servers).toEqual([
      { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'], env: { A: '1' } },
      { name: 'remote', transport: 'http', url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer x' } },
    ]);
  });

  it('裸的 { 名字: {...} } 与数组 [{ name, ... }] 读成同一个形状', () => {
    const bare = parseLibraryMcpJson(JSON.stringify({ echo: { command: 'node', args: ['echo.mjs'] } }));
    const list = parseLibraryMcpJson(JSON.stringify([{ name: 'echo', command: 'node', args: ['echo.mjs'] }]));
    expect(bare.servers).toEqual([{ name: 'echo', transport: 'stdio', command: 'node', args: ['echo.mjs'] }]);
    expect(list.servers).toEqual(bare.servers);
  });

  it('一条读不成只记进 problems,其余照收;SSE、别的头、既没 command 也没 url 各有原因', () => {
    const result = parseLibraryMcpJson(JSON.stringify({
      mcpServers: {
        ok: { command: 'node' },
        sse: { type: 'sse', url: 'https://x.test/sse' },
        hdr: { url: 'https://x.test/mcp', headers: { 'X-Api-Key': 'k' } },
        empty: { description: 'nothing' },
      },
    }));
    expect(result.servers.map((server) => server.name)).toEqual(['ok']);
    expect(result.problems).toEqual([
      { name: 'sse', code: 'sse-unsupported' },
      { name: 'hdr', code: 'unsupported-headers', detail: 'X-Api-Key' },
      { name: 'empty', code: 'no-command-or-url' },
    ]);
  });

  it('不是 JSON、没有 server:整段报一条', () => {
    expect(parseLibraryMcpJson('{ not json').problems).toEqual([expect.objectContaining({ name: '', code: 'invalid-json' })]);
    expect(parseLibraryMcpJson('{}').problems).toEqual([{ name: '', code: 'empty' }]);
  });
});

describe('libraryMcpServerSchema', () => {
  it('stdio 要 command,http 要 url 且只认 Authorization 头', () => {
    expect(libraryMcpServerSchema.safeParse({ name: 'a', transport: 'stdio', enabledByDefault: true }).success).toBe(false);
    expect(libraryMcpServerSchema.safeParse({ name: 'a', transport: 'http', enabledByDefault: true }).success).toBe(false);
    expect(libraryMcpServerSchema.safeParse({ name: 'a', transport: 'http', url: 'https://x', headers: { 'X-K': 'v' }, enabledByDefault: true }).success).toBe(false);
    expect(libraryMcpServerSchema.safeParse({ name: 'a', transport: 'http', url: 'https://x', headers: { authorization: 'v' }, enabledByDefault: false }).success).toBe(true);
  });
});

describe('libraryMcpConflict —— 送进会话时会撞的,加的时候就说', () => {
  it('保留名、只差标点、同一个 URL;不算它自己', () => {
    expect(libraryMcpConflict({ name: 'gugu' }, [])).toEqual({ code: 'reserved-name' });
    expect(libraryMcpConflict({ name: 'gugu_browser' }, [])).toEqual({ code: 'reserved-name' });
    expect(libraryMcpConflict({ name: 'a_b' }, [{ name: 'a-b' }])).toEqual({ code: 'same-env-suffix', with: 'a-b' });
    expect(libraryMcpConflict({ name: 'two', url: 'https://x' }, [{ name: 'one', url: 'https://x' }])).toEqual({ code: 'same-url', with: 'one' });
    expect(libraryMcpConflict({ name: 'one', url: 'https://x' }, [{ name: 'one', url: 'https://x' }])).toBeNull();
    expect(libraryMcpConflict({ name: 'context7' }, [{ name: 'a-b' }])).toBeNull();
  });
});
