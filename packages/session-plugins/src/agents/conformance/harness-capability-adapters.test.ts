import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODEL_CONFIG_DIALECT } from '@gugu/session-core/agents/plugins';
import { assertUserModelAllowed } from '../../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model';
import { startupPlaceholderKey } from '../../../../../apps/desktop/src/session/renderer/features/sessions/acp/startup-placeholder';
import { pluginRegistry } from '../registry';
const provider = (id: string) => pluginRegistry.get(id)!;
describe('harness capability adapter slots', () => {
  it('S1: spawn executable reaches the adapter-owned diagnostic input', () => {
    // codex 的 ACP 腿只有咕咕自建的那座桥,入口由宿主按 `acp.bridge` 解析好递进来(#6394)。
    const spawn = provider('codex').behavior.acp!.buildSpawn({
      cwd: '/tmp', cli: '/bin/codex', env: { GUGU_CODEX_BIN: '/custom/codex' },
      adapterEntry: '/app/dist-electron/runtime/codex-app-server-acp.mjs',
    });
    expect(spawn.executable).toBe('/custom/codex');
    expect(provider('opencode').behavior.acp!.buildSpawn({
      cwd: '/tmp', cli: '/bin/opencode', env: {},
    }).executable).toBeUndefined();
  });
  it('S2: declared allowlist is read, undeclared codex is ignored', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-capability-s2-'));
    try {
      await writeFile(join(home, 'settings.json'), JSON.stringify({ availableModels: ['kept'] }));
      await expect(assertUserModelAllowed({ HOME: home, CLAUDE_CONFIG_DIR: home }, 'claude', 'blocked')).rejects.toThrow('availableModels');
      await expect(assertUserModelAllowed({ HOME: home, CLAUDE_CONFIG_DIR: home }, 'claude', 'kept')).resolves.toBeUndefined();
      await expect(assertUserModelAllowed({ HOME: home, CLAUDE_CONFIG_DIR: home }, 'codex', 'blocked')).resolves.toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it('S3: dialect gate has the positive and negative consumer cases', () => {
    expect(MODEL_CONFIG_DIALECT.requiresContextWindow.has('opencode-config-content')).toBe(true);
    expect(MODEL_CONFIG_DIALECT.requiresContextWindow.has('provider-env')).toBe(false);
  });
  it('S4: local-conversation consumer declarations match existing fork coverage', () => {
    expect(provider('claude').capabilities.sessions.childId).toBe('provider-minted');
    expect(provider('codex').capabilities.sessions.childId).toBeUndefined();
  });
  it('S5: startup notice has a declared positive and an undeclared negative path', () => {
    expect(startupPlaceholderKey({ historyLoading: true, noticeKey: 'chat.opencodePreparing' })).toBe('chat.opencodePreparing');
    expect(startupPlaceholderKey({ historyLoading: true, noticeKey: undefined })).toBeNull();
    expect(provider('opencode').capabilities.acp.startup?.noticeKey).toBe('chat.opencodePreparing');
    expect(provider('codex').capabilities.acp.startup).toBeUndefined();
  });

  it('H1: real Claude hook explains the model failure while Codex stays silent', () => {
    const cause = { name: 'x', message: 'Invalid value for config option model' };
    expect(provider('claude').behavior.acp!.explainError?.(cause)).toContain('availableModels');
    expect(provider('codex').behavior.acp!.explainError?.(cause)).toBeUndefined();
  });
});
