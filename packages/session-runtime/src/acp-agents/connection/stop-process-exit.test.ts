import { tmpdir } from 'node:os';
import { createScope } from '@gugu/session-wire/util';
import { isOk } from '@gugu/session-shared';
import { expect, it, vi } from 'vitest';
import { FakeAcpAgent } from '../acp-test-support';
import { ChildAcpProcessHost } from '../node/child-process-host';
import { createAcpAgentConnection } from './acp-agent-connection';

it.runIf(process.platform !== 'win32')('a real owned process must exit before its stop promise resolves', async () => {
  const host = new ChildAcpProcessHost();
  const spawn = host.spawn.bind(host);
  let child: Awaited<ReturnType<typeof spawn>> | undefined;
  const terminated = Promise.withResolvers<void>();
  vi.spyOn(host, 'spawn').mockImplementation(async spec => {
    child = await spawn(spec);
    await new Promise<void>(resolve => child!.stdout.once('data', () => resolve()));
    child.stdout.on('data', () => terminated.resolve());
    return child;
  });
  const scope = createScope({ label: 'real-stop-exit' });
  const agent = new FakeAcpAgent();
  const result = await createAcpAgentConnection({ host, behavior: { ...agent.behavior, buildSpawn: vi.fn() } }, {
    providerId: 'claude', connectionKey: 'test-owned-process', scope,
    spawn: { command: process.execPath, args: ['-e', "process.on('SIGTERM',()=>{process.stdout.write('terminating');process.stdin.once('data',()=>process.exit(0))});process.stdout.write('ready');setInterval(()=>{},1000)"], cwd: tmpdir(), env: { ...process.env } as Record<string, string> },
    buildClient: vi.fn(), onClosed: vi.fn(),
  });
  try {
    expect(isOk(result)).toBe(true);
    if (!result.success || !child) throw new Error('owned process did not start');
    let exited = false;
    let returned = false;
    child.onExit(() => { exited = true; });
    const stopped = result.data.stopProcess().then(() => { returned = true; });
    await terminated.promise;
    expect(exited).toBe(false);
    expect(returned).toBe(false);
    child.stdin.write('finish\n');
    await stopped;
    expect(exited).toBe(true);
  } finally {
    child?.stdin.write('finish\n');
    await scope.dispose();
  }
});
