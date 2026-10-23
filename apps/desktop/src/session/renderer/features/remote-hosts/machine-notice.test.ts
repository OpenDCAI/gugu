// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { enUSRemoteHostMessages, zhCNRemoteHostMessages } from '@renderer/localization/messages-remote-hosts';
import { zhCNSessionWorkflowMessages } from '@renderer/localization/messages-session-workflows';
import type { Translate } from './connection-status';

const notices = vi.hoisted(() => ({ notify: vi.fn(), dismissNotice: vi.fn() }));
vi.mock('@/lib/notices', () => notices);

import { CONNECTING_NOTICE_DELAY_MS, machineNotice, useMachineNotice, type MachineNoticeSpec } from './machine-notice';

/** 用中文文案表真的填一遍:判据看的是人会读到的那句话。 */
const zh: Translate = (key, values = {}) => {
  const template = ({ ...zhCNRemoteHostMessages, ...zhCNSessionWorkflowMessages } as Record<string, string>)[key];
  if (!template) throw new Error(`missing ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};
const spec = (input: Partial<Parameters<typeof machineNotice>[0]>) =>
  machineNotice({ connection: 'reconnecting', label: 'Mac 1', dials: 0, translate: zh, ...input });

describe('选着的机器用不了,说什么(#137)', () => {
  it('中英文案键一一对应', () => {
    expect(Object.keys(zhCNRemoteHostMessages).sort()).toEqual(Object.keys(enUSRemoteHostMessages).sort());
  });

  it('连着 = 没有提示;名下已经没有这台机器(设备行不在了)= 用不了,❌ 当没事', () => {
    expect(spec({ connection: 'connected' })).toBeNull();
    expect(spec({ connection: null })).toMatchObject({ title: 'Mac 1 离线。草稿已保留，上线后可发送，或换一台机器。', tier: 'error', waiting: false, delayed: false });
  });

  it('重连中:在等 + 先等一会儿再出现;第几次写在说明里,第一次拨不算重试', () => {
    expect(spec({ connection: 'reconnecting', dials: 0 })).toMatchObject({ title: '正在重新连接 Mac 1…', description: undefined, tier: 'info', waiting: true, delayed: true });
    expect(spec({ connection: 'reconnecting', dials: 3 })?.description).toBe('第 3 次尝试');
    // 从没连上过的机器:拨的第一次就是「正在连接」,第二次起才是重试
    expect(spec({ connection: 'connecting', dials: 1 })).toMatchObject({ title: '正在连接 Mac 1…', description: undefined, waiting: true, delayed: true });
    expect(spec({ connection: 'connecting', dials: 3 })?.description).toBe('第 2 次尝试');
  });

  it('离线 / 休眠只是此刻用不了:说明档、不转圈、立刻出现;❌ 假装在重试', () => {
    expect(spec({ connection: 'offline', dials: 5 })).toMatchObject({ title: 'Mac 1 离线。草稿已保留，上线后可发送，或换一台机器。', description: undefined, tier: 'info', waiting: false, delayed: false });
    expect(spec({ connection: 'asleep' })).toMatchObject({ tier: 'info', waiting: false, delayed: false });
    expect(spec({ connection: 'waking' })).toMatchObject({ tier: 'info', waiting: true, delayed: false });
  });

  it('叫醒没成 / 要先登录 / 登录没了 / 版本太旧是报错档:要人知道、可能要人去做点什么', () => {
    expect(spec({ connection: 'wake-failed', wakeFailure: '积分已用完，Mac 1 醒不来。' })).toMatchObject({ title: '积分已用完，Mac 1 醒不来。', tier: 'error', waiting: false });
    expect(spec({ connection: 'sign-in' })?.tier).toBe('error');
    expect(spec({ connection: 'offline', signInExpiredAt: '2026-10-22T00:00:00Z' })).toMatchObject({ title: 'Mac 1 上的登录已失效，请在 设置 → 设备 中重新登录。', tier: 'error' });
    expect(spec({ connection: 'outdated' })?.tier).toBe('error');
    expect(spec({ connection: 'update-failed' })?.tier).toBe('error');
    // 正在替它升级:报错档、但在等
    expect(spec({ connection: 'updating' })).toMatchObject({ tier: 'error', waiting: true, delayed: false });
  });
});

describe('一台机器一条提示:原地换,不叠', () => {
  let harness: ReturnType<typeof createReactHarness>;
  const reconnecting = (dials: number) => spec({ connection: 'reconnecting', dials }) as MachineNoticeSpec;
  const offline = () => spec({ connection: 'offline' }) as MachineNoticeSpec;
  async function show(deviceId: string | null, notice: MachineNoticeSpec | null) {
    await act(async () => {
      await harness.render(createElement(Probe, { deviceId, notice }));
    });
  }
  function Probe({ deviceId, notice }: { deviceId: string | null; notice: MachineNoticeSpec | null }) {
    useMachineNotice(deviceId, 'Mac 1', notice, zh);
    return null;
  }
  const lastNotify = () => notices.notify.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    vi.useFakeTimers();
    notices.notify.mockClear();
    notices.dismissNotice.mockClear();
    harness = createReactHarness();
  });
  afterEach(() => {
    harness.cleanup();
    vi.useRealTimers();
  });

  it('重连中先等一会儿才出现;一眨眼就好了的,什么都不打扰,连「已连上」也不说', async () => {
    await show('d1', reconnecting(1));
    await act(async () => void vi.advanceTimersByTime(CONNECTING_NOTICE_DELAY_MS - 1));
    expect(notices.notify).not.toHaveBeenCalled();
    await show('d1', null);
    await act(async () => void vi.advanceTimersByTime(CONNECTING_NOTICE_DELAY_MS * 2));
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('出现之后每次变化(第几次 → 离线)立刻换在同一条上:同一个 key、常驻,❌ 另发一条', async () => {
    await show('d1', reconnecting(1));
    await act(async () => void vi.advanceTimersByTime(CONNECTING_NOTICE_DELAY_MS));
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(lastNotify()).toMatchObject({ key: 'machine:d1', title: '正在重新连接 Mac 1…', description: '第 1 次尝试', tier: 'info', waiting: true, ongoing: true });
    await show('d1', reconnecting(2));
    expect(lastNotify()).toMatchObject({ key: 'machine:d1', description: '第 2 次尝试' });
    await show('d1', offline());
    expect(lastNotify()).toMatchObject({ key: 'machine:d1', title: 'Mac 1 离线。草稿已保留，上线后可发送，或换一台机器。', waiting: false, ongoing: true });
    expect(new Set(notices.notify.mock.calls.map((call) => call[0].key))).toEqual(new Set(['machine:d1']));
    expect(notices.dismissNotice).not.toHaveBeenCalled();
  });

  it('离线这类「已经是结论」的状态不等,马上出现', async () => {
    await show('d1', offline());
    expect(notices.notify).toHaveBeenCalledTimes(1);
  });

  it('出现过的问题好了:在同一条上换成「已连上」(转瞬的成功档),不是另发一条', async () => {
    await show('d1', offline());
    await show('d1', null);
    expect(lastNotify()).toMatchObject({ key: 'machine:d1', title: '已连接 Mac 1', tier: 'success' });
    expect(lastNotify().ongoing).toBeUndefined();
    expect(notices.notify).toHaveBeenCalledTimes(2);
  });

  it('用户亲手关掉的:同一次问题里后面的变化不再弹回来,好了也不再说', async () => {
    await show('d1', reconnecting(1));
    await act(async () => void vi.advanceTimersByTime(CONNECTING_NOTICE_DELAY_MS));
    await act(async () => lastNotify().onDismiss());
    notices.notify.mockClear();
    await show('d1', reconnecting(2));
    await show('d1', offline());
    await show('d1', null);
    expect(notices.notify).not.toHaveBeenCalled();
    // 下一次出问题是新的一次,照常说
    await show('d1', offline());
    expect(notices.notify).toHaveBeenCalledTimes(1);
  });

  it('换了机器 / 新建框走了:收掉它的那条;没出现过的不去收', async () => {
    await show('d1', offline());
    await show('d2', null);
    expect(notices.dismissNotice).toHaveBeenCalledWith('machine:d1');
    notices.dismissNotice.mockClear();
    await show('d2', null);
    await show(null, null);
    expect(notices.dismissNotice).not.toHaveBeenCalled();
  });

  it('收的时候发出的 onDismiss 不算用户关的', async () => {
    await show('d1', offline());
    const onDismiss = lastNotify().onDismiss as () => void;
    await show(null, null);
    expect(notices.dismissNotice).toHaveBeenCalledTimes(1);
    onDismiss();
    await show('d1', offline());
    expect(notices.notify.mock.calls.filter((call) => call[0].key === 'machine:d1')).toHaveLength(2);
  });
});
