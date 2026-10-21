import { describe, expect, it, vi } from 'vitest';
import type { AcpBridgeSource } from '@gugu/session-core/agents/plugins';
import { resolveAcpBridgeEntry, type BridgeResolveDeps } from './resolve-bridge';

const CLAUDE: AcpBridgeSource = { kind: 'package', alias: '@agentclientprotocol/claude-agent-acp', entry: 'dist/index.js', pairWith: 'claude' };
const PI: AcpBridgeSource = { kind: 'package', alias: 'pi-acp', entry: 'dist/index.js' };
const CODEX: AcpBridgeSource = { kind: 'app-runtime', file: 'codex-app-server-acp.mjs' };
const resolved = { kind: 'resolved' as const, path: '/usr/local/bin/claude' };

function deps(paired: string | undefined = undefined) {
  return {
    resolveBundled: vi.fn((spec: string) => `/app/node_modules/${spec}`),
    appRuntimeEntry: vi.fn((file: string) => `/app/dist-electron/runtime/${file}`),
    pairClaude: vi.fn(async () => paired),
  } satisfies BridgeResolveDeps;
}

describe('acp.bridge → entry: the one place a bridge is resolved (#6394)', () => {
  it('app-runtime bridges come from dist-electron/runtime (codex), never a package', async () => {
    const d = deps();
    await expect(resolveAcpBridgeEntry(CODEX, { role: 'acp', cli: resolved, env: {} }, d))
      .resolves.toBe('/app/dist-electron/runtime/codex-app-server-acp.mjs');
    expect(d.resolveBundled).not.toHaveBeenCalled();
  });

  it('unpaired package bridges resolve the bundled package (pi)', async () => {
    const d = deps('/should/not/be/used');
    await expect(resolveAcpBridgeEntry(PI, { role: 'acp', cli: resolved, env: {} }, d))
      .resolves.toBe('/app/node_modules/pi-acp/dist/index.js');
    expect(d.pairClaude).not.toHaveBeenCalled();
  });

  it('the chat leg of a paired bridge uses the version-paired download when there is one (claude)', async () => {
    const d = deps('/home/.gugu/acp-bridges/claude-agent-acp@1.1.0/node_modules/@gugu-acp/claude-agent-acp/dist/index.js');
    await expect(resolveAcpBridgeEntry(CLAUDE, { role: 'acp', cli: resolved, env: { A: '1' } }, d))
      .resolves.toContain('claude-agent-acp@1.1.0');
    expect(d.pairClaude).toHaveBeenCalledWith('/usr/local/bin/claude', { A: '1' }, undefined);
  });

  it('a session start hands its wait through to the pairing (the download step shows in start progress)', async () => {
    const d = deps('/paired');
    const wait = { onWaiting: vi.fn(), onSettled: vi.fn() };
    await resolveAcpBridgeEntry(CLAUDE, { role: 'acp', cli: resolved, env: {}, wait }, d);
    expect(d.pairClaude).toHaveBeenCalledWith('/usr/local/bin/claude', {}, wait);
  });

  it('…and the bundled one when pairing says bundled', async () => {
    const d = deps(undefined);
    await expect(resolveAcpBridgeEntry(CLAUDE, { role: 'acp', cli: resolved, env: {} }, d))
      .resolves.toBe('/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
  });

  it('login (primary) and an unresolved CLI never probe or download: bundled bridge', async () => {
    const d = deps('/paired');
    await expect(resolveAcpBridgeEntry(CLAUDE, { role: 'primary', cli: resolved, env: {} }, d))
      .resolves.toBe('/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
    await expect(resolveAcpBridgeEntry(CLAUDE, { role: 'acp', cli: { kind: 'unresolved', message: 'no claude' }, env: {} }, d))
      .resolves.toBe('/app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js');
    expect(d.pairClaude).not.toHaveBeenCalled();
  });

  it('does not swallow a missing bundled package: a broken package is loud', async () => {
    const d = deps();
    d.resolveBundled.mockImplementation(() => { throw new Error("Cannot find module 'pi-acp/dist/index.js'"); });
    await expect(resolveAcpBridgeEntry(PI, { role: 'acp', cli: resolved, env: {} }, d)).rejects.toThrow(/pi-acp/);
  });
});
