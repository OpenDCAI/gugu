// gugu #2525: 共享 Session Composer 的「创建上下文」托盘 —— 设备 · 项目两个按需披露的选择器。
// 设备那一格是全 app 共用的机器选择器(remote-hosts/machine-picker 的 compact 尺寸),这里只放项目选择器。
//
// 规范（#2505 product spec §共享创建器 / §设备与项目默认值）要求各创建入口复用同一套创建能力，
// 所以托盘控件抽在这里共用：新建页 new-session-page.tsx、项目页、对话里派任务都用它(#6264 起也能选别的机器)。
// 选了别的机器时,项目选择器还是**同一种菜单**(搜索 → 列表 → 底部动作),只是内容换成那台机器的。
// ❌ 不各写一份：两份一旦分叉，「记住最近一次选择」就会在两个入口给出不同答案。
//
// 设备维度的数据与 per-user 记忆都在 gugu 侧（identity.gugu_devices + identity.user_settings）；
// 这里只负责渲染与回调。
import { nameTwinIds } from '@renderer/features/projects/name-twins';
import { AlertTriangle, ChevronDown, Clock, Folder, Plus, Search, Users, X } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import {
  ProjectCreationMenuItems,
  type ProjectCreationMachine
} from '@renderer/features/projects/components/project-creation-menu-items';
import {
  getProjectStore,
  projectDisplayName
} from '@renderer/features/projects/stores/project-selectors';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@renderer/lib/ui/dropdown-menu';
import { sessionComposerTrayTriggerClassName } from './session-composer-styles';
import { Skeleton } from '@/components/assistant-ui/ui/skeleton';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { machineRegistry } from '@renderer/lib/machine-routing';

/**
 * 当前设备上可用的项目 = 这台电脑上已挂载的项目。托盘只展示这一份，别处不再自己过滤一遍。
 * 别的机器上的项目(#6264,同一张项目表)由那台机器的项目选择器列(use-machine-create-target.tsx)。
 */
export function mountedProjects(includeRemote = false) {
  return sidebarStore.orderedProjects.filter((p) => p.state === 'mounted' && (includeRemote || machineRegistry.machineOf(p.id) === null));
}

/** 菜单顶上的搜索框 —— 本机与别的机器的项目选择器同一个。 */
function TrayMenuSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-[var(--em-surface-input)] px-3 py-2">
      <Search className="size-3.5 shrink-0 text-foreground-muted" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // 拦住普通按键,免得被菜单的 typeahead 抢走;但 Escape/Tab 必须放行,
        // 否则在搜索框里按 Esc 关不掉下拉(一律 stopPropagation 就是这个 bug)。
        onKeyDown={(e) => {
          if (e.key !== 'Escape' && e.key !== 'Tab') e.stopPropagation();
        }}
        placeholder={placeholder}
        className="w-full bg-transparent text-sm outline-none placeholder:text-foreground-muted"
      />
    </div>
  );
}

/**
 * 这次建的 agent 进哪个群(在群里派任务 / 群成员里点的「新建 Agent」):建好就进群,结果回这个群。
 * gugu-dev#181:❌「不加入」—— 不进群,结果就回不来。只是一枚说明,不是选择。
 */
export function ComposerBirthGroupChip({ name }: { name: string }) {
  const { translate } = useSessionMessages();
  return (
    <span className={sessionComposerTrayTriggerClassName} title={translate('newAgent.birthGroupHint')} data-testid="composer-birth-group">
      <Users className="size-3 shrink-0" />
      <span className="max-w-[200px] truncate">{name}</span>
    </span>
  );
}

export const ComposerProjectPicker = observer(function ComposerProjectPicker({
  selectedId,
  onSelect,
  unavailableHint,
  allowNone = true,
  includeRemote = false
}: {
  selectedId: string | undefined;
  onSelect: (projectId: string | undefined) => void;
  /** 非空 = 所选设备的项目列表读不到，展示这句话而不是一份不属于它的列表。 */
  unavailableHint?: string | null;
  /** 项目页:这一页就是某个项目的,没有「不选项目」这一项。 */
  allowNone?: boolean;
  /** 项目首页选择抽象项目,包含只有远端文件夹的项目。 */
  includeRemote?: boolean;
}) {
  const { translate } = useSessionMessages();
  const projects = mountedProjects(includeRemote);
  const [projectQuery, setProjectQuery] = useState('');
  // 搜索按显示名过滤。
  const visibleProjects = projectQuery.trim()
    ? projects.filter((p) =>
        (projectDisplayName(p) ?? p.id).toLowerCase().includes(projectQuery.trim().toLowerCase())
      )
    : projects;
  const displayName = selectedId ? (projectDisplayName(getProjectStore(selectedId)) ?? translate('task.projectFallbackName')) : null;
  const twins = nameTwinIds(projects.map((p) => ({ id: p.id, name: projectDisplayName(p) })));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className={sessionComposerTrayTriggerClassName}>
            <Folder className="size-3 shrink-0" />
            <span className="max-w-[240px] truncate">{selectedId ? displayName : translate('task.projectNone')}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        }
      />
      {/* 三段式:搜索框 → 项目列表 → 分隔线 + 新建项目(带 › 进二级)。 */}
      {/* 向上展开(owner #11):选择器是贴在 composer 顶边的 tab,向下会盖住输入框 → side=top
          让菜单往上开、露出 composer;空间不够时 Base UI Positioner 自动翻回下方。 */}
      <DropdownMenuContent side="top" className="min-w-64 p-0">
        {unavailableHint ? (
          <div className="px-3 py-2 text-xs text-foreground-muted">{unavailableHint}</div>
        ) : (
          <>
            <TrayMenuSearch
              value={projectQuery}
              onChange={setProjectQuery}
              placeholder={translate('task.projectSearchPlaceholder')}
            />
            <div className="max-h-64 overflow-y-auto py-1">
              {allowNone ? (
                <DropdownMenuItem onClick={() => onSelect(undefined)}>
                  <X className="size-3.5" />
                  <span>{translate('task.projectSkip')}</span>
                </DropdownMenuItem>
              ) : null}
              {visibleProjects.length === 0 ? (
                projects.length > 0 ? (
                  <div className="px-3 py-2 text-xs text-foreground-muted">
                    {translate('task.projectNoMatch')}
                  </div>
                ) : null
              ) : (
                visibleProjects.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => onSelect(p.id)} title={twins.has(p.id) ? p.data?.path : undefined}>
                    <Folder className="size-3.5" />
                    <span className="truncate">{projectDisplayName(p) ?? p.id}</span>
                    {/* 同名的(两台机器上各有一个「repo」)带上路径区分,与侧栏同一个判据;不同名不带。 */}
                    {twins.has(p.id) ? (
                      <small className="ml-auto min-w-0 max-w-[55%] shrink truncate pl-3 text-foreground-passive">{p.data?.path}</small>
                    ) : null}
                  </DropdownMenuItem>
                ))
              )}
            </div>
            <NewProjectSubmenu onProjectReady={onSelect} />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/**
 * 菜单底部「新建项目 ›」:新建空白项目 / 使用现有文件夹。本机与别的机器同一个;选了别的机器就建在那台机器上
 * (空白项目在那台机器的默认项目目录下,现有文件夹浏览那台机器的)。
 */
function NewProjectSubmenu({
  onProjectReady,
  machine = null,
  disabled = false,
}: {
  onProjectReady: (projectId: string) => void;
  machine?: ProjectCreationMachine | null;
  disabled?: boolean;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="border-t border-border py-1">
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={disabled} data-testid="project-create-menu">
          <Plus className="size-3.5" />
          <span>{translate('task.projectNew')}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-52">
          <ProjectCreationMenuItems onProjectReady={onProjectReady} machine={machine} disabled={disabled} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </div>
  );
}

/**
 * #6264 所选机器是另一台时的项目选择:**同一个托盘按钮、同一种菜单**(搜索 → 列表 → 底部动作),
 * 内容换成那台机器的 —— 这台桌面上最近在那台机器用过的文件夹、那台机器上已有的项目;底部同一个
 * 「新建项目 ›」,建在那台机器上(目录选择器由宿主画,见 remoteHostsStore.pickFolder)。
 * 取值是那台机器上的目录路径;不选(null)= 那台机器的任务工作区(#609,与本机一样「未选择项目」,会话列在「任务」里)。
 * 人亲手选了那台机器的主目录(~)就是在那里建项目(owner 10-28),与别的文件夹一样。
 */
export function ComposerRemoteProjectPicker({
  selectedPath,
  projects,
  recentPaths = [],
  loading,
  failed = false,
  offline = false,
  onRetry,
  onSelect,
  machine
}: {
  selectedPath: string | null;
  projects: Array<{ id: string; name: string; path: string }>;
  /** 这台桌面上最近在那台机器用过的文件夹(新的在前)。 */
  recentPaths?: readonly string[];
  loading: boolean;
  /** 问那台机器「有哪些项目」没问到(掉线、超时)。 */
  failed?: boolean;
  /** 那台机器此刻离线:问不到它有哪些项目,只剩这台桌面记得的「最近用过」。 */
  offline?: boolean;
  onRetry?: () => void;
  onSelect: (path: string | null) => void;
  /** 「新建项目 ›」建在哪台机器上。 */
  machine: ProjectCreationMachine;
}) {
  const { translate } = useSessionMessages();
  const [query, setQuery] = useState('');
  const entries = remoteProjectEntries(projects, recentPaths);
  const visible = filterRemoteProjectEntries(entries, query);
  const recent = visible.filter((entry) => entry.recent);
  const others = visible.filter((entry) => !entry.recent);
  const label = selectedPath
    ? projects.find((project) => project.path === selectedPath)?.name ?? folderName(selectedPath)
    : translate('task.projectNone');
  const renderEntry = (entry: RemoteProjectEntry) => (
    <DropdownMenuItem key={entry.path} onClick={() => onSelect(entry.path)} title={entry.path}>
      {entry.recent ? <Clock className="size-3.5" /> : <Folder className="size-3.5" />}
      <span className="min-w-0 truncate">{entry.name}</span>
      <small className="ml-auto min-w-0 max-w-[55%] shrink truncate pl-3 text-foreground-passive">
        {entry.path}
      </small>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) setQuery(''); }}>
      <DropdownMenuTrigger
        render={
          <button type="button" className={sessionComposerTrayTriggerClassName} data-testid="agent-create-project-picker">
            <Folder className="size-3 shrink-0" />
            <span className="max-w-[240px] truncate" title={selectedPath ?? undefined}>{label}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
        }
      />
      <DropdownMenuContent side="top" className="min-w-72 p-0">
        <TrayMenuSearch value={query} onChange={setQuery} placeholder={translate('task.projectSearchPlaceholder')} />
        <div className="max-h-72 overflow-y-auto py-1">
          <DropdownMenuItem onClick={() => onSelect(null)}>
            <Folder className="size-3.5" />
            <span className="min-w-0 truncate">{translate('task.projectNone')}</span>
          </DropdownMenuItem>
          {recent.length > 0 ? (
            <DropdownMenuGroup>
              <DropdownMenuLabel>{translate('task.projectRecentGroup')}</DropdownMenuLabel>
              {recent.map(renderEntry)}
            </DropdownMenuGroup>
          ) : null}
          {others.length > 0 ? (
            <DropdownMenuGroup>
              {recent.length > 0 ? <DropdownMenuLabel>{translate('task.projectRemoteGroup')}</DropdownMenuLabel> : null}
              {others.map(renderEntry)}
            </DropdownMenuGroup>
          ) : null}
          {offline ? (
            <div className="px-3 py-2 text-xs text-foreground-muted">{translate('task.projectRemoteOffline')}</div>
          ) : loading ? (
            // 读项目清单 = 形状已知的内容在路上 ⇒ 骨架(design.md:Loading is a skeleton),❌ 转圈 + 一行字。
            <div role="status" className="flex flex-col gap-2 px-3 py-2">
              <span className="sr-only">{translate('task.projectRemoteLoading')}</span>
              <Skeleton aria-hidden className="h-4 w-3/5" />
              <Skeleton aria-hidden className="h-4 w-2/5" />
              <Skeleton aria-hidden className="h-4 w-1/2" />
            </div>
          ) : failed ? (
            <DropdownMenuItem
              role="alert"
              // 重试后菜单留着,读回来的项目就在原地出现。
              closeOnClick={false}
              onClick={() => onRetry?.()}
              className="text-xs text-foreground-muted"
            >
              <AlertTriangle className="size-3.5 text-foreground-warning" />
              <span className="min-w-0 flex-1">{translate('task.projectRemoteFailed')}</span>
              {onRetry ? <span className="shrink-0 underline underline-offset-2">{translate('harnessCatalog.retry')}</span> : null}
            </DropdownMenuItem>
          ) : entries.length > 0 && visible.length === 0 ? (
            <div className="px-3 py-2 text-xs text-foreground-muted">{translate('task.projectNoMatch')}</div>
          ) : null}
        </div>
        <NewProjectSubmenu
          machine={machine}
          disabled={offline}
          // 建好的项目按路径选中(这一格的取值是那台机器上的路径)。
          onProjectReady={(projectId) => {
            const path = getProjectStore(projectId)?.data?.path;
            if (path) onSelect(path);
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type RemoteProjectEntry = { path: string; name: string; recent: boolean };

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * 最近用过的在前(新的在前),然后是那台机器上已有、但最近没用过的项目(按名字);同一个路径只出现一次。
 * 最近那条的名字优先取那台机器上项目的名字 —— 与侧栏里那台机器的项目行叫法一致。
 */
export function remoteProjectEntries(
  projects: ReadonlyArray<{ name: string; path: string }>,
  recentPaths: readonly string[]
): RemoteProjectEntry[] {
  const norm = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);
  const byPath = new Map(projects.filter((p) => p.path).map((p) => [norm(p.path), p.name]));
  const seen = new Set<string>();
  const result: RemoteProjectEntry[] = [];
  for (const raw of recentPaths) {
    const path = norm(raw);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push({ path, name: byPath.get(path) ?? folderName(path), recent: true });
  }
  const rest = projects
    .filter((p) => p.path && !seen.has(norm(p.path)))
    .map((p) => ({ path: norm(p.path), name: p.name, recent: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of rest) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    result.push(entry);
  }
  return result;
}

/** 搜索按名字或路径过滤(远端项目常见同名不同路径,只按名字搜分不开)。 */
export function filterRemoteProjectEntries(entries: RemoteProjectEntry[], query: string): RemoteProjectEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) => entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q));
}
