// #6264 别的机器上的会话一律属于那台机器上的某个项目(behavior gugu-server「会话页里的别的机器」,owner 2026-09-25 选 A):
// 层级是「项目(标机器名)→ 会话」。没选项目 = 那台机器的**主目录项目**(那台机器的 $HOME,侧栏显示「~」加机器名)。
//
// 读取时归属:那台机器上从前没选项目、落在隐藏任务工作区里的会话,侧栏里挂到主目录项目下显示;
// ❌ 不迁移记录、不挪目录,会话照样在原目录跑。那台机器还没有主目录项目时,由它的任务工作区代位成「~」那一行。
// 本机不变:本机没项目的会话仍在「任务」列表。
import { sameFolder } from '@shared/core/projects/folder-path';
export { sameFolder } from '@shared/core/projects/folder-path';

/** 主目录项目在侧栏与项目选择器里的名字(照 shell 与 VS Code 远程的写法,不进翻译目录)。 */
export const HOME_PROJECT_LABEL = '~';

export type MachineHomeProject = { id: string; path?: string | null };

export type MachineHomeLookup = {
  /** 项目在哪台别的机器上;本机 = null。 */
  machineOf(projectId: string): string | null;
  /** 那台机器的主目录;还没问到 = null。 */
  homeDir(deviceId: string): string | null;
  /** 这个项目是不是隐藏任务工作区(本机那份与别的机器上换过名的那份)。 */
  isSessionHome(projectId: string): boolean;
  /**
   * #7199 那台机器上的项目全并成一行:个人助理住的那台(owner 10-15「按它归组,组名就是它的名字」,❌ 按项目 / 机器分)。
   * 不给 = 没有这样的机器。
   */
  foldAll?(deviceId: string): boolean;
};

/** 那台机器上路径 = 主目录的项目(复用,❌ 另建一个同路径的)。 */
export function findHomeProject<P extends MachineHomeProject>(projects: readonly P[], homeDir: string | null): P | null {
  if (!homeDir) return null;
  return projects.find((project) => sameFolder(project.path, homeDir)) ?? null;
}

export type MachineHomeLayout = {
  /** 显示成「~」的行:主目录项目,或那台机器还没有主目录项目时代位的任务工作区。 */
  homeRows: ReadonlySet<string>;
  /** 代位的任务工作区行 → 所在机器(在这一行上新建 = 在那台机器的主目录项目里新建)。 */
  standIns: ReadonlyMap<string, string>;
  /** 行 → 并进这一行显示的项目(那台机器的任务工作区)。 */
  folded: ReadonlyMap<string, readonly string[]>;
  /** 被并进别的行的项目 → 那一行。 */
  rowOf: ReadonlyMap<string, string>;
};

export const EMPTY_MACHINE_HOME_LAYOUT: MachineHomeLayout = {
  homeRows: new Set(),
  standIns: new Map(),
  folded: new Map(),
  rowOf: new Map(),
};

/** 每台别的机器的主目录那一行,以及它的任务工作区并到哪一行(纯函数,侧栏与单测共用)。 */
export function machineHomeLayout(projects: Iterable<MachineHomeProject>, lookup: MachineHomeLookup): MachineHomeLayout {
  const byMachine = new Map<string, { sessionHome: MachineHomeProject | null; others: MachineHomeProject[] }>();
  for (const project of projects) {
    const deviceId = lookup.machineOf(project.id);
    if (!deviceId) continue;
    const slot = byMachine.get(deviceId) ?? { sessionHome: null, others: [] };
    if (lookup.isSessionHome(project.id)) slot.sessionHome = project;
    else slot.others.push(project);
    byMachine.set(deviceId, slot);
  }
  const homeRows = new Set<string>();
  const standIns = new Map<string, string>();
  const folded = new Map<string, string[]>();
  const rowOf = new Map<string, string>();
  for (const [deviceId, { sessionHome, others }] of byMachine) {
    const home = findHomeProject(others, lookup.homeDir(deviceId));
    if (lookup.foldAll?.(deviceId)) {
      // 主目录项目那一行(没有就任务工作区代位,再没有就那台上第一个项目)收下那台上所有的项目。
      const row = home ?? sessionHome ?? others[0];
      if (!row) continue;
      homeRows.add(row.id);
      if (row === sessionHome) standIns.set(sessionHome.id, deviceId);
      const rest = [sessionHome, ...others].filter((project): project is MachineHomeProject => !!project && project !== row);
      if (rest.length > 0) folded.set(row.id, rest.map((project) => project.id));
      for (const project of rest) rowOf.set(project.id, row.id);
      continue;
    }
    if (home) {
      homeRows.add(home.id);
      if (sessionHome) {
        folded.set(home.id, [sessionHome.id]);
        rowOf.set(sessionHome.id, home.id);
      }
    } else if (sessionHome) {
      homeRows.add(sessionHome.id);
      standIns.set(sessionHome.id, deviceId);
    }
  }
  return { homeRows, standIns, folded, rowOf };
}
