import type { ShortcutSettingsKey } from '@shared/shortcuts';

export interface CommandDef {
  id: string;
  label: string;
  /**
   * 命令面板里写什么:和这件事在侧栏 / 壳里那个入口同一个文案键(会话页的键,或 `main:` 打头的壳的键),
   * 跟着界面语言走;给了就不用 `label`(那是英文的内部名字)。
   */
  labelKey?: string;
  description?: string;
  group?: string;
  scope: 'app' | 'project' | 'task' | 'session-sub';
  shortcutKey?: ShortcutSettingsKey;
  /** Token resolved to a LucideIcon by the renderer's COMMAND_ICONS map. */
  iconKey?: string;
}

/**
 * Preserves literal tuple types for exhaustive ID unions while widening each
 * value to the full CommandDef interface.
 */
function defineCommandDefs<const T extends readonly CommandDef[]>(defs: T): T {
  return defs;
}

export const APP_COMMAND_DEFS = defineCommandDefs([
  {
    id: 'app.settings',
    label: 'Open Settings',
    labelKey: 'appSettings.settings',
    description: 'Open application settings',
    scope: 'app',
    shortcutKey: 'settings',
    group: 'App',
    iconKey: 'settings',
  },
  {
    id: 'app.library',
    label: 'Open Library',
    labelKey: 'sidebar.library',
    description: 'Open the Library',
    scope: 'app',
    shortcutKey: 'library',
    group: 'App',
    iconKey: 'library',
  },
  {
    id: 'app.newProject',
    label: 'New Project',
    labelKey: 'sidebar.addProject',
    description: 'Add a new local or SSH project',
    scope: 'app',
    shortcutKey: 'newProject',
    group: 'App',
    iconKey: 'folder-plus',
  },
  {
    id: 'app.newSession',
    label: 'New Task',
    labelKey: 'sidebar.newTask',
    description: 'Create a new task in this project',
    scope: 'app',
    shortcutKey: 'newSession',
    group: 'App',
    iconKey: 'square-plus',
  },
  {
    // spec session-page「会话历史」(#6083):取代从前的「导入会话」弹窗。
    id: 'app.sessionHistory',
    label: 'Task history',
    labelKey: 'sidebar.sessionHistory',
    description: '咕咕会话与本机 Claude Code / Codex 会话同处一表:打开、恢复已归档的、导入还没导入的',
    scope: 'app',
    group: 'App',
    iconKey: 'history',
  },
  {
    // gugu-dev#181 ⑯ ⌘K 面板的建议操作:和侧栏「对话」那两行同一个入口、同一个文案键。
    id: 'app.newGroupChat',
    label: 'New group chat',
    labelKey: 'sidebar.newGroupChat',
    description: 'Create a group chat',
    scope: 'app',
    group: 'App',
    iconKey: 'users',
  },
  {
    id: 'app.addContact',
    label: 'Add contact',
    labelKey: 'sidebar.addContact',
    description: 'Add a contact',
    scope: 'app',
    group: 'App',
    iconKey: 'user-plus',
  },
  {
    id: 'app.scheduled',
    label: 'Scheduled',
    labelKey: 'sidebar.scheduled',
    description: 'Open the scheduled tasks',
    scope: 'app',
    group: 'App',
    iconKey: 'clock',
  },
  {
    id: 'app.giveFeedback',
    label: 'Give Feedback',
    labelKey: 'main:shell.feedback',
    description: '把问题反馈给咕咕团队',
    scope: 'app',
    group: 'App',
    iconKey: 'message-square-share',
  },
  {
    id: 'app.toggleTheme',
    label: 'Toggle Theme',
    description: 'Switch between light and dark themes',
    scope: 'app',
    group: 'View',
    iconKey: 'palette',
  },
  {
    id: 'app.navigateBack',
    label: 'Go Back',
    description: 'Navigate to the previous location',
    scope: 'app',
    shortcutKey: 'navigateBack',
    group: 'Navigation',
    iconKey: 'arrow-left',
  },
  {
    id: 'app.navigateForward',
    label: 'Go Forward',
    description: 'Navigate to the next location',
    scope: 'app',
    shortcutKey: 'navigateForward',
    group: 'Navigation',
    iconKey: 'arrow-right',
  },
  {
    id: 'app.showKeyboardShortcuts',
    label: 'Keyboard Shortcuts',
    description: 'Show the keyboard shortcuts cheat sheet',
    scope: 'app',
    shortcutKey: 'showKeyboardShortcuts',
    group: 'App',
    iconKey: 'keyboard',
  },
] as const);

export const SESSION_COMMAND_DEFS = defineCommandDefs([
  {
    // spec session-resume 临时会话视图:任务里「再来一个 agent」= 从当前会话分一支侧边聊天。
    // ❌ 这里不再有「新建会话」——新建必须带首轮,而任务内那个只填标题的弹窗给不出首轮
    // (它建出来的正是重开时谁也救不回来的空壳)。真正的新建走 app.newSession。
    id: 'session.sideSession',
    label: 'Side Chat',
    description: 'Fork the current task into a temporary side chat',
    scope: 'task',
    shortcutKey: 'sideSession',
    group: 'Conversations',
    iconKey: 'message-square-plus',
  },
  {
    id: 'session.sidebarChanges',
    label: 'View Changes',
    description: 'Open the Review tab in the file panel',
    scope: 'task',
    shortcutKey: 'sidebarChanges',
    group: 'View',
    iconKey: 'file-diff',
  },
  {
    id: 'session.sidebarFiles',
    label: 'View Files',
    description: 'Open the Files tab in the file panel',
    scope: 'task',
    shortcutKey: 'sidebarFiles',
    group: 'View',
    iconKey: 'folder-open',
  },
  {
    id: 'session.viewTerminals',
    label: 'View Terminals',
    description: 'Open the terminal drawer',
    scope: 'task',
    group: 'View',
    iconKey: 'terminal',
  },
  {
    id: 'session.toggleTerminalDrawer',
    label: 'Toggle Terminal Drawer',
    description: 'Show or hide the terminal drawer',
    scope: 'task',
    shortcutKey: 'toggleTerminalDrawer',
    group: 'Panel',
    iconKey: 'terminal',
  },
  {
    id: 'session.newTerminal',
    label: 'New Terminal',
    description: 'Create a new terminal session',
    scope: 'task',
    shortcutKey: 'newTerminal',
    group: 'Terminals',
    iconKey: 'square-terminal',
  },
  {
    id: 'session.openBrowser',
    label: 'Open Browser',
    description: 'Open an in-app browser for this task',
    scope: 'task',
    shortcutKey: 'openBrowser',
    group: 'Browser',
    iconKey: 'globe',
  },
  {
    id: 'session.browserGoBack',
    label: 'Browser Back',
    description: 'Go back in the active browser tab',
    scope: 'task',
    group: 'Browser',
    iconKey: 'arrow-left',
  },
  {
    id: 'session.browserGoForward',
    label: 'Browser Forward',
    description: 'Go forward in the active browser tab',
    scope: 'task',
    group: 'Browser',
    iconKey: 'arrow-right',
  },
  {
    id: 'session.browserReload',
    label: 'Reload Browser',
    description: 'Reload the active browser tab',
    scope: 'task',
    group: 'Browser',
    iconKey: 'refresh-cw',
  },
  {
    id: 'session.browserFocusUrl',
    label: 'Focus Browser URL',
    description: 'Focus the URL field in the active browser tab',
    scope: 'task',
    group: 'Browser',
    iconKey: 'text-cursor-input',
  },
  {
    id: 'session.browserOpenExternal',
    label: 'Open Browser URL Externally',
    description: 'Open the active browser URL in the system browser',
    scope: 'task',
    group: 'Browser',
    iconKey: 'external-link',
  },
  {
    id: 'session.browserCopyUrl',
    label: 'Copy Browser URL',
    description: 'Copy the active browser URL',
    scope: 'task',
    shortcutKey: 'browserCopyUrl',
    group: 'Browser',
    iconKey: 'copy',
  },
  {
    id: 'session.gitFetch',
    label: 'Git Fetch',
    description: 'Fetch latest changes from remote',
    scope: 'task',
    group: 'Git',
    iconKey: 'git-pull-request',
  },
  {
    id: 'session.gitPull',
    label: 'Git Pull',
    description: 'Pull latest changes from remote',
    scope: 'task',
    group: 'Git',
    iconKey: 'arrow-down-to-line',
  },
  {
    id: 'session.gitPush',
    label: 'Git Push',
    description: 'Push commits to remote',
    scope: 'task',
    group: 'Git',
    iconKey: 'arrow-up-to-line',
  },
  {
    id: 'task.pin',
    label: 'Pin Task',
    description: 'Pin this task to keep it at the top',
    scope: 'task',
    group: 'Task',
    iconKey: 'pin',
  },
  {
    id: 'task.archive',
    label: 'Archive Task',
    description: 'Archive the current task',
    scope: 'task',
    shortcutKey: 'archiveSession',
    group: 'Task',
    iconKey: 'archive',
  },
  {
    id: 'session.convertAutomation',
    label: 'Convert to Regular Task',
    description: 'Detach this task from its automation run',
    scope: 'task',
    group: 'Task',
    iconKey: 'message-square',
  },
  {
    id: 'session.focusSidebar',
    label: 'Focus Sidebar',
    description: 'Move focus to the left sidebar',
    scope: 'task',
    shortcutKey: 'focusSidebar',
    group: 'Navigation',
    iconKey: 'panel-left',
  },
  {
    id: 'session.focusComposer',
    label: 'Focus Composer',
    description: 'Focus the message composer input',
    scope: 'task',
    shortcutKey: 'focusComposer',
    group: 'Navigation',
    iconKey: 'text-cursor-input',
  },
  {
    id: 'session.addContext',
    label: 'Add Context',
    description: 'Open the context picker for the active task',
    scope: 'session-sub',
    shortcutKey: 'addContext',
    group: 'Conversations',
    iconKey: 'list-plus',
  },
  {
    id: 'session.stageAll',
    label: 'Stage All Files',
    description: 'Stage all unstaged files',
    scope: 'task',
    shortcutKey: 'stageAll',
    group: 'Git',
    iconKey: 'git-commit',
  },
  {
    id: 'session.timelineNext',
    label: 'Next Timeline Entry',
    description: 'Jump to the next timeline entry',
    scope: 'task',
    shortcutKey: 'timelineNext',
    group: 'Navigation',
    iconKey: 'chevron-down',
  },
  {
    id: 'session.timelinePrev',
    label: 'Previous Timeline Entry',
    description: 'Jump to the previous timeline entry',
    scope: 'task',
    shortcutKey: 'timelinePrev',
    group: 'Navigation',
    iconKey: 'chevron-up',
  },
] as const);

export const ALL_COMMAND_DEFS = [...APP_COMMAND_DEFS, ...SESSION_COMMAND_DEFS] as const;

export type AppCommandId = (typeof APP_COMMAND_DEFS)[number]['id'];
export type SessionCommandId = (typeof SESSION_COMMAND_DEFS)[number]['id'];
export type CommandId = (typeof ALL_COMMAND_DEFS)[number]['id'];
