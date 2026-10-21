import type { MachineHomeLayout } from '@renderer/features/remote-hosts/machine-home';

/**
 * 项目跨设备(product spec,#7341 第二步):绑在同一个项目群上的本地项目 = 同一个项目,侧栏里合成一行。
 *
 * 每台机器的本地项目 id 各不相同(渲染层按 id 认机器),所以「合成一行」是读取时的归属,与 machine-home.ts
 * 把那台机器的任务工作区并进主目录那一行是同一种折叠:被并进的项目不单列,它的会话显示在代表那一行下。
 */
export type GroupLayoutProject = { id: string; machine: string | null; representative?: boolean };

export type ProjectGroupLayout = {
  /** 代表行 → 并进它的同群项目(不含它自己)。 */
  folded: ReadonlyMap<string, readonly string[]>;
  /** 被并进的项目 → 代表行。 */
  rowOf: ReadonlyMap<string, string>;
  /** 代表行 → 这个项目在各台机器上的本地项目(代表行在最前)。 */
  members: ReadonlyMap<string, readonly string[]>;
};

export const EMPTY_PROJECT_GROUP_LAYOUT: ProjectGroupLayout = { folded: new Map(), rowOf: new Map(), members: new Map() };

/** 代表行:这台电脑上的那一个优先(点开就是本机的项目页),再按 id 定序,保证每次算出来同一行。 */
function representativeFirst(a: GroupLayoutProject, b: GroupLayoutProject): number {
  const local = Number(a.machine !== null) - Number(b.machine !== null);
  if (local !== 0) return local;
  const preferred = Number(b.representative === true) - Number(a.representative === true);
  return preferred !== 0 ? preferred : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function projectGroupLayout(
  projects: Iterable<GroupLayoutProject>,
  chatIdOf: (projectId: string) => string | undefined
): ProjectGroupLayout {
  const byChat = new Map<string, GroupLayoutProject[]>();
  for (const project of projects) {
    const chatId = chatIdOf(project.id);
    if (!chatId) continue;
    const list = byChat.get(chatId) ?? [];
    list.push(project);
    byChat.set(chatId, list);
  }
  const folded = new Map<string, string[]>();
  const rowOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const list of byChat.values()) {
    if (list.length < 2) continue;
    const [row, ...rest] = [...list].sort(representativeFirst);
    folded.set(row.id, rest.map((project) => project.id));
    members.set(row.id, [row.id, ...rest.map((project) => project.id)]);
    for (const project of rest) rowOf.set(project.id, row.id);
  }
  return { folded, rowOf, members };
}

/**
 * 把同群折叠叠加到主目录折叠上(侧栏只认一份 MachineHomeLayout)。已经并进主目录那一行、或本身就是「~」那一行的项目
 * 不再参与同群折叠 —— 两种归属撞了,以主目录那条为准(那是隐藏的任务工作区,本来就不该单独成项目)。
 */
export function foldProjectGroups(base: MachineHomeLayout, groups: ProjectGroupLayout): MachineHomeLayout {
  if (groups.folded.size === 0) return base;
  const folded = new Map<string, readonly string[]>(base.folded);
  const rowOf = new Map<string, string>(base.rowOf);
  for (const [row, rest] of groups.folded) {
    if (base.rowOf.has(row) || base.homeRows.has(row)) continue;
    const taken = rest.filter((id) => !base.rowOf.has(id) && !base.homeRows.has(id));
    if (taken.length === 0) continue;
    folded.set(row, [...(folded.get(row) ?? []), ...taken]);
    for (const id of taken) rowOf.set(id, row);
  }
  return { ...base, folded, rowOf };
}
