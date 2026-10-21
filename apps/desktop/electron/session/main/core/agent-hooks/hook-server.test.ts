import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookServer, type RawHookRequest } from './hook-server';

vi.mock('@main/lib/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

function post(port: number, headers: Record<string, string>, body = '{}'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const servers: HookServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

async function startServer() {
  const received: RawHookRequest[] = [];
  const server = new HookServer();
  servers.push(server);
  await server.start(async (raw) => {
    received.push(raw);
  });
  return { server, received };
}

describe('HookServer', () => {
  it('accepts a hook posted with the X-Gugu-* headers the agent hooks send', async () => {
    const { server, received } = await startServer();
    const source = server.createSource('claude-conv-1', null);

    const status = await post(
      server.getPort(),
      {
        'Content-Type': 'application/json',
        'X-Gugu-Token': source.token,
        'X-Gugu-Pty-Id': 'claude-conv-1',
        'X-Gugu-Event-Type': 'stop',
      },
      '{"ok":true}'
    );

    expect(status).toBe(200);
    expect(received).toEqual([
      { ptyId: 'claude-conv-1', type: 'stop', body: '{"ok":true}', sourceId: source.id, harnessVersion: null, receivedAt: expect.any(Number) },
    ]);
  });

  it('rejects a request whose token does not match', async () => {
    const { server, received } = await startServer();
    server.createSource('claude-conv-1', null);

    const status = await post(server.getPort(), {
      'X-Gugu-Token': 'wrong',
      'X-Gugu-Pty-Id': 'claude-conv-1',
      'X-Gugu-Event-Type': 'stop',
    });

    expect(status).toBe(403);
    expect(received).toEqual([]);
  });

  // 刻意不认改名前的 X-Emdash-* 请求头:本版本起的会话只注入 GUGU_* 变量,残留的旧钩子条目读不到自己的变量,
  // 根本不会发请求(posix-hook-guard.test.ts 用真 bash 证过)。认它只会是一条永远不走的分支。
  it('does not accept the pre-rename X-Emdash-* headers', async () => {
    const { server, received } = await startServer();
    const source = server.createSource('claude-conv-1', null);

    const status = await post(server.getPort(), {
      'X-Emdash-Token': source.token,
      'X-Emdash-Pty-Id': 'claude-conv-1',
      'X-Emdash-Event-Type': 'stop',
    });

    expect(status).toBe(403);
    expect(received).toEqual([]);
  });

  it('gives each spawn of one ptyId its own identity and revokes only that spawn', async () => {
    const { server, received } = await startServer();
    const first = server.createSource('pi-conv-1', null);
    const second = server.createSource('pi-conv-1', null);
    expect(second.id).not.toBe(first.id);

    const headers = (token: string) => ({
      'X-Gugu-Token': token, 'X-Gugu-Pty-Id': 'pi-conv-1', 'X-Gugu-Event-Type': 'session',
    });
    expect(await post(server.getPort(), headers(first.token))).toBe(200);
    expect(received.at(-1)?.sourceId).toBe(first.id);

    first.dispose();
    expect(await post(server.getPort(), headers(first.token))).toBe(403);
    expect(await post(server.getPort(), headers(second.token))).toBe(200);
    expect(received.at(-1)?.sourceId).toBe(second.id);
  });

  it('does not let a source post for another ptyId', async () => {
    const { server, received } = await startServer();
    const source = server.createSource('pi-conv-1', null);

    const status = await post(server.getPort(), {
      'X-Gugu-Token': source.token,
      'X-Gugu-Pty-Id': 'pi-conv-2',
      'X-Gugu-Event-Type': 'session',
    });

    expect(status).toBe(403);
    expect(received).toEqual([]);
  });

  it('keeps a request that was already admitted attributed to the source that sent it', async () => {
    const { server, received } = await startServer();
    const source = server.createSource('pi-conv-1', null);

    // Headers first, body later: the source is resolved when the request is admitted, so revoking it
    // mid-flight must not re-attribute the event to whatever spawn replaced it.
    const sentHeaders = Promise.withResolvers<void>();
    let sendBody!: () => void;
    const status = new Promise<number>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: server.getPort(), path: '/hook', method: 'POST',
        headers: {
          Expect: '100-continue',
          'X-Gugu-Token': source.token,
          'X-Gugu-Pty-Id': 'pi-conv-1',
          'X-Gugu-Event-Type': 'session',
        },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
      req.on('continue', () => sentHeaders.resolve());
      sendBody = () => req.end('{}');
      req.flushHeaders();
    });

    await sentHeaders.promise;
    source.dispose();
    const replacement = server.createSource('pi-conv-1', null);
    // The body comes a moment after the headers: a stamp taken once it is in would not be earlier than this.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const bodySentAt = Date.now();
    sendBody();

    expect(await status).toBe(200);
    expect(received).toEqual([
      { ptyId: 'pi-conv-1', type: 'session', body: '{}', sourceId: source.id, harnessVersion: null, receivedAt: expect.any(Number) },
    ]);
    expect(replacement.id).not.toBe(source.id);
    // #7141 review: the event's time is when the request arrived — before its body, before any work on it.
    expect((received[0] as { receivedAt: number }).receivedAt).toBeLessThan(bodySentAt);
  });
});

describe('HookServer across a host-process restart (#6264)', () => {
  it('re-binds the same port and accepts the hooks of an agent that kept running in tmux; hands its source back once', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { EndpointPorts, PersistedRecords } = await import('@main/lib/stable-endpoint');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-hooks-'));
    const persistence = () => ({
      ports: new EndpointPorts(dataDir),
      sources: new PersistedRecords<import('./hook-server').PersistedHookSource>(path.join(dataDir, 'hook-sources.json')),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    const before = new HookServer();
    before.usePersistence(persistence());
    await before.start(async () => undefined);
    const kept = before.createSource('claude-conv-1', '2.1.0');
    kept.keepAcrossRestart('p:t:conv-1');
    const plain = before.createSource('claude-conv-2', null);
    const port = before.getPort();
    before.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const received: RawHookRequest[] = [];
    const after = new HookServer();
    servers.push(after);
    after.usePersistence(persistence());
    await after.start(async (raw) => void received.push(raw));
    expect(after.getPort()).toBe(port);
    const headers = (token: string, ptyId: string) => ({ 'x-gugu-token': token, 'x-gugu-pty-id': ptyId, 'x-gugu-event-type': 'stop' });
    expect(await post(port, headers(kept.token, 'claude-conv-1'))).toBe(200);
    expect(received[0]).toMatchObject({ ptyId: 'claude-conv-1', sourceId: kept.id, harnessVersion: '2.1.0' });
    // 不在 tmux 里的那一个随宿主一起走了,它的令牌不再认。
    expect(await post(port, headers(plain.token, 'claude-conv-2'))).toBe(403);
    const restored = after.takeRestoredSource('p:t:conv-1');
    expect(restored).toMatchObject({ id: kept.id, token: kept.token });
    expect(after.takeRestoredSource('p:t:conv-1')).toBeUndefined();
    // 会话真结束:收回,盘上也删。
    restored!.dispose();
    expect(await post(port, headers(kept.token, 'claude-conv-1'))).toBe(403);
    expect(fs.readFileSync(path.join(dataDir, 'hook-sources.json'), 'utf8')).not.toContain(kept.token);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
