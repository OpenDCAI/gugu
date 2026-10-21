// #6264 一套工作台:「在别的机器上新建」的那一截。会话页新建页与对话页创建草稿共用这一份 ——
// 那台机器上的项目就是项目表里那台机器名下的项目;选了一个还不是项目的文件夹,就在那台机器上把它加成
// 项目(与本机「打开文件夹」同一步);没选文件夹 = 那台机器的主目录项目「~」(behavior gugu-server:别的机器上的
// 会话一律属于那台机器上的某个项目;已有同路径项目就复用,没有就建)。输入框、agent 选择、
// 发送都是本机那一套,只是数据问那台机器(LibraryHost + rpc 按实体所在机器路由)。
import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactElement } from 'react';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { cloudWakeFailureText, machineBlockIsStatus, machineUnavailableReason, TOO_OLD_CODES } from '@renderer/features/remote-hosts/connection-status';
import { remoteErrorCode } from '@renderer/features/remote-hosts/remote-failure-copy';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { localMachineChoice, machineChoiceFromHost, type MachineChoice } from '@renderer/features/remote-hosts/machine-choice';
import { machineLibraryHost, type LibraryHost } from '@renderer/features/library/library-host';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { ComposerRemoteProjectPicker } from './composer-context-tray';
import { ImplicitSessionHomeProjectError } from './implicit-session-home-project';
import { isImplicitSessionHomeProject } from './session-home-project-constants';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

/**
 * 隐藏工作区失败的展示边界:稳定语义码映射成本地化外壳,未知错误保留可诊断的原文作为 detail。
 */
export function describeImplicitProjectFailure(failure: unknown, translate: Translate): string {
  if (failure instanceof ImplicitSessionHomeProjectError) {
    switch (failure.reason) {
      case 'unavailable':
        return translate('task.homeProjectUnavailable');
      case 'pending':
        return translate('task.homeProjectPending');
      case 'create-failed':
        return translate('task.homeProjectCreateFailed');
      case 'open-failed':
        return failure.detail
          ? translate('task.homeProjectOpenFailedDetail', { detail: failure.detail })
          : translate('task.homeProjectOpenFailed');
    }
  }
  return translate('task.homeProjectFailed', {
    detail: failure instanceof Error ? failure.message : String(failure)
  });
}

/**
 * 在别的机器上准备项目失败:线上的事(那台机器的咕咕 server 太旧 / 此刻问不到)说成人话,
 * ❌ 把传输层的原文(英文的「连接已断开」之类)摆给人;那台机器自己答的失败照旧走上面那条。
 */
export function describeMachineProjectFailure(failure: unknown, device: string, translate: Translate): string {
  if (failure instanceof ImplicitSessionHomeProjectError) return describeImplicitProjectFailure(failure, translate);
  const code = remoteErrorCode(failure);
  if (code && TOO_OLD_CODES.has(code)) return translate('deviceScope.serverTooOld', { device });
  if (!code) return translate('deviceScope.unreachable', { device });
  return describeImplicitProjectFailure(failure, translate);
}

export type MachineCreateTarget = {
  deviceId: string;
  projectPath: string | null;
  /** 已经知道是哪个项目(项目页):直接用它,不再按路径找。 */
  projectId?: string;
};

/**
 * 那台机器上的这个文件夹对应的项目 id:已是项目就用它;还不是就在那台机器上把它加成项目;
 * 没选文件夹 = 那台机器的主目录项目「~」。
 */
export function resolveMachineProject(target: MachineCreateTarget): Promise<string> {
  if (target.projectId) return Promise.resolve(target.projectId);
  const existing = target.projectPath ? machineProjects(target.deviceId).find((p) => p.path === target.projectPath) : null;
  if (existing) return Promise.resolve(existing.id);
  return target.projectPath
    ? remoteHostsStore.ensureProject(target.deviceId, target.projectPath)
    : remoteHostsStore.ensureHomeProject(target.deviceId);
}

export type MachineCreateContext = {
  /** 那台机器上的项目 id(解析中 / 失败时为 undefined)。 */
  projectId: string | undefined;
  blockReason: string | null;
  /** blockReason 只是在说云电脑此刻的状态(休眠中 / 正在唤醒):照样挡发送,画成说明 ❌ 报错。 */
  blockIsStatus: boolean;
  isContextPending: boolean;
  host: LibraryHost;
  machine: { deviceId: string; label: string };
};

/** 所选机器上的项目、阻塞原因与数据宿主。`target` 为 null(本机)时返回 null。 */
export function useMachineCreateContext(target: MachineCreateTarget | null): MachineCreateContext | null {
  const { translate } = useSessionMessages();
  const device = target ? remoteHostsStore.device(target.deviceId) : null;
  const connection = target ? remoteHostsStore.connectionState(target.deviceId) : null;
  const connected = connection === 'connected';
  // #7199 选了一台睡着的云电脑做目标 ❌ 当场叫醒:新建框里开始输入才叫(useWakeCloudOnInput,看一眼不该扣积分);
  // 醒了线自己连上、项目照常解析、发送键自己亮;草稿一直留着。
  const [resolved, setResolved] = useState<{ key: string; id: string | null; failure: unknown } | null>(null);
  const key = target ? `${target.deviceId}|${target.projectPath ?? ''}|${target.projectId ?? ''}` : null;
  useEffect(() => {
    if (!target || !key || !connected) return;
    let cancelled = false;
    void resolveMachineProject(target).then(
      (id) => {
        if (cancelled) return;
        setResolved({ key, id: id ?? null, failure: id ? null : new ImplicitSessionHomeProjectError('unavailable') });
        if (id && target.projectPath) remoteHostsStore.rememberRecentFolder(target.deviceId, target.projectPath);
      },
      (failure: unknown) => {
        if (!cancelled) setResolved({ key, id: null, failure });
      }
    );
    return () => {
      cancelled = true;
    };
    // 按「哪台机器、哪个文件夹、连没连上」重解。
  }, [key, connected]);
  if (!target) return null;
  const current = resolved && resolved.key === key ? resolved : null;
  const label = device?.label ?? target.deviceId;
  const projectError = current?.failure ? describeMachineProjectFailure(current.failure, label, translate) : null;
  return {
    projectId: current?.id ?? undefined,
    // 选着的机器掉线了:说出来,但输入框照旧可写、写好的内容留着(不重挂),它一回来发送键自己亮。
    blockReason: !connected ? machineUnavailableReason(connection, device?.label ?? null, translate, wakeFailureLine(target.deviceId, label, translate)) : projectError,
    blockIsStatus: !connected && machineBlockIsStatus(connection),
    isContextPending: connected && !current?.id && !projectError,
    host: machineLibraryHost({
      deviceId: target.deviceId,
      deviceLabel: label,
      online: connected,
      lastSeenAt: device?.lastSeenAt ?? null,
      hostKind: device?.hostKind,
    }),
    machine: { deviceId: target.deviceId, label },
  };
}

/**
 * 对话页创建草稿(composer-embed-root):宿主报来的设备行 → 机器选择器的行,与新建任务、导入、资源库同一个样子 ——
 * 这台电脑叫「本机」,别的机器带连法与连接状况(❌ 本机那行写设备名,macOS 上常常是个 IP);
 * 所选那台不是本机时,还给出它的创建目标(宿主记着的是那台机器上的目录路径)。须在 observer 组件里调用。
 */
export function useComposerMachines(
  devices: readonly MachineChoice[],
  selectedDeviceId: string | null,
  projectPath: string | null,
  localProjectPicker: ReactElement,
  onSelectPath: (path: string | null) => void
): { machines: MachineChoice[]; machineContext: MachineCreateContext | null; projectPicker: ReactElement } {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const machines = devices.map((device) => {
    if (device.isLocal) return localMachineChoice(device.id, translate('task.deviceLocal'));
    const host = remoteHostsStore.device(device.id);
    return host ? machineChoiceFromHost(host, remoteHostsStore.connectionState(device.id)) : device;
  });
  const selected = devices.find((device) => device.id === selectedDeviceId);
  const target = selected && !selected.isLocal ? { deviceId: selected.id, projectPath } : null;
  const projectPicker = target ? <MachineProjectPicker target={target} onSelect={onSelectPath} /> : localProjectPicker;
  return { machines, machineContext: useMachineCreateContext(target), projectPicker };
}

/** #7199 叫醒那台云电脑没成时,新建框里那一句(积分用完 / 等满了 / 管家原话);没在叫 / 叫醒了 = null。 */
function wakeFailureLine(deviceId: string, label: string, translate: Translate): string | null {
  const failure = remoteHostsStore.wakeFailure(deviceId);
  return failure ? cloudWakeFailureText(failure, label, translate) : null;
}

/** 新建框在所选机器上的那几项;本机(`context` 为 null)时用本机的,宿主自己的阻塞原因优先。 */
export function machineComposerProps(
  context: MachineCreateContext | null,
  local: { projectId: string | undefined; blockReason?: string | null; isContextPending?: boolean }
) {
  const localBlock = local.blockReason ?? null;
  return {
    projectId: context ? context.projectId : local.projectId,
    blockReason: localBlock ?? context?.blockReason ?? null,
    // 宿主自己的原因(默认值读不到等)是报错;只有那台云电脑的休眠中 / 正在唤醒画成说明。
    blockIsStatus: localBlock === null && (context?.blockIsStatus ?? false),
    isContextPending: Boolean(local.isContextPending) || (context?.isContextPending ?? false),
    machine: context?.machine ?? null,
  };
}

function machineProjects(deviceId: string): { id: string; name: string; path: string }[] {
  return [...getProjectManagerStore().projects.values()]
    .filter((project) => project.data && !isImplicitSessionHomeProject(project) && machineRegistry.machineOf(project.id) === deviceId)
    .map((project) => ({ id: project.id, name: project.name ?? '', path: project.data?.path ?? '' }));
}

/** 那台机器上的项目 / 最近文件夹 / 浏览。 */
export const MachineProjectPicker = observer(function MachineProjectPicker({
  target,
  onSelect,
}: {
  target: MachineCreateTarget;
  onSelect: (path: string | null) => void;
}): ReactElement {
  const connected = remoteHostsStore.connectionState(target.deviceId) === 'connected';
  return (
    <ComposerRemoteProjectPicker
      selectedPath={target.projectPath}
      homePath={remoteHostsStore.homeDir(target.deviceId)}
      projects={machineProjects(target.deviceId)}
      recentPaths={remoteHostsStore.recentFolders(target.deviceId)}
      loading={false}
      offline={!connected}
      onSelect={onSelect}
      machine={{
        deviceId: target.deviceId,
        label: remoteHostsStore.device(target.deviceId)?.label ?? target.deviceId,
        browseFrom: target.projectPath ?? '~',
      }}
    />
  );
});
