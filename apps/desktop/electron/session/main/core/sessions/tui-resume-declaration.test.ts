import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import type { Session } from '@shared/core/sessions/sessions';
import { resolveAgentSessionCommandArgs } from './resolve-agent-session-command';
import { tuiResumesExactly } from './tui-resume-exactness';

/**
 * `sessions.tuiResume` 是闲置回收「停了能不能接回原来那条」的唯一依据,它必须与每一家**真实拼出来的**
 * 续跑 argv 一致:按真实 spawn 同一个解析拼一次续跑命令,库里记着的那条 id 必须出现在 argv 里。
 * ❌ 声明与 argv 各说各的:声明说能、argv 却按 cwd 猜一条,回收就会把对话悄悄换掉。
 */
const SESSION_ID = '6b8f6f0e-1c1f-4c4e-9b0e-5a4b3c2d1e0f';
// 原生 id 的几种形状;每一家取第一个过得了它自己校验的。
const NATIVE_ID_SHAPES = [
  '31477a03-961a-4451-82d4-efded56947fc',
  'ses_31477a03961a445182d4efded56947fc',
  'T-31477a03-961a-4451-82d4-efded56947fc',
];

function sessionFor(providerId: string, providerSessionId: string): Session {
  return { id: SESSION_ID, providerId, providerSessionId } as Session;
}

const declared = pluginRegistry.getAll().filter((plugin) => plugin.capabilities.sessions.tuiResume);

describe('sessions.tuiResume matches the resume argv each provider really builds', () => {
  it('has declarations to check', () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  for (const plugin of declared) {
    const id = plugin.metadata.id;
    const mode = plugin.capabilities.sessions.tuiResume!;
    it(`${id} (${mode}) resumes the stored session id`, () => {
      const validate = plugin.behavior.sessions?.validateProviderSessionId;
      const stored = mode === 'caller-id'
        ? SESSION_ID
        : NATIVE_ID_SHAPES.find((shape) => !validate || validate(shape));
      expect(stored, `${id}: no native id shape passes its validator`).toBeDefined();
      const session = sessionFor(id, stored!);
      const resolved = resolveAgentSessionCommandArgs(session, true);
      expect(resolved.isResuming).toBe(true);
      const command = plugin.behavior.prompt!.buildCommand({
        cli: id,
        permissionMode: 'edit',
        initialPrompt: undefined,
        cliSessionId: resolved.cliSessionId,
        providerSessionId: session.providerSessionId,
        isResuming: true,
        model: '',
      });
      expect(command.args.join(' '), `${id} resume argv`).toContain(stored!);
      expect(tuiResumesExactly(session)).toBe(true);
    });
  }
});

describe('tuiResumesExactly refuses what would not come back as the same conversation', () => {
  const byMode = (mode: 'caller-id' | 'provider-id') =>
    declared.find((plugin) => plugin.capabilities.sessions.tuiResume === mode)!.metadata.id;

  it('provider-id without a native id (only the conversation id is stored)', () => {
    expect(tuiResumesExactly(sessionFor(byMode('provider-id'), SESSION_ID))).toBe(false);
  });

  it('caller-id whose stored id is not the one the argv would resume', () => {
    expect(tuiResumesExactly(sessionFor(byMode('caller-id'), NATIVE_ID_SHAPES[0]!))).toBe(false);
  });

  it('a provider that declares nothing', () => {
    const undeclared = pluginRegistry.getAll().find((plugin) => !plugin.capabilities.sessions.tuiResume)!;
    expect(tuiResumesExactly(sessionFor(undeclared.metadata.id, NATIVE_ID_SHAPES[0]!))).toBe(false);
  });

  it('nothing stored yet', () => {
    expect(tuiResumesExactly({ id: SESSION_ID, providerId: byMode('caller-id') } as Session)).toBe(false);
  });
});

describe('sessions.resumeNeedsProviderId: no native id yet ⇒ a fresh session, never a cwd guess', () => {
  const strict = pluginRegistry.getAll().filter((plugin) => plugin.capabilities.sessions.resumeNeedsProviderId);
  const lenient = declared.filter(
    (plugin) => plugin.capabilities.sessions.tuiResume === 'provider-id' && !plugin.capabilities.sessions.resumeNeedsProviderId,
  );

  it('has both kinds to check', () => {
    expect(strict.length).toBeGreaterThan(0);
    expect(lenient.length).toBeGreaterThan(0);
  });

  for (const plugin of strict) {
    it(`${plugin.metadata.id} starts fresh when only the conversation id is stored`, () => {
      expect(resolveAgentSessionCommandArgs(sessionFor(plugin.metadata.id, SESSION_ID), true)).toEqual({
        cliSessionId: SESSION_ID,
        isResuming: false,
      });
    });
  }

  for (const plugin of lenient) {
    it(`${plugin.metadata.id} keeps its own resume argv when no native id is stored`, () => {
      expect(resolveAgentSessionCommandArgs(sessionFor(plugin.metadata.id, SESSION_ID), true).isResuming).toBe(true);
    });
  }
});
