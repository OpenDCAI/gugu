import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { provider as kilo } from './kilocode';
import { provider as omp } from './oh-my-pi';
import { provider as pi } from './pi';

function createMemoryFs(): PluginFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(path) { return files.get(path) ?? null; },
    async write(path, content) { files.set(path, content); },
    async delete(path) { files.delete(path); },
    async exists(path) { return files.has(path); },
    async list(path) { return [...files.keys()].filter((file) => file.startsWith(path)); },
  };
}

const pluginCases = [
  {
    name: 'kilocode',
    install: (fs: PluginFs) => kilo.behavior.plugins!.installPlugin(fs, { kind: 'workspace', path: '/workspace' }),
    path: '.kilo/plugins/gugu-notifications.js',
    markers: [
      'export const GuguNotifications',
      'X-Gugu-Event-Type',
      "event.type === 'session.idle'",
      // session.idle 是回合结束边,必须报成 stop(spec hook-status-derivation);报成 idle_prompt 宿主就丢了这条边。
      "type: 'stop'",
      "event.type === 'session.error'",
      'getKiloSessionId',
    ],
  },
  {
    name: 'oh-my-pi',
    install: (fs: PluginFs) => omp.behavior.plugins!.installPlugin(fs, { kind: 'workspace', path: '/workspace' }),
    path: '.omp/extensions/gugu-hook.ts',
    markers: [
      "pi.on('session_stop'",
      'event.session_file',
      "notifyGugu('stop'",
      "pi.on('session_shutdown', async ()",
    ],
  },
  {
    name: 'pi',
    install: (fs: PluginFs) => pi.behavior.plugins!.installPlugin(fs, { kind: 'workspace', path: '/workspace' }),
    path: '.pi/extensions/gugu-hook.ts',
    markers: [
      "eventType: 'start' | 'stop' | 'error' | 'notification' | 'session'",
      "pi.on('session_start'",
      "pi.on('before_agent_start'",
      'event.systemPrompt',
      'process.env.GUGU_PI_SYSTEM_PROMPT',
      'ctx.sessionManager.getSessionFile()',
      "notifyGugu('session'",
      // 回合的起始边 —— 缺它时终端腿的状态点结构上只能报空闲(spec hook-status-derivation)。
      // 键名逐字钉住:`agent_start` 拼错 pi 不报错、永不触发,而代码看起来是修好的。
      "pi.on('agent_start'",
      "notifyGugu('start')",
    ],
  },
] as const;

describe('provider plugin-file installation contracts', () => {
  it.each(pluginCases)('$name installs its lifecycle plugin at the declared workspace path', async ({ install, path, markers }) => {
    const fs = createMemoryFs();
    await expect(install(fs)).resolves.toEqual([path]);
    const content = await fs.read(path);
    for (const marker of markers) expect(content).toContain(marker);
  });
});
