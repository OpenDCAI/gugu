import { describe, expect, it } from 'vitest';
import { enUSRemoteHostMessages, zhCNRemoteHostMessages } from '@renderer/localization/messages-remote-hosts';
import { zhCNSessionWorkflowMessages } from '@renderer/localization/messages-session-workflows';
import {
  chatLinkRow,
  formatAgo,
  hostConnectionState,
  hostStatusLabel,
  isRetryableRemoteError,
  machineNoticeLabel,
  machineUnavailableReason,
  type Translate,
} from './connection-status';

/** 用中文文案表真的填一遍:判据看的是人会读到的那句话。 */
const zh: Translate = (key, values = {}) => {
  const template = (zhCNRemoteHostMessages as Record<string, string>)[key];
  if (!template) throw new Error(`missing ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

const NOW = Date.parse('2026-09-23T12:00:00Z');

describe('connection-status(#6264 侧栏的点 / 聊天末尾那一行)', () => {
  it('中英文案键一一对应', () => {
    expect(Object.keys(zhCNRemoteHostMessages).sort()).toEqual(Object.keys(enUSRemoteHostMessages).sort());
  });

  it('#6264 远程 SSH 的机器太旧:正在更新 / 更新没成,各说各的;❌「重连中」「空闲时会自动更新」', () => {
    const base = { online: true, loading: false, unreachable: false };
    expect(hostConnectionState({ ...base, sshLink: 'updating' })).toBe('updating');
    expect(hostConnectionState({ ...base, sshLink: 'outdated' })).toBe('update-failed');
    expect(hostConnectionState({ ...base, sshLink: 'unreachable' })).toBe('reconnecting');
    expect(hostStatusLabel('updating', 'd22', null, NOW, zh)).toBe('d22 上的咕咕 server 版本太旧，正在更新…');
    expect(hostStatusLabel('update-failed', 'd22', null, NOW, zh)).toBe('d22 上的咕咕 server 版本太旧，更新没成功');
    // 远程隧道的机器(桌面或 server):请更新那台;是 server 的话它空闲时会自动更新
    expect(hostStatusLabel('outdated', 'd22', null, NOW, zh)).toBe('d22 上的咕咕版本太旧，请更新那台机器上的咕咕（咕咕 server 会在空闲时自动更新）');
  });

  it('#6264 新建框选着一台太旧的机器:说「版本太旧，正在更新」,❌「d22 离线」', () => {
    const session: Translate = (key, values = {}) => {
      const template = (zhCNSessionWorkflowMessages as Record<string, string>)[key];
      if (!template) throw new Error(`missing ${key}`);
      return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
    };
    expect(machineUnavailableReason('updating', 'd22', session)).toBe('d22 上的咕咕 server 版本太旧，正在更新。草稿已保留。');
    expect(machineUnavailableReason('update-failed', 'd22', session)).toBe('d22 上的咕咕 server 版本太旧，更新没成功。草稿已保留。');
    expect(machineUnavailableReason('outdated', 'd22', session)).toBe('d22 上的咕咕版本太旧，请更新那台机器上的咕咕（咕咕 server 会在空闲时自动更新）。草稿已保留。');
    expect(machineUnavailableReason('sign-in', 'd22', session)).toBe('要先经 SSH 登录 d22。草稿已保留。');
    expect(machineUnavailableReason('offline', 'd22', session)).toBe('d22 离线。草稿已保留，上线后可发送，或换一台机器。');
  });

  it('上次在线 X 前', () => {
    expect(formatAgo('2026-09-23T11:59:40Z', NOW, zh)).toBe('刚刚');
    expect(formatAgo('2026-09-23T11:15:00Z', NOW, zh)).toBe('45 分钟前');
    expect(formatAgo('2026-09-23T07:00:00Z', NOW, zh)).toBe('5 小时前');
    expect(formatAgo('2026-09-20T12:00:00Z', NOW, zh)).toBe('3 天前');
    expect(formatAgo(null, NOW, zh)).toBeNull();
    expect(formatAgo('garbage', NOW, zh)).toBeNull();
  });

  it('机器状态:离线 > 问不通 > 在读 > 已连接;每一种都有一句提示', () => {
    expect(hostConnectionState({ online: false, loading: true, unreachable: true })).toBe('offline');
    expect(hostConnectionState({ online: true, loading: true, unreachable: true })).toBe('reconnecting');
    expect(hostConnectionState({ online: true, loading: true, unreachable: false })).toBe('connecting');
    expect(hostConnectionState({ online: true, loading: false, unreachable: false })).toBe('connected');
    expect(hostStatusLabel('offline', 'Linux 1', '2026-09-23T10:00:00Z', NOW, zh)).toBe('Linux 1 离线 · 上次在线 2 小时前');
    expect(hostStatusLabel('reconnecting', 'Linux 1', null, NOW, zh)).toBe('正在重新连接 Linux 1…');
    expect(hostStatusLabel('connecting', 'Linux 1', null, NOW, zh)).toBe('正在连接 Linux 1…');
    expect(hostStatusLabel('connected', 'Linux 1', null, NOW, zh)).toBe('已连接 Linux 1');
  });

  it('聊天末尾那一行:离线说上次在线、不给按钮;断线给倒计时 + 立即重连;连着 / 第一次连不说话', () => {
    const base = { device: 'Linux 1', online: true, lastSeenAt: null, errorCode: null, now: NOW, translate: zh };
    expect(chatLinkRow({ ...base, online: false, lastSeenAt: '2026-09-23T11:00:00Z', phase: { kind: 'connected' } })).toEqual({
      label: 'Linux 1 离线 · 上次在线 1 小时前，上线后自动恢复',
      action: null,
    });
    expect(chatLinkRow({ ...base, phase: { kind: 'waiting', attempt: 2, retryAt: NOW + 4_200 } })).toEqual({
      label: '与 Linux 1 断开，5 秒后重连',
      action: { label: '立即重连', kind: 'reconnect-now' },
    });
    expect(chatLinkRow({ ...base, phase: { kind: 'connecting', attempt: 3 } })?.label).toBe('正在重新连接 Linux 1…');
    expect(chatLinkRow({ ...base, phase: { kind: 'connecting', attempt: 0 } })).toBeNull();
    expect(chatLinkRow({ ...base, phase: { kind: 'connected' } })).toBeNull();
  });

  it('放弃之后:说清为什么;太旧那一句写明空闲时会自动更新', () => {
    const base = { device: 'Linux 1', online: true, lastSeenAt: null, now: NOW, translate: zh, phase: { kind: 'gave-up' } as const };
    const tooOld = chatLinkRow({ ...base, errorCode: 'unknown_method' });
    expect(tooOld?.label).toBe('Linux 1 上的咕咕版本太旧，请更新那台机器上的咕咕（咕咕 server 会在空闲时自动更新）');
    expect(tooOld?.action).toEqual({ label: '重新连接', kind: 'reconnect' });
    expect(chatLinkRow({ ...base, errorCode: null })?.label).toBe('连不上 Linux 1，已停止重连');
    expect(isRetryableRemoteError('unknown_method')).toBe(false);
    expect(isRetryableRemoteError(null)).toBe(true);
    expect(isRetryableRemoteError('timeline_failed')).toBe(true);
  });

  it('#6264 离线的原因是登录没了:侧栏与聊天末尾都说清、指去重新登录;问不到时照旧只说离线', () => {
    expect(hostStatusLabel('offline', 'lab', '2026-09-23T11:00:00Z', NOW, zh, '2026-09-23T10:00:00Z')).toMatch(/lab 上的登录已失效.*重新登录/);
    expect(hostStatusLabel('offline', 'lab', '2026-09-23T11:00:00Z', NOW, zh, null)).toMatch(/登录已失效/);
    expect(hostStatusLabel('offline', 'lab', '2026-09-23T11:00:00Z', NOW, zh)).toMatch(/离线/);
    const row = chatLinkRow({
      device: 'lab', online: false, lastSeenAt: null, signInExpiredAt: '2026-09-23T10:00:00Z',
      phase: { kind: 'connected' } as never, errorCode: null, now: NOW, translate: zh,
    });
    expect(row?.label).toMatch(/登录已失效.*会话已暂停.*重新登录/);
  });
});

describe('machineNoticeLabel(#6264 那台机器连得上,但有件事会让操作失败)', () => {
  it('按要紧程度只说第一件;磁盘余量写成人读得懂的大小', () => {
    expect(machineNoticeLabel([{ kind: 'disk-low', freeBytes: 312 * 1024 * 1024 }], 'Linux 1', zh)).toBe(
      'Linux 1 磁盘只剩 312 MB，保存和更新可能失败'
    );
    expect(machineNoticeLabel([{ kind: 'desktop-too-old' }, { kind: 'disk-low', freeBytes: 1 }], 'Linux 1', zh)).toContain('更新这台电脑上的咕咕');
  });

  it('升级被退回已经自愈,只在设备行告知;没有事就不说', () => {
    expect(machineNoticeLabel([{ kind: 'rolled-back', version: 'b', restored: 'a' }], 'Linux 1', zh)).toBeNull();
    expect(machineNoticeLabel([], 'Linux 1', zh)).toBeNull();
    expect(machineNoticeLabel(undefined, 'Linux 1', zh)).toBeNull();
  });

  it('#6264 远程 SSH 要先登录:侧栏、聊天末尾那一行同一个说法,❌ 说「重连中」', () => {
    expect(hostConnectionState({ online: false, loading: false, unreachable: true, sshLink: 'signInRequired' })).toBe('sign-in');
    expect(hostConnectionState({ online: true, loading: false, unreachable: false, sshLink: 'unreachable' })).toBe('reconnecting');
    expect(hostStatusLabel('sign-in', 'Linux 1', null, NOW, zh)).toBe('要先经 SSH 登录 Linux 1');
    expect(
      chatLinkRow({ device: 'Linux 1', online: false, lastSeenAt: null, phase: { kind: 'waiting', attempt: 1, retryAt: NOW }, errorCode: null, now: NOW, translate: zh, signInRequired: true }),
    ).toEqual({ label: '要先经 SSH 登录「Linux 1」。', action: { label: '登录', kind: 'sign-in' } });
  });
});
