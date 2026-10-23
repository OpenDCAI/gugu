// #7199 会话页里的云电脑:在休息 ≠ 离线 —— 侧栏那颗点、机器选择器那一行、新建框那一句、分机器模块那一句、
// 导入会话那一格,以及叫醒没成时说的话。判据用真文案表(人会读到的那句)。说到它用的是它本人的名字(「小咕」):
// 宿主那一侧把个人助理住的那台的 label 换成了它的名字(owner 10-15 用户看不到它住在哪,useRemoteHostsBridge)。
import { describe, expect, it } from 'vitest';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import { zhCNRemoteHostMessages } from '@renderer/localization/messages-remote-hosts';
import { zhCNSessionWorkflowMessages } from '@renderer/localization/messages-session-workflows';
import { importDeviceState } from '@renderer/features/session-import/import-device';
import {
  cloudWakeFailureText,
  hostConnectionState,
  hostStatusLabel,
  machineBlockIsStatus,
  machineUnavailableReason,
  type Translate,
} from './connection-status';
import { machineComposerProps, type MachineCreateContext } from '@renderer/features/sessions/use-machine-create-target';
import { deviceScopeNotice } from './device-scope-notice';
import { machineAcceptsWork, machineChoiceFromHost, machineMeta, orderMachines } from './machine-choice';
import { machineConnectionState } from './remote-hosts-store';
import { remoteToolReach } from './workspace/remote-workspace-routing';

const zh: Translate = (key, values = {}) => {
  const template =
    (zhCNRemoteHostMessages as Record<string, string>)[key] ?? (zhCNSessionWorkflowMessages as Record<string, string>)[key];
  if (!template) throw new Error(`missing ${key}`);
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

const NOW = Date.parse('2026-10-15T05:00:00Z');

const cloud = (patch: Partial<RemoteHostDevice> = {}): RemoteHostDevice => ({
  id: 'cloud',
  label: '小咕',
  isOnline: false,
  platform: 'linux',
  lastSeenAt: '2026-10-15T04:00:00Z',
  sessionDigest: null,
  directTerminal: false,
  hostKind: 'server',
  connectVia: 'tunnel',
  cloudComputer: 'asleep',
  ...patch,
});

describe('侧栏那颗点 / 悬停那句', () => {
  it('睡着 = asleep,❌ offline;正在醒 = waking;叫醒没成 = wake-failed', () => {
    expect(hostConnectionState({ online: false, loading: false, unreachable: false, cloudComputer: 'asleep' })).toBe('asleep');
    expect(hostConnectionState({ online: false, loading: false, unreachable: false, cloudComputer: 'waking' })).toBe('waking');
    expect(hostConnectionState({ online: false, loading: false, unreachable: false, cloudComputer: 'asleep', wake: 'waking' })).toBe('waking');
    expect(hostConnectionState({ online: false, loading: false, unreachable: false, cloudComputer: 'asleep', wake: 'failed' })).toBe('wake-failed');
    // 对照:不是云电脑的离线机器照旧是 offline。
    expect(hostConnectionState({ online: false, loading: false, unreachable: false })).toBe('offline');
  });

  it('这一端叫醒没成、它却在别处被叫醒了:照管家说的「正在醒」,❌ 一直「没能唤醒」', () => {
    expect(hostConnectionState({ online: false, loading: false, unreachable: false, cloudComputer: 'waking', wake: 'failed' })).toBe('waking');
  });

  it('醒着的云电脑照普通在线机器说(连上了 = connected)', () => {
    expect(hostConnectionState({ online: true, loading: false, unreachable: false, cloudComputer: 'awake', wake: 'failed' })).toBe('connected');
  });

  it('悬停那句不说离线', () => {
    expect(hostStatusLabel('asleep', '小咕', null, NOW, zh)).toBe('小咕 在休息，有事会自动醒');
    expect(hostStatusLabel('waking', '小咕', null, NOW, zh)).toBe('小咕 正在醒来…');
  });

  it('store 的判据把这一端的叫醒状态并进来', () => {
    const state = { device: cloud(), link: 'closed' as const, synced: false };
    expect(machineConnectionState(state)).toBe('asleep');
    expect(machineConnectionState(state, 'waking')).toBe('waking');
    expect(machineConnectionState(state, 'failed')).toBe('wake-failed');
    // 不是云电脑:叫醒状态不算数。
    expect(machineConnectionState({ ...state, device: cloud({ cloudComputer: undefined }) }, 'failed')).toBe('offline');
  });
});

describe('机器选择器那一行', () => {
  it('睡着的云电脑:能选、写「休息中」、云图标那一类、不标连法', () => {
    const choice = machineChoiceFromHost(cloud(), 'asleep');
    expect(choice).toMatchObject({ kind: 'cloudComputer', cloudComputer: 'asleep', link: null });
    expect(machineAcceptsWork(choice)).toBe(true);
    expect(machineMeta(choice, zh)).toBe('休息中');
    expect(machineMeta(machineChoiceFromHost(cloud(), 'waking'), zh)).toBe('正在醒来…');
  });

  it('调用方没给连接状态时照设备行上管家说的', () => {
    expect(machineChoiceFromHost(cloud(), null).cloudComputer).toBe('asleep');
  });

  it('排在在线那一组;离线的普通机器在后', () => {
    const ordered = orderMachines([
      machineChoiceFromHost(cloud({ id: 'z-offline', label: 'z-offline', cloudComputer: undefined }), 'offline'),
      machineChoiceFromHost(cloud({ id: 'a-cloud', label: 'a-cloud' }), 'asleep'),
    ]);
    expect(ordered.map((m) => m.id)).toEqual(['a-cloud', 'z-offline']);
  });
});

describe('新建框那一句', () => {
  it('睡着:开始输入就叫醒它;正在醒:醒了就能发送、草稿留着;❌ 说离线', () => {
    expect(machineUnavailableReason('asleep', '小咕', zh)).toBe('小咕 在休息，开始输入就会叫醒它。');
    expect(machineUnavailableReason('waking', '小咕', zh)).toBe('小咕 正在醒来，醒了就能发送。草稿已保留。');
  });
  it('说真实原因:登录没了说重新登录、正在连说正在连,❌ 一律「离线」', () => {
    expect(machineUnavailableReason('offline', 'd22', zh, null, '2026-10-22T00:00:00Z')).toBe('d22 上的登录已失效，请在 设置 → 设备 中重新登录。');
    expect(machineUnavailableReason('connecting', 'd22', zh)).toBe('正在连接 d22…');
    expect(machineUnavailableReason('reconnecting', 'd22', zh)).toBe('正在重新连接 d22…');
    // 对照:只是离线。
    expect(machineUnavailableReason('offline', 'd22', zh)).toBe('d22 离线。草稿已保留，上线后可发送，或换一台机器。');
  });
  it('叫醒没成:说那句原因', () => {
    expect(machineUnavailableReason('wake-failed', '小咕', zh, '积分已用完，小咕 醒不来。')).toBe('积分已用完，小咕 醒不来。');
  });
  // 统筹 10-15:「休眠中」只是说明状态,❌ 报错的红字;与私聊里那句同一个样子。owner 10-22:离线同样只是状态(#113)。
  // 叫醒没成、要先登录、版本太旧照旧是报错。
  it('休眠中 / 正在唤醒 / 离线 / 正在连是说明,别的用不了照旧是报错', () => {
    for (const state of ['asleep', 'waking', 'offline', 'connecting', 'reconnecting'] as const) {
      expect(machineBlockIsStatus(state)).toBe(true);
    }
    for (const state of ['wake-failed', 'outdated', 'updating', 'update-failed', 'sign-in', 'connected', null] as const) {
      expect(machineBlockIsStatus(state)).toBe(false);
    }
    // 离线是因为那台机器上的登录没了:要人去重新登录,照旧是报错(登出时间不明 = null 也算)。
    expect(machineBlockIsStatus('offline', '2026-10-22T00:00:00Z')).toBe(false);
    expect(machineBlockIsStatus('offline', null)).toBe(false);
    expect(machineBlockIsStatus('offline', undefined)).toBe(true);
  });
  it('宿主自己的原因(默认值读不到)压过云电脑那句时,画成报错', () => {
    const context = { projectId: undefined, blockReason: '小咕 在休息，开始输入就会叫醒它。', blockIsStatus: true, isContextPending: false, machine: { deviceId: 'cloud', label: '小咕' } } as unknown as MachineCreateContext;
    expect(machineComposerProps(context, { projectId: undefined })).toMatchObject({ blockReason: context.blockReason, blockIsStatus: true });
    expect(machineComposerProps(context, { projectId: undefined, blockReason: '读不到默认设置' })).toMatchObject({ blockReason: '读不到默认设置', blockIsStatus: false });
    expect(machineComposerProps(null, { projectId: 'p1' })).toMatchObject({ blockReason: null, blockIsStatus: false });
  });
});

describe('叫醒没成时说的话', () => {
  it('只说是哪一类,❌ 把管家原话 / 异常原文端给人', () => {
    expect(cloudWakeFailureText({ reason: 'refused', code: 'credits_exhausted' }, '小咕', zh)).toBe('积分已用完，小咕 醒不来。');
    expect(cloudWakeFailureText({ reason: 'timeout', code: null }, '小咕', zh)).toBe('小咕 两分钟内没醒来，稍后再试。');
    expect(cloudWakeFailureText({ reason: 'failed', code: 'network' }, '小咕', zh)).toBe('连不上服务，小咕 醒不来。检查一下网络。');
    expect(cloudWakeFailureText({ reason: 'failed', code: 'unauthorized' }, '小咕', zh)).toBe('登录已失效，重新登录后再试。');
    expect(cloudWakeFailureText({ reason: 'failed', code: 'not_found' }, '小咕', zh)).toBe('小咕 已经不在了。');
    expect(cloudWakeFailureText({ reason: 'failed', code: null }, '小咕', zh)).toBe('没能叫醒 小咕，那边出了问题，稍后再试。');
  });
});

describe('分机器的模块那一句 / 导入会话 / 工作区', () => {
  const remote = { deviceLabel: '小咕', online: false, lastSeenAt: '2026-10-15T04:00:00Z' };

  it('资源库这类页面:说正在唤醒(只读到醒),❌ 说离线', () => {
    const notice = deviceScopeNotice({ remote, error: null, hasData: true, now: NOW, cloud: { state: 'asleep', failure: null } }, zh);
    expect(notice).toEqual({ kind: 'waking', text: '「小咕」正在醒来。显示的是缓存，醒了就能修改。', retry: false, readOnly: true });
    const failed = deviceScopeNotice(
      { remote, error: null, hasData: false, now: NOW, cloud: { state: 'wake-failed', failure: { reason: 'timeout', code: null, message: 'x' } } },
      zh
    );
    expect(failed?.text).toBe('小咕 两分钟内没醒来，稍后再试。');
    // 对照:不是云电脑照旧说离线。
    expect(deviceScopeNotice({ remote, error: null, hasData: true, now: NOW }, zh)?.kind).toBe('offline');
  });

  it('导入会话:选了睡着的云电脑 = 在叫醒它,❌ 挡成离线', () => {
    const choice = machineChoiceFromHost(cloud(), 'asleep');
    expect(importDeviceState('cloud', [choice]).blocked).toBe('waking');
    expect(importDeviceState('cloud', [machineChoiceFromHost(cloud({ cloudComputer: undefined }), null)]).blocked).toBe('offline');
  });

  it('工作区的文件 / 审阅:说正在唤醒', () => {
    expect(remoteToolReach(cloud(), NOW, zh)).toEqual({ ok: false, label: '小咕 正在醒来…' });
  });
});
