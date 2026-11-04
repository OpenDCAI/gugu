// #6264 机器选择器里的「一行」:本机 / 名下别的机器怎么换算成选择器的一行、怎么排、名字后面那段淡色字写什么。
// 纯数据,不带 React —— 各入口(资源库、已安排、设置、导入会话、新建框)同一份换算,组件在 machine-picker.tsx。
import { detectPlatform } from '@tanstack/react-hotkeys';
import { formatRelativeTime } from '@/i18n/format';
import type { HostConnectionState, Translate } from '@renderer/features/remote-hosts/connection-status';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';

export interface MachineChoice {
  id: string;
  label: string;
  isLocal: boolean;
  isOnline: boolean;
  /**
   * 心跳说在线,但此刻问它问不通(侧栏那颗点是「重连中」)。仍可选 —— 多半会自己好 —— 只是如实标出来,
   * ❌ 与侧栏说法不一致(侧栏写「没有应答」、这里还写「在线」)。
   */
  notResponding?: boolean;
  /** #6264 远程 SSH 的机器要先登录(侧栏那颗点是「要先登录」)。 */
  needsSignIn?: boolean;
  /** #6264 那台机器的咕咕 server 太旧:正在替它更新 / 没更新成 / 空闲时自己更新(与侧栏同一个判据)。 */
  outdated?: 'updating' | 'failed' | 'idle';
  /** 那台机器报的系统(`linux` / `darwin` / `win32`…);缺席 = 不标。 */
  platform?: string | null;
  /** 最后一次心跳(ISO);离线的那几台据此写「离线 · X 前」、按新近排。 */
  lastSeenAt?: string | null;
  /** 电脑(本机、另一台咕咕桌面)、服务器(咕咕 server)还是云电脑(#7199,平台托管的咕咕 server)。缺席 = 电脑。 */
  kind?: 'computer' | 'server' | 'cloudComputer';
  /**
   * #7199 云电脑此刻没醒着:休眠中 / 正在唤醒 / 叫醒没成。❌ 按离线处理 —— 照常可选,选了先叫醒它。醒着 = 缺席(照在线说)。
   */
  cloudComputer?: 'asleep' | 'waking' | 'wake-failed';
  /** 怎么添加的:远程 SSH(这台或别的桌面用 SSH 装上的)/ 远程隧道(只经咕咕云)。缺席 = 不标。 */
  link?: 'ssh' | 'tunnel' | null;
  /**
   * 这台机器上能开哪几种会话的一句话说明。只挂在悬停提示上,❌ 不常驻成一行字。
   */
  hint?: string | null;
}

/** 这一行此刻接不接活:本机、在线的,或没醒着的云电脑(选了先叫醒)。 */
export function machineAcceptsWork(machine: Pick<MachineChoice, 'isLocal' | 'isOnline' | 'cloudComputer'>): boolean {
  return machine.isLocal || machine.isOnline || machine.cloudComputer !== undefined;
}

/** 「本机」那一行。系统取这台电脑自己的。 */
export function localMachineChoice(id: string, label: string): MachineChoice {
  return { id, label, isLocal: true, isOnline: true, kind: 'computer', platform: localPlatform() };
}

function localPlatform(): string | null {
  try {
    return detectPlatform();
  } catch {
    return null;
  }
}

/** 名下别的一台机器 → 选择器里的一行。各处(资源库、已安排、设置、导入、新建框)同一份换算。 */
export function machineChoiceFromHost(
  device: RemoteHostDevice,
  connection: HostConnectionState | null,
  hint?: string | null
): MachineChoice {
  return {
    id: device.id,
    label: device.label,
    isLocal: false,
    isOnline: device.isOnline,
    notResponding: connection === 'reconnecting',
    ...(connection === 'sign-in' ? { needsSignIn: true } : {}),
    ...(connection === 'updating'
      ? { outdated: 'updating' as const }
      : connection === 'update-failed'
        ? { outdated: 'failed' as const }
        : connection === 'outdated'
          ? { outdated: 'idle' as const }
          : {}),
    // 云电脑没醒着:连接状态说得最全(含这一端叫醒没成);调用方没给连接状态时,照设备行上管家说的。
    ...(connection === 'asleep' || connection === 'waking' || connection === 'wake-failed'
      ? { cloudComputer: connection }
      : device.cloudComputer === 'asleep' || device.cloudComputer === 'waking'
        ? { cloudComputer: device.cloudComputer }
        : {}),
    platform: device.platform,
    lastSeenAt: device.lastSeenAt,
    // 老宿主不报种类 = 老的咕咕桌面(咕咕 server 从第一版起就报)。云电脑也是 server,但它是平台开的那一台,单说。
    kind: device.cloudComputer ? 'cloudComputer' : device.hostKind === 'server' ? 'server' : 'computer',
    // 云电脑 ❌ 标连法:它不是「添加一台机器」加进来的。
    link: device.cloudComputer
      ? null
      : (device.directTerminal && !device.viaTunnel) || device.connectVia === 'ssh' ? 'ssh' : device.hostKind === 'server' ? 'tunnel' : null,
    hint: hint ?? null,
  };
}

/**
 * 机器列表的顺序:本机第一,然后在线的(按名字),最后离线的
 * (最近在线的在前)。离线的照样列着 —— ❌ 不从列表里消失,用户要知道它还在名下。
 */
export function orderMachines(machines: readonly MachineChoice[]): MachineChoice[] {
  // 休眠中的云电脑排在在线那一组(休眠中 ≠ 离线)。
  const rank = (m: MachineChoice) => (m.isLocal ? 0 : m.isOnline || m.cloudComputer ? 1 : 2);
  const seen = (m: MachineChoice) => {
    const ms = m.lastSeenAt ? Date.parse(m.lastSeenAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...machines].sort(
    (a, b) => rank(a) - rank(b) || (rank(a) === 2 ? seen(b) - seen(a) : 0) || a.label.localeCompare(b.label)
  );
}

/** 系统名是产品名(macOS / Linux / Windows),不随语言翻译;认不出的不标。 */
export function platformHint(platform: string | null | undefined): string | null {
  const p = (platform ?? '').toLowerCase();
  if (!p) return null;
  if (p.includes('darwin') || p.includes('mac')) return 'macOS';
  if (p.includes('win')) return 'Windows';
  if (p.includes('linux')) return 'Linux';
  return null;
}

/**
 * 名字后面那一小段淡色字。离线 → 「离线 · X 前」;问不通 → 「没有应答」;否则系统,
 * 菜单里再带上连法(「Linux · 远程 SSH」)。颜色之外总有这段字 ⇒ ❌ 只靠点的颜色表达离线。
 */
export function machineMeta(
  machine: MachineChoice,
  translate: Translate,
  { withLink = false, nowMs }: { withLink?: boolean; nowMs?: number } = {}
): string | null {
  if (machine.needsSignIn) return translate('machinePicker.needsSignIn');
  if (machine.outdated === 'updating') return translate('machinePicker.updating');
  if (machine.outdated) return translate('machinePicker.tooOld');
  if (machine.cloudComputer === 'asleep') return translate('machinePicker.asleep');
  if (machine.cloudComputer === 'waking') return translate('machinePicker.waking');
  if (machine.cloudComputer === 'wake-failed') return translate('machinePicker.wakeFailed');
  if (!machine.isLocal && !machine.isOnline) {
    const ago = machine.lastSeenAt ? formatRelativeTime(machine.lastSeenAt, { mode: 'elapsed', nowMs }) : null;
    return ago ? translate('machinePicker.offlineSince', { time: ago }) : translate('machinePicker.offline');
  }
  if (machine.notResponding) return translate('machinePicker.notResponding');
  const parts = [platformHint(machine.platform)];
  if (withLink && machine.link) {
    parts.push(translate(machine.link === 'ssh' ? 'machinePicker.linkSsh' : 'machinePicker.linkTunnel'));
  }
  const text = parts.filter(Boolean).join(' · ');
  return text || null;
}
