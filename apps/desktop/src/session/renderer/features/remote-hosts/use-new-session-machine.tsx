// #6264「会话页里的别的机器」(按 Zed):「在哪台机器上跑」是这一条会话的属性,❌ 整页的「当前机器」。
// 新建页托盘里原来那枚常驻的「本机」标签,现在就是这台机器的选择器 —— 选了别的机器,项目换成那台机器上的
// 目录,发送在那台机器上开会话、建完进会话页里那条会话。侧栏远端项目行上的「+」带着机器与目录进来。
// 须在 observer 组件里调用:机器上线/离线/改名时跟着重画(列表很短,不必 memo)。
import { useEffect, useState, type ReactElement } from 'react';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { localMachineChoice, machineChoiceFromHost, type MachineChoice } from './machine-choice';
import { MachinePicker } from './machine-picker';
import { remoteHostsStore } from './remote-hosts-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import {
  MachineProjectPicker,
  useMachineCreateContext,
  type MachineCreateContext,
} from '@renderer/features/sessions/use-machine-create-target';

/** 设备选择器里「本机」那一行的 id(本机不在 remoteHostsStore 里)。 */
const LOCAL_DEVICE = 'local';

export type NewSessionMachineTarget = { deviceId: string; projectPath: string | null };

/** `localProjectPicker`:选着本机时托盘里的项目选择器;选了别的机器就换成那台机器上的项目 / 目录。 */
export function useNewSessionMachine(localProjectPicker: ReactElement): {
  /** null = 本机。 */
  remote: NewSessionMachineTarget | null;
  machineContext: MachineCreateContext | null;
  devicePicker: ReactElement;
  projectPicker: ReactElement;
} {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const [remote, setRemote] = useState<NewSessionMachineTarget | null>(() => remoteHostsStore.takeNewSessionTarget());
  // 已经停在新建页时又来一次「在那台机器上新建」(侧栏远端项目的「+」、设置里装好机器后的「在这台机器上新建任务」):
  // 上面的初值只在挂载时取一次,之后来的意图在这里接住,❌ 点了之后新建页还停在原来那台机器上。
  const pendingTarget = remoteHostsStore.newSessionTarget;
  useEffect(() => {
    if (!pendingTarget) return;
    const target = remoteHostsStore.takeNewSessionTarget();
    if (target) setRemote(target);
  }, [pendingTarget]);
  // 顺序(本机 → 在线 → 离线)由选择器自己排(orderMachines),各入口同一份。
  const devices: MachineChoice[] = [
    localMachineChoice(LOCAL_DEVICE, translate('task.deviceLocal')),
    ...remoteHostsStore.pickableMachineIds().map(id => remoteChoice(id, translate)),
  ];
  const devicePicker = (
    <MachinePicker
      size="compact"
      testId="composer-device-picker"
      wakeOnPick="retry"
      machines={devices}
      selectedId={remote?.deviceId ?? LOCAL_DEVICE}
      // 换机器 = 换一个创建目标:目录不跨机器带(那台机器上不一定有同一个路径)。
      onSelect={(deviceId) => setRemote(deviceId === LOCAL_DEVICE ? null : { deviceId, projectPath: null })}
      onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
    />
  );
  const projectPicker = remote ? (
    <MachineProjectPicker target={remote} onSelect={(path) => setRemote({ deviceId: remote.deviceId, projectPath: path })} />
  ) : (
    localProjectPicker
  );
  return { remote, machineContext: useMachineCreateContext(remote), devicePicker, projectPicker };
}

type Translate = ReturnType<typeof useSessionMessages>['translate'];

function remoteChoice(deviceId: string, translate: Translate): MachineChoice {
  const device = remoteHostsStore.device(deviceId);
  // 名下已经没有这台机器(被移除):照样显示它的 id、按离线画,❌ 冒充本机。
  if (!device) return { id: deviceId, label: deviceId, isLocal: false, isOnline: false };
  return machineChoiceFromHost(
    device,
    remoteHostsStore.connectionState(deviceId),
    // 通用 / 编程在这台机器上能不能开,悬停时说一句(behavior gugu-server:编程只给 SSH 装上的机器)。
    translate(device.directTerminal ? 'task.deviceHintBoth' : device.cloudComputer ? 'task.deviceHintCloudComputer' : 'task.deviceHintGeneralOnly')
  );
}

/**
 * 项目页的新建框：机器由选中的文件夹决定；项目可以挂多台机器上的文件夹。
 * 须在 observer 组件里调用。
 */
export function useProjectMachine(
  projectId: string,
  projectPath: string | null,
  localProjectPicker: ReactElement,
  onSelectRemotePath: (deviceId: string, path: string | null) => void
): { machineContext: MachineCreateContext | null; devicePicker: ReactElement; projectPicker: ReactElement } {
  const { translate } = useSessionMessages();
  useEffect(() => remoteHostsStore.start(), []);
  const deviceId = machineRegistry.machineOf(projectId);
  const target = deviceId ? { deviceId, projectPath, projectId } : null;
  const selected = deviceId ? remoteChoice(deviceId, translate) : localMachineChoice(LOCAL_DEVICE, translate('task.deviceLocal'));
  const devicePicker = (
    <MachinePicker
      size="compact"
      testId="composer-device-picker"
      wakeOnPick="retry"
      machines={[selected]}
      selectedId={selected.id}
      onSelect={() => {}}
      lockedHint={translate('task.deviceFromFolder')}
    />
  );
  const projectPicker = target ? (
    <MachineProjectPicker target={target} onSelect={(path) => onSelectRemotePath(target.deviceId, path)} />
  ) : (
    localProjectPicker
  );
  return { machineContext: useMachineCreateContext(target), devicePicker, projectPicker };
}
