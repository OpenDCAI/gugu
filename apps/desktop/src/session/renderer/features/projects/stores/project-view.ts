import { makeAutoObservable } from 'mobx';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import type { IssueProviderType } from '@shared/issue-providers';
import type { ProjectViewSnapshot } from '@shared/view-state';

// 「项目设置」入口 2026-09-10 下线(owner:现有这几项基本不是我们想要的,先不展示;将来留哪些还没想清楚)。
// 表单与读写代码原样留在 features/projects/components/settings-view/ 下,只是没有任何入口通向它;
// 底层默认值(默认分支 / 远程 / 保留文件模式 / Shell 初始化 / tmux)照旧生效,这里下线的只是那张表。
export type ProjectView = 'tasks' | 'pull-request';

export class ProjectViewStore implements Snapshottable<ProjectViewSnapshot> {
  activeView: ProjectView = 'tasks';
  sessionView: SessionViewStore = new SessionViewStore();
  selectedIssueProvider: IssueProviderType | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  setProjectView(view: ProjectView) {
    this.activeView = view;
  }

  setSelectedIssueProvider(provider: IssueProviderType | null) {
    this.selectedIssueProvider = provider;
  }

  get snapshot(): ProjectViewSnapshot {
    return {
      activeView: this.activeView,
      sessionViewTab: this.sessionView.tab,
      selectedIssueProvider: this.selectedIssueProvider ?? undefined,
    };
  }

  restoreSnapshot(snapshot: Partial<ProjectViewSnapshot>): void {
    // ⚠️ 快照是磁盘上的旧数据,里面可能还停着已经下线的 'settings'。认不出来一律回落 'tasks' ——
    // 否则上次停在项目设置的用户重开项目会拿到一个渲染不出任何分支的空白页,而且没有出口
    // (与 library-view 的 normalizeTab 同一个坑,那次是 #5136 删「技能」tab 留下的)。
    if (snapshot.activeView === 'tasks' || snapshot.activeView === 'pull-request') {
      this.activeView = snapshot.activeView;
    } else if (snapshot.activeView) {
      this.activeView = 'tasks';
    }
    if (snapshot.sessionViewTab) this.sessionView.setTab(snapshot.sessionViewTab);
    if (snapshot.selectedIssueProvider)
      this.selectedIssueProvider = snapshot.selectedIssueProvider as IssueProviderType;
  }
}

class SessionViewStore {
  tab: 'active' | 'archived' = 'active';
  searchQuery: string = '';
  selectedIds: Set<string> = new Set();
  lastSelectedId: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  setTab(tab: 'active' | 'archived') {
    this.tab = tab;
  }

  setSearchQuery(query: string) {
    this.searchQuery = query;
  }

  setSelectedIds(ids: Set<string>) {
    this.selectedIds = ids;
    this.lastSelectedId = null;
  }

  toggleSelect(id: string) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    this.lastSelectedId = id;
  }

  selectRange(orderedIds: string[], toId: string) {
    const anchor = this.lastSelectedId;
    if (!anchor || anchor === toId) {
      this.toggleSelect(toId);
      return;
    }
    const fromIndex = orderedIds.indexOf(anchor);
    const toIndex = orderedIds.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) {
      this.toggleSelect(toId);
      return;
    }
    const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
    this.selectedIds = new Set(orderedIds.slice(start, end + 1));
  }
}
