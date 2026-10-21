import type { CommandContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../registry';

const PROMPT_TOKEN = 'PROMPT_TOKEN_eng1546';

function freshCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cli: 'agent',
    permissionMode: 'full-access',
    initialPrompt: PROMPT_TOKEN,
    cliSessionId: 'conv-1',
    isResuming: false,
    model: '',
    ...overrides,
  };
}

function buildArgs(id: string, ctx: CommandContext): string[] {
  const plugin = pluginRegistry.get(id);
  if (!plugin) throw new Error(`missing plugin: ${id}`);
  return plugin.behavior.prompt!.buildCommand(ctx).args;
}

describe('prompt delivery (ENG-1546 regression)', () => {
  it('kilocode passes the prompt via --prompt, never as a bare positional path', () => {
    const plugin = pluginRegistry.get('kilocode')!;
    expect(plugin.capabilities.prompt).toMatchObject({ kind: 'argv', flag: '--prompt' });

    const args = buildArgs('kilocode', freshCtx());
    const flagIndex = args.indexOf('--prompt');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(PROMPT_TOKEN);
    // The prompt must appear exactly once, and only as the value of --prompt.
    expect(args.filter((a) => a === PROMPT_TOKEN)).toHaveLength(1);
  });

  it('does not pass the prompt positionally on resume for kilocode', () => {
    const args = buildArgs('kilocode', freshCtx({ initialPrompt: undefined, isResuming: true }));
    expect(args).toContain('--continue');
    expect(args).not.toContain('--prompt');
  });

  // Keystroke agents deliver the prompt by typing into the TUI; it must never leak
  // into argv (their CLIs reject/parse a bare positional differently).
  // 2026-09-21(#6097):原先钉的是 jules / freebuff,两家连同 letta 一起被删,keystroke 家只剩
  // zero 与 kimi(kimi 另有下面那条逐格用例)。⇒ 判据留在 zero 上,❌ 别因为名单变短就删掉它。
  it.each(['zero'])('%s uses keystroke delivery and no argv prompt', (id) => {
    const plugin = pluginRegistry.get(id)!;
    expect(plugin.capabilities.prompt.kind).toBe('keystroke');

    const args = buildArgs(id, freshCtx());
    expect(args).not.toContain(PROMPT_TOKEN);
  });

  it('kimi uses separated PTY keystrokes for its TUI first turn', () => {
    const kimi = pluginRegistry.get('kimi')!;
    expect(kimi.capabilities.prompt).toMatchObject({
      kind: 'keystroke',
      submitSequence: '\r',
      submitDelayMs: 50,
    });
    expect(buildArgs('kimi', freshCtx())).not.toContain(PROMPT_TOKEN);
  });

  it('Codex buildCommand leaves the startup-update override to the host (#6186)', () => {
    // 关启动更新菜单的 `-c` 是 descriptor 的 `selfUpdate` 声明,由起终端的宿主统一追加;
    // provider 自己再写一份就会在 argv 上出现两次,也让「声明」与「实际」两个属主各自漂。
    expect(buildArgs('codex', freshCtx())).not.toContain('check_for_update_on_startup=false');
  });
});
