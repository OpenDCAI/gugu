// 真套接字:复现 2026-09-24 那一撞 —— 这台电脑上有个服务只听在 IPv6 通配(`*:端口`,像 python -m http.server),
// 旧探法(只试着占 127.0.0.1 与 ::1)说「空」,浏览器按 localhost → ::1 连到了它。
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { localPortProbes } from './local-port-probes';
import { isLocalPortFree } from './port-forward';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(options: net.ListenOptions): Promise<number | null> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(options, () => {
      servers.push(server);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : null);
    });
  });
}

describe('is a local port free (both address families)', () => {
  it('counts an IPv6-only wildcard listener as taken', async () => {
    const port = await listen({ host: '::', port: 0, ipv6Only: true });
    if (port === null) return; // no IPv6 on this box
    expect(await isLocalPortFree(port, localPortProbes)).toBe(false);
  });

  it('counts an IPv4 loopback listener as taken', async () => {
    const port = await listen({ host: '127.0.0.1', port: 0 });
    expect(port).not.toBeNull();
    expect(await isLocalPortFree(port!, localPortProbes)).toBe(false);
  });

  it('counts an IPv6 loopback listener as taken', async () => {
    const port = await listen({ host: '::1', port: 0 });
    if (port === null) return;
    expect(await isLocalPortFree(port, localPortProbes)).toBe(false);
  });

  it('says free once nobody listens', async () => {
    const port = await listen({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await isLocalPortFree(port!, localPortProbes)).toBe(true);
  });
});
