import { useEffect, type ReactNode } from 'react';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';
import { useMachineCreateContext } from '@renderer/features/sessions/use-machine-create-target';
import { electronApi } from '@renderer/lib/electron-api';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { foldersInScope, useProjectDeviceScope } from './project-device-scope';
import { ProjectFolderCard, shortHome, type AttachMachine, type FolderCardMachine } from './project-folder-card';
import { linkFolderOnMachine, planAttach, type LinkFolderDeps } from '@shared/core/projects/project-attach-flow';
import { useProjectFolders, type AttachResult } from './project-folders';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/**
 * 一个项目的文件夹卡和它背后的那一套(#7341):各台机器上的文件夹、设备范围、挂文件夹 / 接进来 / 并进来、
 * 新任务从哪个文件夹开工。项目首页摆着它;项目块里点「新任务」时它浮到群聊上面(gugu-dev#181)—— 两处是同一张卡、
 * 同一个选择,❌ 各写一份。
 */
export function useProjectFolderStage(projectId: string, { floating = false, onChosen }: {
  /** 浮在群聊上面(项目块里开新任务):卡一浮出来就摊开。 */
  floating?: boolean;
  /** 在卡上点中了一张(浮着的卡据此让开)。 */
  onChosen?: () => void;
} = {}) {
  const { translate } = useSessionMessages();
  const displayName = projectDisplayName(getProjectStore(projectId)) ?? '';
  // #7341 第二步:这个项目在各台机器上的本地项目(绑在同一个项目群上)。点进来的若是被并进别的行的那一个,按那一行看。
  const rowId = sidebarStore.rowProjectIdOf(projectId);
  const memberIds = sidebarStore.projectMembersOf(rowId);
  const folders = useProjectFolders(rowId, memberIds);
  const thisComputer: AttachMachine = { id: null, label: translate('projects.folders.thisComputer'), online: true, kind: 'computer' };
  const describeMachine = (deviceId: string): AttachMachine => {
    const device = remoteHostsStore.device(deviceId);
    return {
      id: deviceId,
      label: device?.label ?? deviceId,
      online: remoteHostsStore.connectionState(deviceId) === 'connected',
      kind: device?.hostKind === 'desktop' ? 'computer' : 'server',
    };
  };
  const machineOfProject = (id: string): FolderCardMachine => {
    const deviceId = machineRegistry.machineOf(id);
    return deviceId ? describeMachine(deviceId) : thisComputer;
  };
  // 「+」能挂到的机器:这台电脑 + 名下每台机器(此刻连不上的列着、灰掉)。
  const attachMachines: AttachMachine[] = [thisComputer, ...[...remoteHostsStore.hosts.keys()].map(describeMachine)];
  const projectMachines = [...new Map(memberIds.map((id) => {
    const deviceId = machineRegistry.machineOf(id) ?? null;
    return [deviceId, deviceId ? describeMachine(deviceId) : thisComputer] as const;
  })).values()];
  const scope = useProjectDeviceScope(rowId, projectMachines);
  const scopedFolders = foldersInScope(folders, scope.selected, (id) => machineRegistry.machineOf(id) ?? null);
  // 新会话开在哪:卡片 / 托盘上选中的那个文件夹所属的本地项目(可能在别的机器上);没选 = 这一页的项目。
  const targetProjectId = scopedFolders.chosen?.projectId ?? projectId;
  useEffect(() => remoteHostsStore.start(), []);
  const executionDevice = machineRegistry.machineOf(targetProjectId);
  const machineContext = useMachineCreateContext(executionDevice ? {
    deviceId: executionDevice, projectId: targetProjectId,
    projectPath: getProjectStore(targetProjectId)?.data?.path ?? null,
  } : null);
  const machineLabel = (machine: string | null) => (machine ? describeMachine(machine).label : thisComputer.label);
  const showConfirm = useShowModal('confirmActionModal');

  const attachErrorText = (error: Extract<AttachResult, { ok: false }>['error']) => {
    switch (error.type) {
      case 'not-a-directory':
        return translate('projects.folders.errorNotDirectory');
      case 'is-project-root':
        return translate('projects.folders.errorIsProjectRoot', { projectName: error.projectName });
      case 'belongs-to-other-project':
        return translate('projects.folders.errorOtherProject', { projectName: error.projectName });
      default:
        // 没挂上的原因(那台机器答不上、项目没了)进日志;文案只说没挂上、可以再试。
        log.warn('[project-home] 挂文件夹失败', { projectId, error });
        return translate('projects.folders.errorAttach');
    }
  };
  const sessionCountOf = (id: string) =>
    (sidebarStore.placement.entries.get(id) ?? []).filter((entry) => entry.projectId === id).length;
  const failLinking = (error: unknown) => {
    log.warn('[project-home] 把别的机器上的文件夹接进这个项目失败', { projectId, error });
    toast({ tier: 'error', title: translate('projects.folders.errorAttach') });
  };

  // 挂到这个项目在那台机器上已有的本地项目下(与第一步同一条路)。
  const attachToMember = async (memberId: string, machine: string | null, path: string) => {
    const result = await folders.attach(memberId, path);
    if (!result.ok) {
      // 那个文件夹本身就是那台机器上的另一个项目 ⇒ 不是「挂不上」,是「要不要把那个项目并进来」。
      if (result.error.type === 'is-project-root' && !memberIds.includes(result.error.projectId)) {
        confirmMerge(machine, result.error.projectId, result.error.projectName, path);
        return;
      }
      toast({ tier: 'error', title: attachErrorText(result.error) });
      return;
    }
    const attached = result.folder;
    toast({
      // 挂在别的机器上:说是哪台(与「在那台机器上接进来」同一句),❌ 只给一条路径让人猜在哪台上。
      title: machine
        ? translate('projects.folders.attachedOn', { machine: machineLabel(machine), path: shortHome(attached.path), projectName: displayName })
        : translate('projects.folders.attached', { path: shortHome(attached.path), projectName: displayName }),
      // 挂错了能当场撤(product spec「挂文件夹」)。
      action: {
        label: translate('projects.folders.undo'),
        onClick: () => {
          void folders.detach(attached).then((ok) => {
            if (ok) toast({ title: translate('projects.folders.detached', { path: shortHome(attached.path), projectName: displayName }) });
          });
        },
      },
      duration: 8000,
    });
  };

  // 那台机器上还没有这个项目:在那台把文件夹认成项目(并进来的就用那一个),绑到这个项目的群上(product spec,owner 选 A)。
  const linkDeps: LinkFolderDeps = {
    ensureGroup: (row) => rpc.projects.ensureProjectGroup(row),
    createProjectOn: async (machine, path) => {
      // 那台机器上的这个项目就是这个项目(product spec「项目不属于任何一台机器」):叫同一个名字,
      // ❌ 用文件夹名 —— 否则那台机器的侧栏、这边的托盘上同一个项目各叫各的(实机:「shop」挂进去成了「shop-on-b」)。
      const started = await appState.projects.startProjectCreation(
        machine ? { type: 'local', machine } : { type: 'local' },
        { mode: 'pick', path, name: displayName || folderName(path), initGitRepository: false, createDirectory: false, allowNonGit: true }
      );
      if (started.kind === 'existing') return { projectId: started.projectId, created: false };
      const completion = await started.completion;
      if (!completion.success) return null;
      if (machine) await appState.projects.ensureMounted(started.projectId);
      return { projectId: started.projectId, created: true };
    },
    bind: (machine, linked, chatId) => rpcOn(machine).projects.bindProjectToGroup(linked, chatId),
    unbind: (machine, linked) => rpcOn(machine).projects.unbindProjectGroup(linked),
    deleteProject: (linked) => appState.projects.deleteProject(linked),
    sessionCountOf,
  };
  const linkOnMachine = async (machine: string | null, path: string, existingProjectId?: string) => {
    try {
      const linked = await linkFolderOnMachine(linkDeps, { rowId, machine, path, existingProjectId });
      projectGroupsStore.refreshAll();
      // 那台机器的项目清单变了(多了一个 / 绑了群):重读一遍,下次它离线时侧栏照样列着(❌ 只在连上那一刻读过)。
      const resyncMachine = () => (machine ? void remoteHostsStore.syncProjects(machine) : undefined);
      resyncMachine();
      if (!linked.ok) return failLinking(linked.error);
      toast({
        title: translate('projects.folders.attachedOn', { machine: machineLabel(machine), path: shortHome(path), projectName: displayName }),
        action: {
          label: translate('projects.folders.undo'),
          onClick: () => {
            void linked
              .undo()
              .then((ok) => {
                projectGroupsStore.refreshAll();
                resyncMachine();
                if (ok) toast({ title: translate('projects.folders.detached', { path: shortHome(path), projectName: displayName }) });
              })
              .catch((error: unknown) => log.warn('[project-home] 撤销接进来的文件夹失败', { projectId, error }));
          },
        },
        duration: 8000,
      });
    } catch (error) {
      failLinking(error);
    }
  };

  // 那台机器上的这个文件夹已经是一个有会话的项目:先说清会发生什么,确认了才并(owner 2026-10-17 选 A)。
  const confirmMerge = (machine: string | null, existingProjectId: string, name: string, path: string) => {
    const count = sessionCountOf(existingProjectId);
    if (count === 0) {
      void linkOnMachine(machine, path, existingProjectId);
      return;
    }
    showConfirm({
      title: translate('projects.folders.mergeTitle', { name, projectName: displayName }),
      description: translate('projects.folders.mergeDescription', { machine: machineLabel(machine), name, count, projectName: displayName }),
      confirmLabel: translate('projects.folders.mergeConfirm'),
      // 并进来不删任何东西(原来的群留作历史):❌ 删除那种红按钮。
      variant: 'default',
      onSuccess: () => void linkOnMachine(machine, path, existingProjectId),
    });
  };

  const attachOn = async (machine: string | null, path: string) => {
    const plan = await planAttach({
      machine,
      path,
      memberIds,
      machineOf: (id) => machineRegistry.machineOf(id) ?? null,
      inspect: (on, folder) => rpcOn(on).projects.inspectProjectPath({ type: 'local', path: folder }),
    }).catch((error: unknown) => {
      // 那台机器答不上「这个文件夹在它那里是什么」:如实说没挂上,❌ 当成「什么都不是」去建一个。
      failLinking(error);
      return null;
    });
    if (!plan) return;
    switch (plan.kind) {
      case 'member':
        return attachToMember(plan.memberId, machine, path);
      case 'merge':
        return confirmMerge(machine, plan.projectId, plan.name, path);
      case 'taken':
        toast({ tier: 'error', title: translate('projects.folders.errorOtherProject', { projectName: plan.projectName }) });
        return;
      case 'link':
        return linkOnMachine(machine, path);
    }
  };

  // 「+」:在选的那台机器上挑文件夹 —— 本机弹系统的目录框,别的机器由那台机器画目录树(同「新建项目 › 使用现有文件夹」)。
  const pickAndAttach = (machine: string | null) => {
    const picked = machine
      ? (remoteHostsStore.connectionState(machine) === 'asleep'
          ? remoteHostsStore.wakeCloudComputer(machine)
          : Promise.resolve(true)
        ).then((awake) => (awake ? remoteHostsStore.pickFolder(machine, '~') : null))
      : rpc.app.openSelectDirectoryDialog({
          title: translate('projects.folders.attachDialogTitle', { projectName: displayName }),
          message: translate('projects.folders.attachDialogMessage'),
        });
    void picked
      .then((path) => (path ? attachOn(machine, path) : undefined))
      .catch((error: unknown) => log.error('[project-home] 挂文件夹失败', { projectId, error }));
  };
  // 从 Finder 拖进来的是这台电脑上的文件夹:挂到这个项目在这台电脑上的那一个(没有就在这台电脑上接进来)。
  const dropFolder = (file: File) => {
    const path = electronApi().getPathForFile(file).trim();
    if (!path) {
      toast({ tier: 'error', title: translate('projects.folders.errorNotDirectory') });
      return;
    }
    void attachOn(null, path);
  };

  const card: ReactNode = (
    <ProjectFolderCard
      projectId={rowId}
      projectName={displayName}
      folders={{ ...folders, chosen: scopedFolders.chosen, choose: (workspaceId) => {
        const folder = folders.folders?.find((item) => item.workspaceId === workspaceId);
        if (folder) scope.include(machineRegistry.machineOf(folder.projectId) ?? null);
        folders.choose(workspaceId);
        onChosen?.();
      } }}
      memberIds={memberIds}
      machineOf={machineOfProject}
      attachMachines={attachMachines}
      onAttach={pickAndAttach}
      onAddMachine={remoteHostsStore.canAddMachine ? () => remoteHostsStore.openAddMachine() : undefined}
      onDropFolder={dropFolder}
      floating={floating}
    />
  );
  return {
    rowId, displayName, folders, scope, scopedFolders, targetProjectId, machineContext, projectMachines,
    machineOfProject, pickAndAttach, card,
  };
}

export type ProjectFolderStage = ReturnType<typeof useProjectFolderStage>;
