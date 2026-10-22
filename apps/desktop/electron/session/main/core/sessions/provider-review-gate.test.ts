import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderBlockerDetector,
  createProviderReviewGateDetector,
  PROVIDER_BLOCKER_STATUS,
  PROVIDER_REVIEW_GATE_STATUS,
} from './provider-review-gate';

describe('provider review gate detector', () => {
  // 检测器把每一块交给 xterm 解析,在 xterm 的写回调里判;xterm 用定时器分片调度解析(一片约 12 ms,超了就
  // setTimeout 排下一片)。假定时器跑空 = 写进去的块全部解析完、回调全部跑过 —— 「触发了 / 没触发」这时读才算数,
  // ❌ 等一个 setTimeout(0) 就读:机器一慢解析还没轮到,「没触发」就白绿。
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const parsed = () => vi.runAllTimersAsync();

  it('recognizes Claude MCP review across ANSI-decorated PTY chunks exactly once', async () => {
    const onDetected = vi.fn();
    const push = createProviderReviewGateDetector(onDetected);

    push('\x1b]0;Claude Code\x1b\\\x1b[2K2 new MCP ser');
    await parsed();
    expect(onDetected).not.toHaveBeenCalled();
    push('vers found\r\n\x1b[1min this project\x1b[0m');
    push('\r\nEnter to confirm');

    await parsed();
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected).toHaveBeenCalledWith('mcp');
  });

  it('does not infer a review gate from nearby prose', async () => {
    const claudeDetected = vi.fn();
    createProviderReviewGateDetector(claudeDetected)(
      'No new MCP servers found in this project.',
    );

    await parsed();
    expect(claudeDetected).not.toHaveBeenCalled();
  });

  it('recognizes the singular Claude confirmation wording', async () => {
    const onDetected = vi.fn();
    createProviderReviewGateDetector(onDetected)('Use this MCP server?');
    await parsed();
    expect(onDetected).toHaveBeenCalledWith('mcp');
  });

  it.each([
    ['Connect a Provider', 'Connect a Provider', 'config'],
    ['免费 API 服务已终止，当前服务不可用，请使用 /login 登录', '免费 API 服务已终止，当前服务不可用，请使用 /login 登录', 'account'],
    ['Free API service has ended. Please use /login to continue.', 'Free API service has ended. Please use /login to continue.', 'account'],
    ['User not found.\nLSPs are disabled', 'User not found.', 'auth'],
  ])('reports a deterministic provider blocker: %s', async (screen, message, reason) => {
    const onDetected = vi.fn();
    const providerId = screen.startsWith('Connect') ? 'qwen' : screen.startsWith('User') ? 'opencode' : 'mimocode';
    const push = createProviderBlockerDetector(onDetected, providerId);
    push(screen);
    await parsed();
    expect(onDetected).toHaveBeenCalledWith({ kind: 'provider', reason, message });
  });

  it('does not let an unrelated provider or ordinary OpenCode prose trigger a blocker', async () => {
    const onDetected = vi.fn();
    const push = createProviderBlockerDetector(onDetected, 'opencode');
    push('The script printed "User not found." while explaining an example.');
    await parsed();
    expect(onDetected).not.toHaveBeenCalled();

    createProviderBlockerDetector(onDetected, 'opencode')('User not found.');
    await parsed();
    expect(onDetected).not.toHaveBeenCalled();

    createProviderBlockerDetector(onDetected, 'qwen')('Connect a Provider');
    await parsed();
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected).toHaveBeenCalledWith({ kind: 'provider', reason: 'config', message: 'Connect a Provider' });
  });

  // #4975:MiMo 的工作区信任门。屏样逐字来自 issue 里读出的终端原文(zh)与二进制 i18n 表(en);
  // 阴例见下一条 —— 标题词被后续 prose 引用、或同屏没有「是,信任」选项时不得触发。
  it.each([
    [
      'zh',
      // 真 PTY 行尾是 \r\n(裸 \n 不复位列,CJK 长行会把后续行推去换行处截断 —— 那不是产品形状)。
      '│● 访问工作区:\r\n'
      + '│ /Users/u/gugu-FRESH-195157/task-home\r\n'
      + '│ 安全确认:这是你自己创建或信任的项目吗?(如你自己的代码、知名开源项目或团队内部项目)。\r\n'
      + '│◆\r\n'
      + '│ ● 是的,我信任此目录\r\n'
      + '│ ○ 否,退出',
      '访问工作区',
    ],
    [
      'en',
      'Accessing workspace:\r\n'
      + '/Users/u/gugu-FRESH/task-home\r\n'
      + 'MiMo Code will be able to read, edit, and execute files here.\r\n'
      + '● Yes, I trust this folder\r\n'
      + '○ No, exit',
      'Accessing workspace',
    ],
  ])('reports the MiMo workspace trust gate as a blocker (%s)', async (_locale, screen, expected) => {
    const onDetected = vi.fn();
    createProviderBlockerDetector(onDetected, 'mimocode')(screen);
    await parsed();
    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected.mock.calls[0]?.[0].kind).toBe('provider');
    expect(onDetected.mock.calls[0]?.[0].reason).toBe('workspace-trust');
    expect(onDetected.mock.calls[0]?.[0].message).toContain(expected);
  });

  it('does not read a quoted trust-gate title or another provider as the MiMo trust gate', async () => {
    // 阴例 ①:标题词出现在 prose 里、同屏没有信任选项 ⇒ 不触发(guard 那一半在拦)。
    const quoted = vi.fn();
    createProviderBlockerDetector(quoted, 'mimocode')(
      'The docs mention the "Accessing workspace:" screen and how to answer it.',
    );
    await parsed();
    expect(quoted).not.toHaveBeenCalled();

    // 阴例 ②:同一屏样在别家 provider 上 ⇒ 不触发(providerIds 那一半在拦)。
    const wrongProvider = vi.fn();
    createProviderBlockerDetector(wrongProvider, 'opencode')(
      'Accessing workspace:\n/tmp/x\nYes, I trust this folder',
    );
    await parsed();
    expect(wrongProvider).not.toHaveBeenCalled();
  });

  it('reports the Codex hook-trust review as a blocker that waits on the person', async () => {
    const onDetected = vi.fn();
    createProviderBlockerDetector(onDetected, 'codex')(
      '\u001b[2J\u001b[1;3H\u001b[1mHooks need review\u001b[0m\r\n'
      + '  1 hook is new or changed.\r\n'
      + '  Hooks can run outside the sandbox after you trust them.\r\n\r\n'
      + '› 1. Review hooks\r\n'
      + '  2. Trust all and continue\r\n'
      + "  3. Continue without trusting (hooks won't run)\r\n"
      + '  enter confirm · esc skip',
    );
    await parsed();
    expect(onDetected).toHaveBeenCalledWith({
      kind: 'provider',
      reason: 'hook-trust',
      message: 'Hooks need review 1 hook is new or changed. Hooks can run outside the sandbox after you trust them.',
    });

    // 阴例:标题被引用、同屏没有选项;或同一屏在别家 provider 上。
    const quoted = vi.fn();
    createProviderBlockerDetector(quoted, 'codex')('Codex printed "Hooks need review" earlier today.');
    const wrongProvider = vi.fn();
    createProviderBlockerDetector(wrongProvider, 'claude')('Hooks need review\n2. Trust all and continue');
    await parsed();
    expect(quoted).not.toHaveBeenCalled();
    expect(wrongProvider).not.toHaveBeenCalled();
  });

  it('normalizes full-screen TUI chrome before matching MiMo and OpenCode blockers', async () => {
    const mimoDetected = vi.fn();
    createProviderBlockerDetector(mimoDetected, 'mimocode')(
      '\u001b[2J\u001b[4;1H✦   免费 API 服务已终止                         esc\n'
      + '┃   请使用 /login 登录，欢迎订阅MiMo Token Plan或配置第三方\n'
      + '┃   API 后使用 MiMo Code。                         确定',
    );
    await parsed();
    expect(mimoDetected).toHaveBeenCalledTimes(1);
    expect(mimoDetected.mock.calls[0]?.[0].message).toContain('免费 API 服务已终止');

    const openCodeDetected = vi.fn();
    createProviderBlockerDetector(openCodeDetected, 'opencode')(
      '┃  User not found.                                                       LSP\n'
      + '┃                                                                        LSPs are disabled',
    );
    await parsed();
    expect(openCodeDetected).toHaveBeenCalledWith({ kind: 'provider', reason: 'auth', message: 'User not found.' });
  });

  it('only evaluates the bounded startup window', async () => {
    const onDetected = vi.fn();
    const push = createProviderBlockerDetector(onDetected, 'opencode');
    push('x'.repeat(32 * 1024));
    push('\nUser not found.');
    await parsed();
    expect(onDetected).not.toHaveBeenCalled();
  });

  it('retains separated OpenCode context while startup output interleaves delivery rows', async () => {
    const onDetected = vi.fn();
    const push = createProviderBlockerDetector(onDetected, 'opencode');
    push('┃  User not found.\n');
    push(`${'delivery row\n'.repeat(96)}Build · Nano Banana Pro OpenRouter\nLSPs are disabled`);
    await parsed();
    expect(onDetected).toHaveBeenCalledWith({ kind: 'provider', reason: 'auth', message: 'User not found.' });
  });

  it('classifies every blocker through one table: approval gates wait for a click, the rest need a fix', () => {
    expect(PROVIDER_REVIEW_GATE_STATUS).toEqual({ mcp: 'needs_user' });
    expect(PROVIDER_BLOCKER_STATUS).toEqual({
      'workspace-trust': 'needs_user',
      'hook-trust': 'needs_user',
      auth: 'error',
      account: 'error',
      config: 'error',
    });
  });
});
