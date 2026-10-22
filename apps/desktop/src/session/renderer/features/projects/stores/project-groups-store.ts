import { observable, reaction, runInAction } from 'mobx';
import type { ProjectGroupBinding } from '@shared/core/projects/project-groups';
import { projectGroupBindingChangedChannel } from '@shared/core/projects/projectEvents';
import { events, onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { onEachMachine } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';

/**
 * 每个本地项目绑的项目群(这台电脑 + 每台连着的机器各自回答),#7341 第二步。
 * 绑在同一个群上的本地项目 = 同一个项目:侧栏合成一行、项目首页汇总各台机器的文件夹(project-group-layout.ts)。
 *
 * 没连着的机器(离线、太旧):那台的绑定照账号上记着的那份(#113,由远程主机那边交进来,见 applyBindings)——
 * 离线机器上的项目照样并在原来那一行里(product spec:机器离线时文件夹照样列在项目里),❌ 一掉线就拆成单独一行。
 */
export class ProjectGroupsStore {
  private readonly byProject = observable.map<string, string>();
  private readonly representativeProjects = observable.set<string>();
  private stop: (() => void) | null = null;
  /** 此刻连着、项目清单同步过的机器(由远程主机那边给;❌ 在这里 import 它 —— 那边反过来要用这里)。 */
  private syncedMachines: () => readonly string[] = () => [];

  /** 这个本地项目绑的群;没绑(或还没读到)= undefined。 */
  chatIdOf(projectId: string): string | undefined {
    return this.byProject.get(projectId);
  }

  isRepresentative(projectId: string): boolean {
    return this.representativeProjects.has(projectId);
  }

  /** 会话页挂上时由远程主机那边调一次(它知道哪些机器连着)。重复调用无害。 */
  start(syncedMachines: () => readonly string[]): void {
    this.syncedMachines = syncedMachines;
    if (!this.stop) {
      void this.refresh(null);
      // 连上(且项目清单同步过)的机器各读一次;之后再连上一次就再读一次。
      const offHosts = reaction(
        () => this.syncedMachines().join('\u0000'),
        (joined) => {
          for (const deviceId of joined ? joined.split('\u0000') : []) void this.refresh(deviceId);
        },
        { fireImmediately: true }
      );
      // 哪台机器上的绑定变了(并进来、撤销、agent 挂的):在那台机器上订,就重读那一台。
      const offLocal = events.on(projectGroupBindingChangedChannel, () => void this.refresh(null));
      const offMachines = onEachMachine((deviceId) =>
        onMachineEvent(deviceId, projectGroupBindingChangedChannel, () => void this.refresh(deviceId))
      );
      this.stop = () => {
        offHosts();
        offLocal();
        offMachines();
      };
    }
  }

  refreshAll(): void {
    void this.refresh(null);
    for (const deviceId of this.syncedMachines()) void this.refresh(deviceId);
  }

  /** 这台机器上的绑定整份换成这一份(那台机器此刻的回答,或没连着时账号上记着的那份)。 */
  applyBindings(machine: string | null, bindings: readonly ProjectGroupBinding[]): void {
    runInAction(() => {
      for (const projectId of [...this.byProject.keys()]) {
        if ((machineRegistry.machineOf(projectId) ?? null) === machine) {
          this.byProject.delete(projectId);
          this.representativeProjects.delete(projectId);
        }
      }
      for (const binding of bindings) {
        if (machine) machineRegistry.register(machine, [binding.projectId]);
        this.byProject.set(binding.projectId, binding.chatId);
        if (binding.representative) this.representativeProjects.add(binding.projectId);
      }
    });
  }

  async refresh(machine: string | null): Promise<void> {
    try {
      const result = await rpcOn(machine).projects.listProjectGroupBindings();
      if (!result.success) {
        log.warn('[project-groups] 读不到这台机器上的项目群绑定', { machine, error: result.error });
        return;
      }
      this.applyBindings(machine, result.data);
    } catch (error) {
      log.warn('[project-groups] 读项目群绑定失败', { machine, error: String(error) });
    }
  }
}

export const projectGroupsStore = new ProjectGroupsStore();
