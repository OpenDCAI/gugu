import { observable, reaction, runInAction } from 'mobx';
import { projectGroupBindingChangedChannel } from '@shared/core/projects/projectEvents';
import { events, onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { onEachMachine } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { publishProjectGroupChats } from './project-group-chats-bridge';

/** 每台机器上次读到的绑定(机器 → 本地项目 → 群;这台电脑记作 'local')。 */
const STORAGE_KEY = 'gugu.projectGroups.v1';
type StoredBinding = string | { chatId: string; representative?: boolean };
type StoredBindings = Record<string, Record<string, StoredBinding>>;

function readStored(): StoredBindings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as StoredBindings) : {};
  } catch {
    return {};
  }
}

function writeStored(value: StoredBindings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 存不下只是下次那台离线时这一行先不合并,不影响这一次。
  }
}

/**
 * 每个本地项目绑的项目群(这台电脑 + 每台连着的机器各自回答),#7341 第二步。
 * 绑在同一个群上的本地项目 = 同一个项目:侧栏合成一行、项目首页汇总各台机器的文件夹(project-group-layout.ts)。
 *
 * 读不到某台机器(离线、太旧)时,那台的绑定保持上一次读到的 —— 离线机器上的项目照样并在原来那一行里(product spec:
 * 机器离线时文件夹照样列在项目里),❌ 一掉线就拆成单独一行。
 */
export class ProjectGroupsStore {
  private readonly byProject = observable.map<string, string>();
  private readonly representativeProjects = observable.set<string>();
  /** 这次打开以来答过一次的机器(读到了或读失败了都算;这台电脑记作 'local')。 */
  private readonly answeredMachines = observable.set<string>();
  private stop: (() => void) | null = null;
  /** 此刻连着、项目清单同步过的机器(由远程主机那边给;❌ 在这里 import 它 —— 那边反过来要用这里)。 */
  private syncedMachines: () => readonly string[] = () => [];

  /** 这个本地项目绑的群;没绑(或还没读到)= undefined。 */
  chatIdOf(projectId: string): string | undefined {
    return this.byProject.get(projectId);
  }

  /** 绑在这个群上的一个本地项目(几台机器上的同一个项目绑同一个群,任取一个;认侧栏那一行用 rowProjectIdOf)。不是项目群 = undefined。 */
  /**
   * 这个本地项目绑没绑群,此刻是不是已经知道:绑着(这次读到的或上次记下的)、它那台机器这次已经答过(读失败也算答过,
   * 失败进日志;下一次读成了绑定照常补上)、或者那台机器此刻连不上(不会有回音,按「没有」画能画的那部分)。
   * false = 正在读,❌ 当成「没有群」(项目块据此不先画首页,gugu-dev#181)。
   */
  bindingKnown(projectId: string): boolean {
    const machine = machineRegistry.machineOf(projectId) ?? null;
    return this.byProject.has(projectId) || this.answeredMachines.has(machine ?? 'local')
      || (machine !== null && !this.syncedMachines().includes(machine));
  }

  projectOfChat(chatId: string): string | undefined {
    for (const [projectId, bound] of this.byProject) if (bound === chatId) return projectId;
    return undefined;
  }

  isRepresentative(projectId: string): boolean {
    return this.representativeProjects.has(projectId);
  }

  /** 会话页挂上时由远程主机那边调一次(它知道哪些机器连着)。重复调用无害。 */
  start(syncedMachines: () => readonly string[]): void {
    this.syncedMachines = syncedMachines;
    if (!this.stop) {
      // 先铺上次读到的:这次打开时某台机器离线,它上面的同一个项目照样并在原来那一行里(❌ 打开就拆成两行)。
      const stored = readStored();
      runInAction(() => {
        for (const [machine, bindings] of Object.entries(stored)) {
          for (const [projectId, stored] of Object.entries(bindings)) {
            const chatId = typeof stored === 'string' ? stored : stored?.chatId;
            if (typeof chatId !== 'string' || !chatId) continue;
            if (machine !== 'local') machineRegistry.register(machine, [projectId]);
            this.byProject.set(projectId, chatId);
            if (typeof stored !== 'string' && stored.representative) this.representativeProjects.add(projectId);
          }
        }
      });
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
      // 聊天页的列表据此把项目群拿掉(它们在项目页里)。
      const offPublish = reaction(
        () => [...new Set(this.byProject.values())].sort().join('\u0000'),
        (joined) => publishProjectGroupChats(joined ? joined.split('\u0000') : []),
        { fireImmediately: true }
      );
      this.stop = () => {
        offHosts();
        offLocal();
        offMachines();
        offPublish();
      };
    }
  }

  refreshAll(): void {
    void this.refresh(null);
    for (const deviceId of this.syncedMachines()) void this.refresh(deviceId);
  }

  async refresh(machine: string | null): Promise<void> {
    try {
      const result = await rpcOn(machine).projects.listProjectGroupBindings();
      if (!result.success) {
        log.warn('[project-groups] 读不到这台机器上的项目群绑定', { machine, error: result.error });
        return;
      }
      runInAction(() => {
        for (const projectId of [...this.byProject.keys()]) {
          if ((machineRegistry.machineOf(projectId) ?? null) === machine) {
            this.byProject.delete(projectId);
            this.representativeProjects.delete(projectId);
          }
        }
        for (const binding of result.data) {
          if (machine) machineRegistry.register(machine, [binding.projectId]);
          this.byProject.set(binding.projectId, binding.chatId);
          if (binding.representative) this.representativeProjects.add(binding.projectId);
        }
      });
      writeStored({ ...readStored(), [machine ?? 'local']: Object.fromEntries(result.data.map((binding) => [binding.projectId, {
        chatId: binding.chatId, representative: binding.representative === true,
      }])) });
    } catch (error) {
      log.warn('[project-groups] 读项目群绑定失败', { machine, error: String(error) });
    } finally {
      runInAction(() => this.answeredMachines.add(machine ?? 'local'));
    }
  }
}

export const projectGroupsStore = new ProjectGroupsStore();
