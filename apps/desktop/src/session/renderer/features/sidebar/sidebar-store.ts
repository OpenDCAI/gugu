import { computed, makeAutoObservable, observable, runInAction } from 'mobx';
import {
  buildSessionTree,
  familiesByRoot,
  flattenSessionTree,
  foldIdleFamilies,
  pinnedSubtreeRoots,
  withoutPinnedSubtrees,
  type SessionTreeNode,
} from '@renderer/features/sessions/session-tree';
import { type ProjectStore } from '@renderer/features/projects/stores/project';
import type { ProjectManagerStore } from '@renderer/features/projects/stores/project-manager';
import { pageSessions } from '@renderer/features/sessions/stores/session-selectors';
import { isImplicitSessionHomeProject, isWorkspaceProject } from '@renderer/features/sessions/session-home-project-constants';
import { nameTwinIds } from '@renderer/features/projects/name-twins';
import {
  EMPTY_MACHINE_HOME_LAYOUT,
  HOME_PROJECT_LABEL,
  machineHomeLayout,
  type MachineHomeLayout,
} from '@renderer/features/remote-hosts/machine-home';
import { events, onMachineEvent } from '@renderer/lib/ipc';
import { onEachMachine } from '@renderer/lib/machine-clients';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import { sessionCreatedChannel } from '@shared/core/sessions/sessionEvents';
import type { SidebarListLayout, SidebarListPage, SidebarSnapshot, SidebarSessionSortBy } from '@shared/view-state';
import { blockKey, type JoinedGroup, type SidebarJoin } from '@/lib/sidebarJoinedGroups';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { isAssistantSession, launchedByAssistant } from '@renderer/features/assistant/assistant-lineage';
import { taskStatusPresentation } from '@/lib/taskAgentStatus';
import { sessionPresentation } from '@/mobile/agent-watch/watch-status';
import { sessionAgentNames } from '@renderer/features/sessions/stores/session-agent-names';
import {
  EMPTY_PROJECT_GROUP_LAYOUT,
  foldProjectGroups,
  projectGroupLayout,
  type ProjectGroupLayout,
} from '@renderer/features/projects/stores/project-group-layout';
import {
  SIDEBAR_STATE_GROUP_ORDER,
  sidebarStateGroup,
  type SidebarStateGroup,
} from './session-groups';

function parseSidebarSessionSortBy(value: unknown): SidebarSessionSortBy | undefined {
  return value === 'created-at' || value === 'updated-at' ? value : undefined;
}

// spec session-page: conversations ARE the sessions. They hang directly under their project —
// tasks are an invisible workspace container and no longer render as rows. Sections are the
// project-level state buckets; idle conversations sit flat and collapse behind a "more" row.
export type SidebarRow =
  | { kind: 'project'; projectId: string }
  | { kind: 'state-header'; projectId: string; group: SidebarStateGroup; count: number }
  | ({ kind: 'conversation' } & SidebarSessionRow)
  | { kind: 'more'; projectId: string; expanded: boolean; hiddenCount: number };

/**
 * behavior session-page「键盘导航」: a station on the keyboard navigation chain. Only three kinds are
 * destinations — the New task entry, a project row (= that project's home, where a new session is
 * started) and a conversation row. Section titles and state-group titles are not stations.
 */
export type SidebarNavNode =
  | { kind: 'new-session' }
  | { kind: 'project'; projectId: string }
  | { kind: 'conversation'; projectId: string; sessionId: string };

/** Stable identity of a station, so the cursor survives re-ordering and re-grouping. */
export function navNodeKey(node: SidebarNavNode): string {
  switch (node.kind) {
    case 'new-session':
      return 'new-session';
    case 'project':
      return `project:${node.projectId}`;
    case 'conversation':
      return `session:${node.sessionId}`;
  }
}

export function navNodesEqual(a: SidebarNavNode | null, b: SidebarNavNode | null): boolean {
  if (!a || !b) return a === b;
  return navNodeKey(a) === navNodeKey(b);
}

/**
 * 一组在这边(「项目」「置顶」)成框的样子(spec session-page「拼在一屏的几块是一组」,#7097):组里这边有的会话,按屏上次序;
 * 框摆在 anchor 那条原来的位置 —— 组员里不并组时最靠前、此刻看得见的那一条(同 lib/sidebarJoinedGroups),别的组员从原位置挪进来。
 */
type ProjectJoinedGroup = { anchor: string; sessionIds: readonly string[]; onScreen: boolean };

export type SessionEntry = {
  projectId: string;
  sessionId: string;
  depth?: number;
  hasChildren?: boolean;
  needsAttention?: boolean;
  /** 父会话所在的项目(挂在父会话下的行才有):与它不在同一台机器 / 同一个项目时,行首挂机器 / 项目标记。 */
  parentProjectId?: string;
  join?: SidebarJoin;
};

/** 「任务」分区在 placement 里的键(项目行用项目 id)。 */
const SESSIONS_SECTION = '\u0000sessions';

type SidebarSessionEntry = {
  id: string;
  projectId: string;
  sessionId: string;
  parentSessionId?: string | null;
  isPinned: boolean;
  time: number;
  group: SidebarStateGroup | null;
  /** 显示用的标题(「对话」里那一行、文件夹卡上的头像提示)。 */
  title: string;
};

type SidebarSessionRow = {
  projectId: string;
  sessionId: string;
  group: SidebarStateGroup | null;
  depth: number;
  hasChildren: boolean;
  needsAttention: boolean;
  parentProjectId?: string;
  join?: SidebarJoin;
};

/**
 * 「项目」分区里的一项。#6264 别的机器上的项目与本机项目在同一张项目表里(按 Zed,机器是项目的属性),
 * 形状一样;行上多一个机器名(project-item 按项目所在机器画)。
 */
export type SidebarProjectRef = { kind: 'local'; id: string; project: ProjectStore };

/** #6264 侧栏要知道的机器读数(由 remoteHostsStore 注入;不注入 = 全是本机,单测默认如此)。 */
export type SidebarMachines = {
  machineOf(projectId: string): string | null;
  label(deviceId: string): string | null;
  homeDir(deviceId: string): string | null;
  /**
   * 那台机器上有哪些会话(会话目录,与手机同一份)。别的机器上的行只读它,❌ 读挂载的项目:列出不挂载,
   * 打开就先画上次的样子。`live` 只说明目录连接；Agent 工作态由共享 presence 提供。
   */
  sessionsOf?(deviceId: string): { sessions: readonly SessionpageSessionSummary[]; live: boolean };
  /** #7199 这台是不是个人助理住的那台(它上面的项目并成一组,组名是它的名字)。 */
  isAssistantHome?(deviceId: string): boolean;
  /** #7341 这个本地项目绑的项目群;绑在同一个群上的本地项目 = 同一个项目(合成一行)。 */
  projectGroupOf?(projectId: string): string | undefined;
  /** 那台机器此刻连着(同群合成一行时,行落在连着的那台上,见 groupRowOrder)。 */
  connected?(deviceId: string): boolean;
};

/** 一条别的机器上的会话(侧栏远程行画它)。 */
export type RemoteSidebarSession = { summary: SessionpageSessionSummary; live: boolean };

function publicEntry({ group: _group, ...entry }: SidebarSessionRow): SessionEntry {
  return entry;
}

/** `a` 排在 `b` 前面(逐位比)。 */
function rankBefore(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return a.length < b.length;
}

function subtreeNeedsAttention(node: SessionTreeNode<SidebarSessionEntry>): boolean {
  return node.item.group === 'needs-you' || node.children.some(subtreeNeedsAttention);
}

export class SidebarStore implements Snapshottable<SidebarSnapshot> {
  projectOrder: string[] = [];
  sessionOrderByProject: Record<string, string[]> = {};
  expandedProjectIds = observable.set<string>();
  /** 「展开显示」点开了的格:项目 id,或「任务」分区的 SESSIONS_SECTION(session-local)。 */
  idleExpandedProjectIds = observable.set<string>();
  /** Persisted disclosure state for parent/child conversation trees. */
  expandedSessionIds = observable.set<string>();
  /** spec session-page: the Pinned section is collapsible (persisted). */
  pinnedCollapsed = false;
  /** spec session-page: Projects and Tasks section headers collapse too, like Pinned (persisted). */
  projectsCollapsed = false;
  sessionsCollapsed = false;
  /** gugu-dev#181「对话」分区头也能收起(persisted)。 */
  chatsCollapsed = false;
  /** gugu-dev#181 侧栏「显示方式」:默认分开(顶上「项目 | 对话」两枚页签),也能合在一起(persisted)。 */
  listLayout: SidebarListLayout = 'split';
  /** 分开时看的是哪一页(persisted)。合在一起时不读它。 */
  listPage: SidebarListPage = 'projects';
  /** Last task a navigation arrived at (`revealActiveSession`); `null` = left for a non-task view. */
  private revealedSessionKey: string | null = null;
  /**
   * behavior session-page「会话列表与状态」: 用不用二级分类(agent 状态分组)。设置
   * `interface.showLeftSidebarStateGroups` 的镜像,由 left-sidebar 同步进来 —— 组头渲染在
   * React 树里、键盘链住在这个 store 里,两处得读同一个真值。
   * 关掉 = 侧栏根本没有分组这一层:不出组头,会话按最后交互时间平铺成一条列表。
   * 「需要你」不会因此消失 —— 它退回行级信号(行尾那颗琥珀点、项目收起时的项目行琥珀点)。
   */
  stateGroupsEnabled = false;
  /**
   * 指针压到会话行上时,这一行要不要就地变成它的 agent 名字(#5818)。设置
   * `interface.showLeftSidebarAgentNameOnHover` 的镜像,由 left-sidebar 同步进来 ——
   * 与 `stateGroupsEnabled` 同一条路:❌ 不在每一行里各调一次设置 hook(侧栏是几十行的场面)。
   */
  agentNameOnHoverEnabled = true;
  sessionSortBy: SidebarSessionSortBy = 'created-at';
  /**
   * #6264 项目在哪台机器、那台机器叫什么、主目录在哪。由机器那边注入(remoteHostsStore.start),
   * 排版逻辑因此能脱离桥单测。搜索时机器名也算项目名的一部分。
   */
  machines: SidebarMachines | null = null;
  /** 拼在一屏的几组(这屏那边注入,screen-layout-actions;不注入 = 没有组,单测默认如此)。 */
  joinedGroups: readonly JoinedGroup[] = [];
  /**
   * #7199 个人助理是谁(它的 agent id,壳按库里的标记认出来、由 left-sidebar 同步进来;没有 = null)。
   * owner:「它不应该生活在任务区」—— 它自己的会话不进这里的任何列表;它派出来的照常在,行上标「助理发起」。
   */
  assistantAgentId: string | null = null;
  /**
   * #7199 个人助理住在这台电脑上时它的工作目录那个项目:它不住任务区,那个项目是它的家,❌ 在「项目」里单列一行。
   * 人自己后来在那个目录里开的别的会话照常出现在别处(项目行被藏、会话仍在「任务」分区),所以只藏项目行。
   */
  assistantHomeProjectId: string | null = null;

  constructor(private readonly projectManager: ProjectManagerStore) {
    makeAutoObservable<this, 'revealedSessionKey'>(this, {
      revealedSessionKey: false,
      machines: observable.ref,
      joinedGroups: observable.ref,
      homeLayout: computed,
      projectGroups: computed,
      expandedProjectIds: false,
      idleExpandedProjectIds: false,
      expandedSessionIds: false,
      sidebarRows: computed,
      navChain: computed,
      standaloneSection: computed,
      pinnedSessionEntries: computed,
      standaloneSessionEntries: computed,
    });

    // A new nested session must be visible immediately. This event-only update preserves restored
    // disclosure preferences during the initial list while reopening the direct parent on spawn.
    // 本机的与每台连着的机器上的(别的机器上的会话也会派生子会话)。
    const expandParent = ({ session }: { session: { parentSessionId?: string | null } }) => {
      const parentSessionId = session.parentSessionId;
      if (parentSessionId) {
        runInAction(() => {
          this.expandedSessionIds.add(parentSessionId);
        });
      }
    };
    events.on(sessionCreatedChannel, expandParent);
    onEachMachine((deviceId) => onMachineEvent(deviceId, sessionCreatedChannel, expandParent));
  }

  /** 「项目」分区的项目(本机与别的机器上的,按侧栏次序)。 */
  get orderedProjects(): ProjectStore[] {
    return this.sidebarProjects.map((ref) => ref.project);
  }

  /**
   * 「项目」分区的次序:本机项目与别的机器上的项目混排(#6264,按 Zed)。手动拖过之后按 `projectOrder` 排;
   * 还没进手动次序的新项目排最前(新建即可见)。
   */
  get sidebarProjects(): SidebarProjectRef[] {
    // #609 workspace(任务工作区、主目录等咕咕自己要用的目录;哪台机器上的都算)不是项目:不单列,会话在「任务」里。
    // 例外只有个人助理那台并成的那一行(#7199)。被并进别的行的项目不单列。
    const { homeRows, rowOf } = this.homeLayout;
    const all: SidebarProjectRef[] = Array.from(this.projectManager.projects.values())
      .filter((project) => (!isWorkspaceProject(project) || homeRows.has(project.id)) && !rowOf.has(project.id))
      .filter((project) => project.id !== this.assistantHomeProjectId)
      .sort((a, b) => this.compareSidebarProjects(a, b))
      .map((project) => ({ kind: 'local', id: project.id, project }));
    if (this.projectOrder.length === 0) return all;
    const rank = (ref: SidebarProjectRef, index: number): [number, number] => {
      const manual = this.projectOrder.indexOf(ref.id);
      return manual !== -1 ? [1, manual] : [0, index];
    };
    return all
      .map((ref, index) => ({ ref, rank: rank(ref, index) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
      .map(({ ref }) => ref);
  }

  get sidebarRows(): SidebarRow[] {
    const rows: SidebarRow[] = [];
    for (const ref of this.sidebarProjects) {
      const projectId = ref.id;
      rows.push({ kind: 'project', projectId });
      if (!this.expandedProjectIds.has(projectId)) continue;
      // 别的机器上的项目列出不挂载:行来自会话目录,没挂也照画。
      if (!ref.project.mountedProject && !this.isRemote(ref.id)) continue;
      // spec session-page「会话列表与状态」: every task's conversation families are flattened under the
      // project and bucketed by root status — Needs you / Working / Completed sections first
      // (each with a labelled header), then idle conversations flat (newest first) capped
      // behind a "Show more" row. Tasks themselves never render.
      const { rows: projected, folded } = this.sessionRows(this.projectEntries(ref), projectId);
      // behavior session-page「会话列表与状态」: 关掉二级分类 = 这一层根本不存在 —— 不出组头,
      // 整份会话按最后交互时间平铺成一条列表。折法两档一样(foldIdleFamilies:需要你 / 在跑的家族永远露着,
      // 只收多出来的闲置家族),所以平铺时收起来也藏不掉需要你的会话。
      const more = (): void => {
        if (folded > 0) {
          rows.push({
            kind: 'more',
            projectId,
            expanded: this.idleExpandedProjectIds.has(projectId),
            hiddenCount: folded,
          });
        }
      };
      if (!this.stateGroupsEnabled) {
        for (const e of projected) {
          rows.push({ kind: 'conversation', ...e });
        }
        more();
        continue;
      }
      for (const group of SIDEBAR_STATE_GROUP_ORDER) {
        const bucket = projected.filter((e) => e.group === group);
        if (bucket.length === 0) continue;
        rows.push({ kind: 'state-header', projectId, group, count: bucket.length });
        for (const e of bucket) {
          rows.push({ kind: 'conversation', ...e });
        }
      }
      for (const e of projected.filter((e) => e.group === null)) {
        rows.push({ kind: 'conversation', ...e });
      }
      more();
    }
    return rows;
  }

  /**
   * behavior session-page「键盘导航」: the keyboard navigation chain, top to bottom —
   * New task → pinned conversations → each project row and its conversations → Tasks-section
   * conversations. A collapsed section or project simply contributes nothing: collapsing means
   * "I don't want to see this", so the keyboard skips it whole instead of auto-expanding it.
   * The "Show more" idle overflow is the opposite case (a mere length cap) and is auto-expanded
   * by the mover, otherwise those conversations would be unreachable by keyboard.
   */
  get navChain(): SidebarNavNode[] {
    const nodes: SidebarNavNode[] = [{ kind: 'new-session' }];
    const pushSession = (entry: SessionEntry) =>
      nodes.push({
        kind: 'conversation',
        projectId: entry.projectId,
        sessionId: entry.sessionId,
      });

    if (!this.pinnedCollapsed) this.pinnedSessionEntries.forEach(pushSession);

    if (!this.projectsCollapsed) {
      for (const row of this.sidebarRows) {
        if (row.kind === 'project') nodes.push({ kind: 'project', projectId: row.projectId });
        else if (row.kind === 'conversation') pushSession(row);
      }
    }

    if (!this.sessionsCollapsed) {
      for (const group of this.standaloneSessionGroups) group.entries.forEach(pushSession);
    }

    return nodes;
  }

  /**
   * The fold (a project, or the Tasks section) whose idle overflow hides the station right after `node`, if any. The mover
   * expands it so ↓ can walk past a "Show more" row instead of dead-ending on it.
   */
  idleOverflowProjectAfter(node: SidebarNavNode): string | null {
    if (node.kind !== 'conversation') return null;
    const rows = this.sidebarRows;
    const index = rows.findIndex(
      (row) => row.kind === 'conversation' && row.sessionId === node.sessionId
    );
    if (index !== -1) {
      const next = rows[index + 1];
      return next?.kind === 'more' && !next.expanded ? next.projectId : null;
    }
    // 「任务」分区:它的「展开显示」跟在分区最后一行后面。
    const more = this.standaloneMore;
    const last = this.standaloneSection.rows.at(-1);
    return more && !more.expanded && last?.sessionId === node.sessionId ? more.foldKey : null;
  }

  /**
   * #6264 每台别的机器的主目录那一行,以及它的任务工作区并到哪一行(读取时归属,见 machine-home.ts)。
   */
  get homeLayout(): MachineHomeLayout {
    const machines = this.machines;
    if (!machines) return EMPTY_MACHINE_HOME_LAYOUT;
    const base = machineHomeLayout(
      Array.from(this.projectManager.projects.values(), (p) => ({ id: p.id, path: p.data?.path })),
      {
        machineOf: (id) => machines.machineOf(id),
        homeDir: (deviceId) => machines.homeDir(deviceId),
        isSessionHome: (id) => isImplicitSessionHomeProject({ id }),
        foldAll: (deviceId) => machines.isAssistantHome?.(deviceId) === true,
      }
    );
    // #7341 绑在同一个项目群上的本地项目(各台机器上的)合成一行。
    return foldProjectGroups(base, this.projectGroups);
  }

  /** #7341 同群折叠:哪一行代表哪几个本地项目(纯函数在 project-group-layout.ts)。 */
  get projectGroups(): ProjectGroupLayout {
    const machines = this.machines;
    if (!machines?.projectGroupOf) return EMPTY_PROJECT_GROUP_LAYOUT;
    return projectGroupLayout(
      Array.from(this.projectManager.projects.values(), (p) => {
        const machine = machines.machineOf(p.id);
        return { id: p.id, machine, online: machine === null || machines.connected?.(machine) === true, createdAt: p.createdAt };
      }),
      (id) => machines.projectGroupOf?.(id)
    );
  }

  /** 这一行代表的项目在各台机器上的本地项目(代表行在最前);没合并 = 只有它自己。 */
  projectMembersOf(rowId: string): readonly string[] {
    return this.projectGroups.members.get(rowId) ?? [rowId];
  }

  /** 这一行还涉及的别的机器(并进来的那几个项目所在的机器,去重,不含这一行自己的机器)。 */
  extraMachinesOf(rowId: string): string[] {
    const own = this.machines?.machineOf(rowId) ?? null;
    const out: string[] = [];
    for (const id of this.projectMembersOf(rowId)) {
      const machine = this.machines?.machineOf(id) ?? null;
      if (machine && machine !== own && !out.includes(machine)) out.push(machine);
    }
    return out;
  }

  /**
   * 侧栏上另有一行与它同名(那一行带上路径区分,spec session-page-remote)。只算画出来的项目行:并进某一行的项目
   * (别的机器上的同一个项目,#7341)与 workspace(#609)在侧栏上不单独出现,谈不上分不清。
   */
  hasNameTwin(projectId: string): boolean {
    return this.nameTwins.has(projectId);
  }

  get nameTwins(): ReadonlySet<string> {
    return nameTwinIds(this.sidebarProjects.map((ref) => ({ id: ref.id, name: ref.project.name })));
  }

  /** 这个项目的会话显示在哪一行下(被并进主目录项目的任务工作区 → 那一行;其余就是它自己)。 */
  rowProjectIdOf(projectId: string): string {
    return this.homeLayout.rowOf.get(projectId) ?? projectId;
  }

  /** 会话所在项目行的名字(侧栏里那一行怎么写,它就怎么写)。 */
  projectLabel(projectId: string): string | null {
    const row = this.rowProjectIdOf(projectId);
    if (this.homeLayout.homeRows.has(row)) {
      // #7199 个人助理住的那台:那一组叫它的名字(宿主把那台的 label 换成了它的名字),❌「~」。
      const machine = this.machines?.machineOf(row) ?? null;
      if (machine && this.machines?.isAssistantHome?.(machine)) return this.machines.label(machine) ?? HOME_PROJECT_LABEL;
      return HOME_PROJECT_LABEL;
    }
    // #609 workspace 不是项目,没有项目名可标(本机的任务工作区从前会标出「任务工作区」)。
    const project = this.projectManager.projects.get(row);
    return project && !isWorkspaceProject(project) ? project.name ?? null : null;
  }

  /** 挂在父会话下的行要标的项目名:与父会话不在同一个项目行时才有(与机器标记同一条「跟上面那一行比」)。 */
  nestedProjectLabel(projectId: string, parentProjectId: string): string | null {
    return this.rowProjectIdOf(projectId) === this.rowProjectIdOf(parentProjectId) ? null : this.projectLabel(projectId);
  }

  private isRemote(projectId: string): boolean {
    return (this.machines?.machineOf(projectId) ?? null) !== null;
  }

  /** 一行下显示的会话,新的在前(见 placement)。 */
  private projectEntries(ref: SidebarProjectRef): SidebarSessionEntry[] {
    return this.placement.entries.get(ref.id) ?? [];
  }

  /**
   * 每条会话显示在哪一行下(项目行,或「任务」分区):一家子跟着根会话那一行走。别的机器上的 agent 可以挂在本机的
   * 会话下面,反过来也一样(owner 2026-10-01),所以各行与「任务」分区的会话合起来建一次树,再按根分回去。
   * 本机的 child 与父会话同一个工作目录,本来就在同一行。
   */
  get placement(): {
    entries: ReadonlyMap<string, SidebarSessionEntry[]>;
    rowOfSession: ReadonlyMap<string, string>;
    nodeById: ReadonlyMap<string, SessionTreeNode<SidebarSessionEntry>>;
    rowOfEntry: ReadonlyMap<string, string>;
    /** 每条会话自己的那一行(不跟着根会话走时:它自己的项目行 / 「任务」分区)。 */
    home: ReadonlyMap<string, string>;
  } {
    const home = new Map<string, string>();
    const all: SidebarSessionEntry[] = [];
    const collect = (rowId: string, entries: SidebarSessionEntry[]) => {
      for (const entry of entries) home.set(entry.id, rowId);
      all.push(...entries);
    };
    for (const ref of this.sidebarProjects) collect(ref.id, this.rowOwnEntries(ref));
    collect(SESSIONS_SECTION, this.standaloneOwnEntries());
    const entries = new Map<string, SidebarSessionEntry[]>();
    const rowOfSession = new Map<string, string>();
    const rowOfEntry = new Map<string, string>();
    const place = (node: SessionTreeNode<SidebarSessionEntry>, rowId: string) => {
      rowOfEntry.set(node.item.id, rowId);
      const list = entries.get(rowId);
      if (list) list.push(node.item);
      else entries.set(rowId, [node.item]);
      if (!rowOfSession.has(node.item.sessionId)) rowOfSession.set(node.item.sessionId, rowId);
      for (const child of node.children) place(child, rowId);
    };
    const forest = buildSessionTree(all);
    const nodeById = new Map<string, SessionTreeNode<SidebarSessionEntry>>();
    const index = (node: SessionTreeNode<SidebarSessionEntry>) => {
      nodeById.set(node.item.id, node);
      for (const child of node.children) index(child);
    };
    for (const root of forest) index(root);
    for (const [rowId, roots] of familiesByRoot(forest, (root) => home.get(root.id)!))
      for (const root of roots) place(root, rowId);
    for (const list of entries.values()) list.sort((a, b) => b.time - a.time);
    return { entries, rowOfSession, nodeById, rowOfEntry, home };
  }

  setJoinedGroups(groups: readonly JoinedGroup[]): void {
    this.joinedGroups = groups;
  }

  /** Visible session members share a frame here; chats and Apps keep their own list. */
  private get activeJoinedGroups(): readonly ProjectJoinedGroup[] {
    const idOf = new Map([...this.placement.nodeById.keys()].map((id) => [blockKey.session(id), id]));
    return this.joinedGroups.flatMap((group) => {
      const sessionIds = group.members.flatMap((key) => idOf.get(key) ?? []);
      const visible = sessionIds.filter((id) => this.anchorVisible(id));
      if (sessionIds.length < 2 || visible.length === 0) return [];
      const ranked = visible.map((id) => ({ id, rank: this.rankOf(id) }));
      const anchor = ranked.reduce((a, b) => (rankBefore(b.rank, a.rank) ? b : a)).id;
      return [{ anchor, sessionIds, onScreen: group.onScreen }];
    });
  }

  /**
   * 一条会话不并组时在这边排在哪(逐位比,小的在上):置顶的在最上面;再按项目在侧栏的次序;项目里开着二级分类时先按状态分档,
   * 再按时间新的在前;挂在下面的会话跟着它的根,同一个根里层级浅的在前。
   */
  private rankOf(sessionId: string): number[] {
    const { nodeById, rowOfEntry } = this.placement;
    let item = nodeById.get(sessionId)?.item;
    let depth = 0;
    let pinned = false;
    while (item) {
      pinned = pinned || item.isPinned;
      const parent = item.parentSessionId ? nodeById.get(item.parentSessionId)?.item : undefined;
      if (!parent) break;
      item = parent;
      depth += 1;
    }
    if (!item) return [Infinity];
    if (pinned) return [0, -item.time, depth];
    const project = this.sidebarProjects.findIndex((ref) => ref.id === rowOfEntry.get(item.id));
    const bucket = this.stateGroupsEnabled ? [...SIDEBAR_STATE_GROUP_ORDER, null].indexOf(item.group) : 0;
    return [1, project < 0 ? Infinity : project, bucket, -item.time, depth];
  }

  /** anchor 那一行此刻画不画得出来:往上每一级父会话都展开着,所在的分区 / 项目也展开着(置顶的就看置顶区)。 */
  private anchorVisible(anchorId: string): boolean {
    const { nodeById, rowOfEntry } = this.placement;
    let current = nodeById.get(anchorId)?.item;
    while (current) {
      if (current.isPinned) return !this.pinnedCollapsed;
      const parent = current.parentSessionId ? nodeById.get(current.parentSessionId)?.item : undefined;
      if (!parent) break;
      if (!this.expandedSessionIds.has(parent.id)) return false;
      current = parent;
    }
    if (!current) return false;
    const row = rowOfEntry.get(current.id);
    if (row === undefined) return false;
    if (row === SESSIONS_SECTION) return !this.sessionsCollapsed;
    return !this.projectsCollapsed && this.expandedProjectIds.has(row);
  }

  /** 这条会话此刻挂在谁下面(侧栏建树的那条边);根 / 侧栏里没有 = null。 */
  parentOf(sessionId: string): string | null {
    return this.placement.nodeById.get(sessionId)?.item.parentSessionId ?? null;
  }

  /**
   * 这条会话不挂在谁下面时显示在哪一行:项目行 id,「任务」分区为 null;侧栏里没有 = undefined。
   * 把挂着的会话拖回这一行 = 回到根(spec session-page「把会话拖成 child」)。
   */
  rootRowOf(sessionId: string): string | null | undefined {
    const row = this.placement.home.get(sessionId);
    return row === undefined ? undefined : row === SESSIONS_SECTION ? null : row;
  }

  /** `sessionId` 就是 `ancestorId`,或挂在它下面(往上走父会话那条边):把 ancestor 挂到它下面会成环。 */
  isWithin(sessionId: string, ancestorId: string): boolean {
    const seen = new Set<string>();
    for (let at: string | null = sessionId; at && !seen.has(at); at = this.parentOf(at)) {
      if (at === ancestorId) return true;
      seen.add(at);
    }
    return false;
  }

  /** 成框的组里的每一条(anchor 与组员)。 */
  private get joinedIds(): ReadonlySet<string> {
    return new Set(this.activeJoinedGroups.flatMap((group) => group.sessionIds));
  }

  /** 挪进别人框里的组员(不是 anchor 的那些):从原位置摘掉。 */
  private get joinedAway(): ReadonlySet<string> {
    return new Set(this.activeJoinedGroups.flatMap((group) => group.sessionIds.filter((id) => id !== group.anchor)));
  }

  /**
   * 一棵树里摘掉挪走的组员,它的子会话跟着它进框 —— 只有一种例外:它下面有某一组的 anchor(连同 anchor 那一家),
   * 那一家留在原处、顶到它的位置上,框跟着 anchor 走(❌ 连 anchor 一起摘掉,整组哪儿都看不见)。
   */
  private withoutJoinedAway(roots: readonly SessionTreeNode<SidebarSessionEntry>[]): SessionTreeNode<SidebarSessionEntry>[] {
    const away = this.joinedAway;
    if (away.size === 0) return [...roots];
    const anchors = new Set(this.activeJoinedGroups.map((group) => group.anchor));
    const hasAnchor = (node: SessionTreeNode<SidebarSessionEntry>): boolean =>
      anchors.has(node.item.id) || node.children.some(hasAnchor);
    const prune = (nodes: readonly SessionTreeNode<SidebarSessionEntry>[]): SessionTreeNode<SidebarSessionEntry>[] =>
      nodes.flatMap((node) => {
        const children = prune(node.children);
        return away.has(node.item.id) ? children.filter(hasAnchor) : [{ item: node.item, children }];
      });
    return prune(roots);
  }

  /**
   * 框摆在 anchor 原来的位置:anchor 那一家换成整组 —— 组员按屏上次序、各带自己展开着的子会话,与 anchor 同一层、
   * 同一档(按状态分组时框整个留在 anchor 那一档);每一行记下自己是框的哪一段。
   * 别的组的人不跟进这个框:anchor 那一家里另一组的 anchor(连同它那一家)排在框后面,组员带子会话时跳过别的组的人。
   * 外层的组先排(anchor 层级浅的先),里层那组的 anchor 已经被挪到框后面,再排它自己的框。
   */
  private spliceJoined<T extends SidebarSessionRow | SessionEntry>(rows: T[], toRow: (row: SidebarSessionRow) => T): T[] {
    const groups = this.activeJoinedGroups;
    if (groups.length === 0) return rows;
    const out = [...rows];
    const nodeById = this.placement.nodeById;
    const expanded = this.expandedSessionIds;
    const joined = this.joinedIds;
    const depthOf = (anchor: string) => out.find((row) => row.sessionId === anchor)?.depth ?? 0;
    const ordered = groups.filter((group) => out.some((row) => row.sessionId === group.anchor)).sort((a, b) => depthOf(a.anchor) - depthOf(b.anchor));
    for (const group of ordered) {
      const at = out.findIndex((row) => row.sessionId === group.anchor);
      if (at < 0) continue;
      const anchorRow = out[at];
      const depth = anchorRow.depth ?? 0;
      let end = at + 1;
      while (end < out.length && (out[end].depth ?? 0) > depth) end += 1;
      const own: T[] = [];
      const spill: T[] = [];
      let spillDepth: number | null = null;
      for (let k = at; k < end; k += 1) {
        const row = out[k];
        const d = row.depth ?? 0;
        if (spillDepth !== null && d > spillDepth) {
          spill.push(row);
          continue;
        }
        spillDepth = null;
        if (k > at && joined.has(row.sessionId)) {
          spillDepth = d;
          spill.push(row);
          continue;
        }
        own.push(row);
      }
      const rowGroup = 'group' in anchorRow ? (anchorRow.group as SidebarStateGroup | null) : null;
      const box: T[] = [];
      for (const sessionId of group.sessionIds) {
        if (sessionId === group.anchor) {
          box.push(...own);
          continue;
        }
        const node = nodeById.get(sessionId);
        if (!node) continue;
        const family = (n: SessionTreeNode<SidebarSessionEntry>, d: number, parentProjectId: string | undefined) => {
          const children = n.children.filter((child) => !joined.has(child.item.id));
          box.push(
            toRow({
              projectId: n.item.projectId,
              sessionId: n.item.id,
              group: rowGroup,
              depth: d,
              hasChildren: children.length > 0,
              needsAttention: subtreeNeedsAttention(n),
              parentProjectId,
            })
          );
          if (!expanded.has(n.item.id)) return;
          for (const child of children) family(child, d + 1, n.item.projectId);
        };
        family(node, depth, anchorRow.parentProjectId);
      }
      if (box.length < 2) continue;
      box.forEach((row, i) => {
        row.join = { pos: i === 0 ? 'first' : i === box.length - 1 ? 'last' : 'middle', onScreen: group.onScreen };
      });
      out.splice(at, end - at, ...box, ...spill);
    }
    return out;
  }

  /**
   * 这项任务的会话显示在哪一行下:项目行 id,「任务」分区为 null。不在列表里的(归档的、还没载入的)按它的项目算。
   */
  rowOfSession(projectId: string, sessionId: string): string | null {
    const placed = this.placement.rowOfSession.get(sessionId);
    if (placed !== undefined) return placed === SESSIONS_SECTION ? null : placed;
    const row = this.rowProjectIdOf(projectId);
    return this.isTasksProject(this.projectManager.projects.get(projectId) ?? { id: projectId }) ? null : row;
  }

  /** 一行自己的会话:这个项目的,加上并进这一行的项目的(那台机器的任务工作区)。 */
  private rowOwnEntries(ref: SidebarProjectRef): SidebarSessionEntry[] {
    const folded = this.homeLayout.folded.get(ref.id);
    if (!folded) return this.projectSessionEntries(ref.project);
    const entries = [ref.project.id, ...folded].flatMap((id) => {
      const project = this.projectManager.projects.get(id);
      return project ? this.projectSessionEntries(project) : [];
    });
    return entries.sort((a, b) => b.time - a.time);
  }

  /** Conversation entries of a project's visible tasks, newest interaction first. */
  private projectSessionEntries(project: ProjectStore): SidebarSessionEntry[] {
    const machine = this.machines?.machineOf(project.id) ?? null;
    if (machine) return this.remoteEntries(project.id, machine);
    if (!project.mountedProject) return [];
    const sessions = Array.from(project.mountedProject.sessionManager.sessions.values()).filter(
      (t) =>
        !t.data.automationRunId && (t.state === 'unregistered' || !t.data.archivedAt)
    );
    const entries: SidebarSessionEntry[] = [];
    for (const page of sessions) {
      const sessionId = page.data.id;
      // #7199 住在这台电脑上的个人助理:它自己的会话不进任务区(与别的机器上的同一条规矩,见 remoteEntries)。
      if (this.assistantAgentId && sessionAgentNames.identityFor(sessionId)?.agentUserId === this.assistantAgentId) continue;
      for (const session of pageSessions(page)) {
        entries.push({
          id: session.data.id,
          projectId: project.id,
          sessionId,
          parentSessionId: session.data.parentSessionId,
          isPinned: session.data.isPinned === true,
          time: session.data.lastInteractedAt
            ? new Date(session.data.lastInteractedAt).getTime()
            : 0,
          group: sidebarStateGroup(taskStatusPresentation(
            sessionAgentNames.identityFor(session.data.id)?.agentUserId
              ? { kind: 'agent', agentUserId: sessionAgentNames.identityFor(session.data.id)!.agentUserId }
              : { kind: 'task', reading: session.status ? { status: session.status, detail: session.detail } : null, unseen: !session.seen, online: true },
          )),
          title: sessionAgentNames.displayNameFor(session.data.id, session.data.providerId, session.data.title),
        });
      }
    }
    entries.sort((a, b) => b.time - a.time);
    return entries;
  }

  setAssistantAgentId(id: string | null): void {
    this.assistantAgentId = id;
  }

  setAssistantHomeProjectId(id: string | null): void {
    this.assistantHomeProjectId = id;
  }

  /** 别的机器上一个项目的会话:来自会话目录(列出不挂载),新的在前。个人助理自己的那条不在内(它的子 agent 就成了根)。 */
  private remoteEntries(projectId: string, machine: string): SidebarSessionEntry[] {
    const listed = this.machines?.sessionsOf?.(machine);
    if (!listed) return [];
    const entries: SidebarSessionEntry[] = [];
    for (const session of listed.sessions) {
      if (session.projectId !== projectId) continue;
      if (isAssistantSession(session, this.assistantAgentId)) continue;
      entries.push({
        id: session.conversationId,
        projectId,
        sessionId: session.conversationId,
        parentSessionId: session.parentConversationId ?? null,
        isPinned: session.isPinned === true,
        time: session.lastInteractedAt ? new Date(session.lastInteractedAt).getTime() : 0,
        // Direct-link freshness only governs access; identified agents share presence with avatars.
        group: sidebarStateGroup(sessionPresentation(session, listed.live,
          session.agent?.userId ?? sessionAgentNames.identityFor(session.conversationId)?.agentUserId)),
        title: sessionAgentNames.displayNameFor(session.conversationId, session.harness, session.title),
      });
    }
    entries.sort((a, b) => b.time - a.time);
    return entries;
  }

  /** #7199 这条会话是不是个人助理派出来的(父会话 / 由谁派的,一路往上有它自己的那条)。 */
  launchedByAssistant(projectId: string, sessionId: string): boolean {
    const assistantId = this.assistantAgentId;
    const machine = this.machines?.machineOf(projectId) ?? null;
    if (!assistantId || !machine) return false;
    const sessions = this.machines?.sessionsOf?.(machine)?.sessions ?? [];
    const byId = new Map(sessions.map((session) => [session.conversationId, session]));
    return launchedByAssistant(
      sessionId,
      (id) => {
        const session = byId.get(id);
        return session?.parentConversationId ?? session?.spawnedByConversationId ?? null;
      },
      (id) => {
        const session = byId.get(id);
        return !!session && isAssistantSession(session, assistantId);
      }
    );
  }

  /** 别的机器上的这条会话在目录里的那一行(行组件在会话还没挂载时画它);本机会话 / 目录里没有 = null。 */
  remoteSession(projectId: string, sessionId: string): RemoteSidebarSession | null {
    const machine = this.machines?.machineOf(projectId) ?? null;
    if (!machine) return null;
    const listed = this.machines?.sessionsOf?.(machine);
    const summary = listed?.sessions.find((session) => session.conversationId === sessionId);
    return listed && summary ? { summary, live: listed.live } : null;
  }

  /**
   * `foldKey` 给了(项目 id / SESSIONS_SECTION)就按 foldIdleFamilies 收起多出来的闲置家族;搜索时不收。
   */
  private sessionRows(
    entries: SidebarSessionEntry[],
    foldKey?: string
  ): { rows: SidebarSessionRow[]; folded: number } {
    const trees = this.withoutJoinedAway(withoutPinnedSubtrees(buildSessionTree<SidebarSessionEntry>(entries)));
    const expanded = new Set(this.expandedSessionIds);
    const rows: SidebarSessionRow[] = [];

    const appendVisibleFamily = (
      node: SessionTreeNode<SidebarSessionEntry>,
      rootGroup: SidebarStateGroup | null,
      depth: number,
      parentProjectId?: string
    ) => {
      rows.push({
        projectId: node.item.projectId,
        sessionId: node.item.id,
        group: rootGroup,
        depth,
        hasChildren: node.children.length > 0,
        needsAttention: subtreeNeedsAttention(node),
        parentProjectId,
      });
      if (!expanded.has(node.item.id)) return;
      for (const child of node.children) appendVisibleFamily(child, rootGroup, depth + 1, node.item.projectId);
    };

    // Parentage is the structural axis. A family's root selects its section; descendant status
    // remains a row attribute and propagates attention without splitting the tree.
    //
    // behavior session-page「会话列表与状态」: 关掉二级分类时**这里也得改**,不能只在上层不发组头 ——
    // 这个循环本身就是「先按分组、组内再按时间」的排序器。只摘掉组头会留下一条看不见的分组
    // 顺序:画面上没有标题,顺序却仍是「需要你的排最前」,读起来就是「平铺了但没按时间排」。
    // 关掉时按 `trees` 的自然次序走 —— 那就是 entries 的时间倒序。
    const ordered = this.stateGroupsEnabled
      ? [...SIDEBAR_STATE_GROUP_ORDER, null].flatMap((group) =>
          trees.filter((root) => root.item.group === group)
        )
      : trees;
    // 框摆在 anchor 那一家:那一家不收进「展开显示」(收进去组员就哪儿都看不见了)。
    const anchors = new Set(this.activeJoinedGroups.map((group) => group.anchor));
    const { shown, folded } =
      foldKey
        ? foldIdleFamilies(ordered, (entry) => entry.group === null && !anchors.has(entry.id), this.idleExpandedProjectIds.has(foldKey))
        : { shown: ordered, folded: 0 };
    for (const root of shown) appendVisibleFamily(root, root.item.group, 0);
    return { rows: this.spliceJoined(rows, (row) => row), folded };
  }

  /**
   * spec session-page 链6: count of conversations waiting on the human, for the amber dot on a
   * collapsed project row. Raw status only — viewing a conversation never clears it.
   */
  needsYouCountForProject(projectId: string): number {
    const entries = this.placement.entries.get(projectId) ?? [];
    return entries.filter((e) => e.group === 'needs-you').length;
  }

  toggleIdleExpanded(foldKey: string): void {
    if (this.idleExpandedProjectIds.has(foldKey)) {
      this.idleExpandedProjectIds.delete(foldKey);
    } else {
      this.idleExpandedProjectIds.add(foldKey);
    }
  }

  toggleSessionExpanded(sessionId: string): void {
    if (this.expandedSessionIds.has(sessionId)) {
      this.expandedSessionIds.delete(sessionId);
    } else {
      this.expandedSessionIds.add(sessionId);
    }
  }

  /**
   * spec session-page: pinned CONVERSATIONS (any project or standalone task) gathered for the
   * sidebar Pinned section, newest interaction first.
   */
  get pinnedSessionEntries(): SessionEntry[] {
    // 所有项目一棵树,❌ 一项 task 一棵、❌ 一个项目一棵:spawn 出来的子会话各住一项 task(#5665),别的机器上的
    // 还在那台机器的项目里(owner 2026-10-01),分开建树它就挂不到父会话下,置顶的父会话展开后看不见自己的孩子。
    const entries: SidebarSessionEntry[] = [];
    for (const project of this.projectManager.projects.values()) {
      const machine = this.machines?.machineOf(project.id) ?? null;
      if (machine) {
        entries.push(...this.remoteEntries(project.id, machine));
        continue;
      }
      if (!project.mountedProject) continue;
      for (const page of project.mountedProject.sessionManager.sessions.values()) {
        const visible =
          page.state === 'unregistered' || !('archivedAt' in page.data && page.data.archivedAt);
        if (!visible) continue;
        for (const session of pageSessions(page)) {
          entries.push({
            id: session.data.id,
            projectId: project.id,
            sessionId: page.data.id,
            parentSessionId: session.data.parentSessionId,
            isPinned: session.data.isPinned === true,
            time: session.data.lastInteractedAt
              ? new Date(session.data.lastInteractedAt).getTime()
              : 0,
            group: sidebarStateGroup(taskStatusPresentation(
              sessionAgentNames.identityFor(session.data.id)?.agentUserId
                ? { kind: 'agent', agentUserId: sessionAgentNames.identityFor(session.data.id)!.agentUserId }
                : { kind: 'task', reading: session.status ? { status: session.status, detail: session.detail } : null, unseen: !session.seen, online: true },
            )),
            title: sessionAgentNames.displayNameFor(session.data.id, session.data.providerId, session.data.title),
          });
        }
      }
    }
    const roots = this.withoutJoinedAway(pinnedSubtreeRoots(buildSessionTree(entries)));
    roots.sort((a, b) => b.item.time - a.item.time);
    const expanded = new Set(this.expandedSessionIds);
    const attentionById = new Map<string, boolean>();
    const collectAttention = (node: SessionTreeNode<SidebarSessionEntry>) => {
      attentionById.set(node.item.id, subtreeNeedsAttention(node));
      for (const child of node.children) collectAttention(child);
    };
    for (const root of roots) collectAttention(root);
    const projectOf = new Map(entries.map((entry) => [entry.id, entry.projectId]));
    const rows: SessionEntry[] = flattenSessionTree(roots, expanded).map((row) => ({
      projectId: row.item.projectId,
      sessionId: row.item.id,
      depth: row.depth,
      hasChildren: row.hasChildren,
      needsAttention: attentionById.get(row.item.id) ?? false,
      parentProjectId: row.depth > 0 ? projectOf.get(row.item.parentSessionId ?? '') : undefined,
    }));
    return this.spliceJoined(rows, publicEntry);
  }

  /**
   * spec session-page「任务分区」: conversations of standalone tasks (sessions created 按任务,
   * not hanging under a project), newest interaction first. Pinned ones live in Pinned instead.
   */
  get standaloneSessionEntries(): SessionEntry[] {
    return this.standaloneSessionRows().map(publicEntry);
  }

  /**
   * 任务区的会话按状态分档,与项目下的会话用同一套(需要你/工作中/已完成 + idle 平铺)。
   * 此前任务区是一条平铺列表、完全没有状态分组 —— 与项目区行为不一致。
   */
  get standaloneSessionGroups(): {
    group: SidebarStateGroup | null;
    entries: SessionEntry[];
  }[] {
    const entries = this.standaloneSessionRows();
    const out: { group: SidebarStateGroup | null; entries: SessionEntry[] }[] = [];
    // 关掉二级分类 = 一条平铺列表,连组头都不出(group 为 null 的那一档本来就不带标题)。
    if (!this.stateGroupsEnabled) {
      const flat = entries.map(publicEntry);
      return flat.length > 0 ? [{ group: null, entries: flat }] : [];
    }
    for (const group of SIDEBAR_STATE_GROUP_ORDER) {
      const bucket = entries.filter((entry) => entry.group === group).map(publicEntry);
      if (bucket.length > 0) out.push({ group, entries: bucket });
    }
    // idle 不给分组标题,平铺在下面(与项目区一致)。
    const idle = entries.filter((entry) => entry.group === null).map(publicEntry);
    if (idle.length > 0) out.push({ group: null, entries: idle });
    return out;
  }

  private standaloneSessionRows(): SidebarSessionRow[] {
    return this.standaloneSection.rows;
  }

  /** 「任务」分区的行与收起的闲置家族数(与项目行同一条折法)。 */
  get standaloneSection(): { rows: SidebarSessionRow[]; folded: number } {
    return this.sessionRows(
      this.placement.entries.get(SESSIONS_SECTION) ?? [],
      SESSIONS_SECTION
    );
  }

  /** 「任务」分区的根任务数(含「展开显示」还没展开的闲置家族):分区头收起时显示它。 */
  get standaloneRootCount(): number {
    const more = this.standaloneMore;
    const roots = this.standaloneSection.rows.filter((row) => !row.depth).length;
    return roots + (more && !more.expanded ? more.hiddenCount : 0);
  }

  /** 「项目」分区的项目数,跟着搜索走(链8 section counts track matches):分区头收起时显示它。 */
  get projectCount(): number {
    return this.sidebarRows.filter((row) => row.kind === 'project').length;
  }

  /** 「任务」分区的「展开显示」行;没有收起的家族 = null。 */
  get standaloneMore(): { foldKey: string; expanded: boolean; hiddenCount: number } | null {
    const { folded } = this.standaloneSection;
    if (folded === 0) return null;
    return {
      foldKey: SESSIONS_SECTION,
      expanded: this.idleExpandedProjectIds.has(SESSIONS_SECTION),
      hiddenCount: folded,
    };
  }

  /** 独立会话及助理家里的执行者。隐藏家目录项目行时,不能连同其中的任务一起摘掉。 */
  private standaloneOwnEntries(): SidebarSessionEntry[] {
    return [...this.projectManager.projects.values()]
      .filter((project) => this.isTasksProject(project))
      .flatMap((project) => this.projectSessionEntries(project))
      .sort((a, b) => b.time - a.time);
  }

  /**
   * #609 会话列在「任务」里的项目:每台机器上的 workspace(并进个人助理那一行的除外),加本机助理的家。
   * 「任务」是一张平铺的表,❌ 按机器分组。
   */
  private isTasksProject(project: { id: string; data?: { kind?: string } | null }): boolean {
    const { homeRows, rowOf } = this.homeLayout;
    if (homeRows.has(project.id) || rowOf.has(project.id)) return false;
    return isWorkspaceProject(project) || (!this.isRemote(project.id) && project.id === this.assistantHomeProjectId);
  }

  togglePinnedCollapsed(): void {
    this.pinnedCollapsed = !this.pinnedCollapsed;
  }

  toggleProjectsCollapsed(): void {
    this.projectsCollapsed = !this.projectsCollapsed;
  }

  toggleSessionsCollapsed(): void {
    this.sessionsCollapsed = !this.sessionsCollapsed;
  }

  toggleChatsCollapsed(): void {
    this.chatsCollapsed = !this.chatsCollapsed;
  }

  setListLayout(layout: SidebarListLayout): void {
    this.listLayout = layout;
  }

  setListPage(page: SidebarListPage): void {
    this.listPage = page;
  }

  /** 「项目」页签上的琥珀点:各项目里在等你的会话数(与收起的项目行那颗同一个读数)。 */
  get projectsNeedYouCount(): number {
    return this.sidebarProjects.reduce((sum, ref) => sum + this.needsYouCountForProject(ref.id), 0);
  }

  setStateGroupsEnabled(enabled: boolean): void {
    this.stateGroupsEnabled = enabled;
  }

  setAgentNameOnHoverEnabled(enabled: boolean): void {
    this.agentNameOnHoverEnabled = enabled;
  }

  get isEmpty(): boolean {
    return this.sidebarProjects.length === 0;
  }

  get snapshot(): SidebarSnapshot {
    return {
      expandedProjectIds: [...this.expandedProjectIds],
      expandedSessionIds: [...this.expandedSessionIds],
      projectOrder: [...this.projectOrder],
      sessionOrderByProject: { ...this.sessionOrderByProject },
      sessionSortBy: this.sessionSortBy,
      pinnedCollapsed: this.pinnedCollapsed,
      projectsCollapsed: this.projectsCollapsed,
      sessionsCollapsed: this.sessionsCollapsed,
      chatsCollapsed: this.chatsCollapsed,
      listLayout: this.listLayout,
      listPage: this.listPage,
    };
  }

  restoreSnapshot(snapshot: Partial<SidebarSnapshot>): void {
    if (snapshot.expandedProjectIds !== undefined) {
      this.expandedProjectIds.replace(snapshot.expandedProjectIds);
    }
    if (snapshot.expandedSessionIds !== undefined) {
      this.expandedSessionIds.replace(snapshot.expandedSessionIds);
    }
    if (snapshot.projectOrder !== undefined) {
      this.projectOrder = [...snapshot.projectOrder];
    }
    if (snapshot.sessionOrderByProject !== undefined) {
      this.sessionOrderByProject = { ...snapshot.sessionOrderByProject };
    }
    if (snapshot.sessionSortBy !== undefined) {
      const v = parseSidebarSessionSortBy(snapshot.sessionSortBy);
      if (v !== undefined) this.sessionSortBy = v;
    }
    if (typeof snapshot.pinnedCollapsed === 'boolean') this.pinnedCollapsed = snapshot.pinnedCollapsed;
    if (typeof snapshot.projectsCollapsed === 'boolean') {
      this.projectsCollapsed = snapshot.projectsCollapsed;
    }
    if (typeof snapshot.sessionsCollapsed === 'boolean') this.sessionsCollapsed = snapshot.sessionsCollapsed;
    if (typeof snapshot.chatsCollapsed === 'boolean') this.chatsCollapsed = snapshot.chatsCollapsed;
    if (snapshot.listLayout === 'split' || snapshot.listLayout === 'merged') this.listLayout = snapshot.listLayout;
    if (snapshot.listPage === 'projects' || snapshot.listPage === 'chats') this.listPage = snapshot.listPage;
  }

  /** Called on first load when no snapshot exists — expand all known projects. */
  expandAllProjects(): void {
    for (const ref of this.sidebarProjects) {
      this.expandedProjectIds.add(ref.id);
    }
  }

  toggleProjectExpanded(projectId: string): void {
    if (this.expandedProjectIds.has(projectId)) {
      this.expandedProjectIds.delete(projectId);
    } else {
      this.expandedProjectIds.add(projectId);
    }
  }

  ensureProjectExpanded(projectId: string): void {
    this.expandedProjectIds.add(this.rowProjectIdOf(projectId));
  }

  /**
   * A navigation (never a restore or a remount) arrived at `target`, or at a non-task view (`null`).
   * Arriving at a task other than the last one opens the project row its session hangs under; a
   * task whose sessions all sit in Pinned opens nothing — they are not in the project tree.
   */
  revealActiveSession(target: { projectId: string; sessionId: string } | null): void {
    const key = target ? `${target.projectId}\u0000${target.sessionId}` : null;
    if (key === this.revealedSessionKey) return;
    this.revealedSessionKey = key;
    if (!target) return;
    const row = this.rowOfSession(target.projectId, target.sessionId);
    if (row !== null && this.sessionHangsUnderRow(row, target.sessionId)) this.expandedProjectIds.add(row);
  }

  /** Whether this project row would show one of the task's sessions (none loaded yet counts as yes). */
  private sessionHangsUnderRow(rowId: string, sessionId: string): boolean {
    const ref = this.sidebarProjects.find((candidate) => candidate.id === rowId);
    if (!ref) return false;
    const entries = this.projectEntries(ref);
    if (!entries.some((entry) => entry.sessionId === sessionId)) return true;
    const hangsHere = (nodes: SessionTreeNode<SidebarSessionEntry>[]): boolean =>
      nodes.some((node) => node.item.sessionId === sessionId || hangsHere(node.children));
    return hangsHere(withoutPinnedSubtrees(buildSessionTree(entries)));
  }

  /** behavior session-page「键盘导航」: ← on a project row collapses it, so the keyboard skips it whole. */
  collapseProject(projectId: string): void {
    this.expandedProjectIds.delete(projectId);
  }

  /** Walk past a "Show more" row rather than dead-ending on it. */
  ensureIdleExpanded(foldKey: string): void {
    this.idleExpandedProjectIds.add(foldKey);
  }

  setSessionSortBy(sortBy: SidebarSessionSortBy): void {
    this.sessionSortBy = sortBy;
  }

  /** Set the sort key and clear all manual task orders so the list fully re-sorts. */
  applySort(sortBy: SidebarSessionSortBy): void {
    this.sessionSortBy = sortBy;
    this.sessionOrderByProject = {};
  }

  setProjectOrder(ids: string[]): void {
    this.projectOrder = ids;
  }

  setSessionOrder(projectId: string, orderedIds: string[]): void {
    this.sessionOrderByProject = { ...this.sessionOrderByProject, [projectId]: orderedIds };
  }

  private compareSidebarProjects(a: ProjectStore, b: ProjectStore): number {
    const d = b.createdAt.localeCompare(a.createdAt);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  }
}
