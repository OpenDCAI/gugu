import { describe, expect, it } from 'vitest';
import type { AgentInstallError } from '@shared/core/agents/agent-payload';
import {
  pickLastInstallError,
  pickLastInstallSuccessAt,
  pickLastUpdateError,
  type SettledInstallEntry,
} from './agent-install';

/**
 * 安装报错要在表单里留着(toast 会飘走,而用户正要照着它改)。这几条钉的是**挑哪一条**——
 * 缓存是整台机器共用的,挑错了就是把别的 agent 的失败显示在这张卡上。#4271
 */
const failed = (id: string, at: number, output = 'npm error code ELIFECYCLE'): SettledInstallEntry => ({
  vars: { id },
  data: { success: false, error: { type: 'command-failed', output } as AgentInstallError },
  error: null,
  submittedAt: at,
});

const ok = (id: string, at: number): SettledInstallEntry => ({
  vars: { id },
  data: { success: true },
  error: null,
  submittedAt: at,
});

describe('pickLastInstallError', () => {
  it('只认这个 agent 的失败 —— ❌ 别的 agent 装挂了不该显示在这张卡上', () => {
    expect(pickLastInstallError([failed('codex', 1)], 'claude', false)).toBeNull();
    expect(pickLastInstallError([failed('claude', 1)], 'claude', false)).not.toBeNull();
  });

  it('同一个 agent 装了几次,取最后那次 —— 成功之后不该还挂着上一次的报错', () => {
    expect(pickLastInstallError([failed('claude', 1), ok('claude', 2)], 'claude', false)).toBeNull();
    // 顺序反过来:先成功后失败,报错要在。
    expect(pickLastInstallError([ok('claude', 2), failed('claude', 3)], 'claude', false)).not.toBeNull();
  });

  it('数组顺序不作数,按 submittedAt 排 —— MutationCache 不保证时间序', () => {
    const picked = pickLastInstallError([failed('claude', 9, 'LATER'), failed('claude', 1, 'EARLIER')], 'claude', false);
    expect(picked?.diagnostic).toContain('LATER');
  });

  it('抛出来的异常也要收 —— 只收 success:false 会漏掉 RPC 本身炸掉的那种', () => {
    const thrown: SettledInstallEntry = {
      vars: { id: 'claude' },
      data: undefined,
      error: new Error('IPC channel closed'),
      submittedAt: 1,
    };
    expect(pickLastInstallError([thrown], 'claude', false)?.message).toBe('IPC channel closed');
  });

  it('正在装的时候不显示上一次的报错 —— 重试期间还挂着旧错等于说重试没跑', () => {
    expect(pickLastInstallError([failed('claude', 1)], 'claude', true)).toBeNull();
  });

  it('还没装过时没有报错 —— ❌ 不给一句凭空的红字', () => {
    expect(pickLastInstallError([], 'claude', false)).toBeNull();
  });

  /**
   * 归属信息喂进去时,报错要点名占位的是谁 —— 这条同时守住「context 真的被透传了」,
   * 不传的话文案会退成「不是 npm 的文件」那句泛泛的。
   */
  it('认得出占位者时点名它', () => {
    const picked = pickLastInstallError(
      [failed('claude', 1, 'npm error code EEXIST\nnpm error path /usr/local/bin/claude')],
      'claude',
      false,
      {
        installations: [
          {
            realpath: '/usr/local/bin/claude',
            pathEntry: '/usr/local/bin/claude',
            version: '1.2.3',
            provenance: { kind: 'homebrew' },
          } as never,
        ],
      },
    );
    expect(picked?.message).toContain('/usr/local/bin/claude');
    expect(picked?.message).toContain('1.2.3');
  });
});

/**
 * 「刚装好」那个后缀读的就是这里。它与上面共用挑选逻辑,分开判是为了让「成功那条被读成失败」
 * 和「别人的成功算到我头上」各自有独立的红灯。
 */
describe('pickLastInstallSuccessAt', () => {
  it('成功过就给出那一刻', () => {
    expect(pickLastInstallSuccessAt([ok('claude', 42)], 'claude')).toBe(42);
  });

  it('只认这个 agent —— ❌ 别的 agent 装好了不该让这张卡说「刚装好」', () => {
    expect(pickLastInstallSuccessAt([ok('codex', 42)], 'claude')).toBeNull();
  });

  it('最后一次是失败就没有 —— ❌ 装挂了还挂着「刚装好」', () => {
    expect(pickLastInstallSuccessAt([ok('claude', 1), failed('claude', 2)], 'claude')).toBeNull();
  });

  it('失败之后重试成功,给出后面那一刻', () => {
    expect(pickLastInstallSuccessAt([failed('claude', 1), ok('claude', 2)], 'claude')).toBe(2);
  });

  it('抛出异常的那次不算成功 —— throw 与 success:false 是两条路,都不是成功', () => {
    const thrown: SettledInstallEntry = {
      vars: { id: 'claude' },
      data: undefined,
      error: new Error('boom'),
      submittedAt: 5,
    };
    expect(pickLastInstallSuccessAt([thrown], 'claude')).toBeNull();
  });

  it('没装过就是 null', () => {
    expect(pickLastInstallSuccessAt([], 'claude')).toBeNull();
  });
});

/**
 * #6101 —— 更新失败从前只有一条 6 秒的 toast:用户走开一会儿回来,界面显示「什么都没干过」,
 * 而那次更新确实失败了。挑法与安装那条同源(同一份残留、同一条「按 agent 过滤」的判据),
 * 只是措辞走更新那套错误类型。
 */
describe('pickLastUpdateError', () => {
  const updateFailed = (id: string, at: number): SettledInstallEntry => ({
    vars: { id },
    // 只有更新会返回这个类型 —— 拿它当阳控:安装那套措辞里根本没有这一支。
    data: {
      success: false,
      error: { type: 'version-unchanged', id, version: '1.0.0', path: '/usr/local/bin/claude' } as never,
    },
    error: null,
    submittedAt: at,
  });

  it('更新失败有说法,而且留得住', () => {
    const picked = pickLastUpdateError([updateFailed('claude', 1)], 'claude', false);
    expect(picked?.message).toContain('1.0.0');
  });

  it('只认这个 agent 的那次', () => {
    expect(pickLastUpdateError([updateFailed('codex', 1)], 'claude', false)).toBeNull();
  });

  it('正在重试时不挂上一次的报错', () => {
    expect(pickLastUpdateError([updateFailed('claude', 1)], 'claude', true)).toBeNull();
  });

  it('没更新过就没有红字', () => {
    expect(pickLastUpdateError([], 'claude', false)).toBeNull();
  });
});
