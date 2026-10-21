import { ProjectManagerStore } from '@renderer/features/projects/stores/project-manager';
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store';
import { NavigationHistoryStore } from './navigation-history-store';
import { NavigationStore } from './navigation-store';
import { ResourceMonitorStore } from './resource-monitor-store';
import { snapshotRegistry, type SnapshotRegistry } from './snapshot-registry';

class AppState {
  readonly projects: ProjectManagerStore;
  readonly sidebar: SidebarStore;
  readonly snapshots: SnapshotRegistry;
  readonly history: NavigationHistoryStore;
  readonly navigation: NavigationStore;
  readonly resourceMonitor: ResourceMonitorStore;

  constructor() {
    this.snapshots = snapshotRegistry;
    this.projects = new ProjectManagerStore();
    // #6264 别的机器上的项目与本机项目在同一张项目表里(按 Zed,机器是项目的属性),侧栏只读这一张。
    this.sidebar = new SidebarStore(this.projects);
    this.history = new NavigationHistoryStore();
    this.navigation = new NavigationStore();
    this.resourceMonitor = new ResourceMonitorStore();
    snapshotRegistry.register('navigation', () => this.navigation.snapshot);
    snapshotRegistry.register('sidebar', () => this.sidebar.snapshot);
  }
}

export const appState = new AppState();

// Re-export for callers that previously imported sidebarStore from sidebar-store.ts.
export const sidebarStore = appState.sidebar;
