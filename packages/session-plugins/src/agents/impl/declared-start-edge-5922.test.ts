import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { makeStdinHookCommand } from '@gugu/session-core/agents/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { provider as copilot } from './copilot';
import { COPILOT_HOOKS_PATH } from './copilot/hooks';
import { provider as qwen } from './qwen';
import { qwenHookSpecs } from './qwen/hooks';

// #5922:声明(`hooks.supportedEvents`)必须与 hook 产物真报的边一致。qwen / copilot 真装了回合起始边
// (`UserPromptSubmit` / `userPromptSubmitted` → `start`),声明里却没有 `start`
// ⇒ 宿主以为这一家不报起点,对每个进 pty 的回车再合成一条 start;不起回合的回车(空回车、斜杠命令)
// 于是留下一条没有终点的 working(agent-hook-service 的 `providerSupportsNativeStartHook`)。
const START = makeStdinHookCommand('start');

function memoryFs(files: Map<string, string>): PluginFs {
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => { files.set(path, content); },
    delete: async (path) => { files.delete(path); },
    exists: async (path) => files.has(path),
    list: async () => [],
  };
}

function declaresStart(hooks: typeof qwen.capabilities.hooks): boolean {
  return hooks.kind !== 'none' && hooks.supportedEvents.includes('start');
}

describe('declared start edge matches the installed hook artefact (#5922)', () => {
  it('qwen installs UserPromptSubmit → start and declares start', () => {
    const emitsStart = qwenHookSpecs().some((spec) => spec.command === START);
    expect(emitsStart).toBe(true);
    expect(declaresStart(qwen.capabilities.hooks)).toBe(emitsStart);
  });

  it('copilot installs userPromptSubmitted → start and declares start', async () => {
    const files = new Map<string, string>();
    await copilot.behavior.hooks!.writeHooks!(memoryFs(files), [], { harnessVersion: '999.0.0' });
    const written = files.get(COPILOT_HOOKS_PATH) ?? '';
    const emitsStart = written.includes(JSON.stringify(START).slice(1, -1));
    expect(emitsStart).toBe(true);
    expect(declaresStart(copilot.capabilities.hooks)).toBe(emitsStart);
  });
});
