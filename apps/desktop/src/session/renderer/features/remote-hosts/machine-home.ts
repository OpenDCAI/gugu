// 别的机器上的「主目录那一行」:只剩个人助理住的那台(#7199,owner 10-15「按它归组,组名就是它的名字」)把那台上的项目
// 并成一行。#609(owner 10-28):别的机器上没选项目的会话落在那台机器的任务工作区里,与本机一样列在「任务」,
// ❌ 再画「~ · 机器名」那一行 —— 那台上从前的主目录项目已迁成 workspace,会话一并进「任务」。
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
  /** 个人助理那台上收下全部项目的那一行(主目录项目,或代位的任务工作区 / 第一个项目)。 */
  homeRows: ReadonlySet<string>;
  /** 代位的任务工作区行 → 所在机器(在这一行上新建 = 在那台机器上新建)。 */
  standIns: ReadonlyMap<string, string>;
  /** 行 → 并进这一行显示的项目(那台上其余的项目)。 */
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

/** 个人助理那台上并成的一行(纯函数,侧栏、手机与单测共用);别的机器上没有这样的行。 */
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
    if (!lookup.foldAll?.(deviceId)) continue;
    // 主目录项目那一行(没有就任务工作区代位,再没有就那台上第一个项目)收下那台上所有的项目。
    const row = findHomeProject(others, lookup.homeDir(deviceId)) ?? sessionHome ?? others[0];
    if (!row) continue;
    homeRows.add(row.id);
    if (row === sessionHome) standIns.set(sessionHome.id, deviceId);
    const rest = [sessionHome, ...others].filter((project): project is MachineHomeProject => !!project && project !== row);
    if (rest.length > 0) folded.set(row.id, rest.map((project) => project.id));
    for (const project of rest) rowOf.set(project.id, row.id);
  }
  return { homeRows, standIns, folded, rowOf };
}
