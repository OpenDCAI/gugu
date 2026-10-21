import { isMacHost } from './host-os';

/**
 * APP_SHORTCUTS — central registry of keyboard shortcut metadata.
 *
 * `defaultHotkey` uses TanStack Hotkeys string format (e.g. 'Mod+K'), or a
 * factory function that is evaluated at call-time so defaults can vary by OS
 * or keyboard layout.
 */

/** Only the distinction the defaults actually turn on: macOS puts the primary commands on ⌘. */
export type ShortcutPlatform = 'mac' | 'other';

/**
 * @@@host-os — 只是把唯一那条系统探针(`./host-os`)收窄到这里真正需要的那一档区分。
 * ❌ 别在这里再写一遍 navigator/process 的判断:那正是 2026-09-19 收掉的八处之一。
 */
export function detectShortcutPlatform(): ShortcutPlatform {
  return isMacHost() ? 'mac' : 'other';
}

/**
 * behavior session-page「键盘导航」: the rename / pin / archive keys on a session row.
 *
 * macOS keeps Control, which is what the owner asked for and is free there — ⌘ carries the primary
 * commands. On Windows and Linux Control *is* the primary modifier and all three are already spoken
 * for: Ctrl+R is the Electron default menu's Reload (this app never calls `setApplicationMenu`, and
 * it does ship nsis and AppImage builds), Ctrl+P is this registry's own `openFile`, and Ctrl+X is
 * the platform's Cut. Alt is the spare modifier there, and unlike macOS's Option it does not rewrite
 * `event.key` (⌥R yields '®'), so the letter — the half worth remembering — survives the move.
 */
export function sessionActionDefault(
  letter: 'R' | 'P' | 'X',
  platform: ShortcutPlatform
): string {
  return platform === 'mac' ? `Control+${letter}` : `Alt+${letter}`;
}

export interface AppShortcutDef {
  defaultHotkey?: string | ((platform: ShortcutPlatform) => string);
  label: string;
  description: string;
  category: string;
  hideFromSettings?: boolean;
  conflictBehavior?: 'prevent' | 'allow';
  ignoreWhenMonacoFocused?: boolean;
  ignoreWhenBrowserFocused?: boolean;
}

export type TabNavigationDirection = 'next' | 'previous';

export const TAB_NAVIGATION_HOTKEYS = {
  next: 'Control+Tab',
  previous: 'Control+Shift+Tab',
} as const;

export interface DomTabNavigationInput {
  type: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface ElectronTabNavigationInput {
  type: string;
  key: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

function normalizeShortcutKey(key: string): string {
  return key.toLowerCase();
}

function resolveTabNavigationDirection(input: {
  type: string;
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}): TabNavigationDirection | null {
  if (input.type !== 'keydown' && input.type !== 'keyDown') return null;
  if (normalizeShortcutKey(input.key) !== 'tab') return null;
  if (!input.control || input.alt || input.meta) return null;
  return input.shift ? 'previous' : 'next';
}

export function getDomTabNavigationDirection(
  input: DomTabNavigationInput
): TabNavigationDirection | null {
  return resolveTabNavigationDirection({
    type: input.type,
    key: input.key,
    control: input.ctrlKey,
    shift: input.shiftKey,
    alt: input.altKey,
    meta: input.metaKey,
  });
}

export function getElectronTabNavigationDirection(
  input: ElectronTabNavigationInput
): TabNavigationDirection | null {
  return resolveTabNavigationDirection({
    type: input.type,
    key: input.key,
    control: Boolean(input.control),
    shift: Boolean(input.shift),
    alt: Boolean(input.alt),
    meta: Boolean(input.meta),
  });
}

export function resolveDefaultHotkey(
  def: AppShortcutDef,
  platform: ShortcutPlatform = detectShortcutPlatform()
): string | undefined {
  return typeof def.defaultHotkey === 'function' ? def.defaultHotkey(platform) : def.defaultHotkey;
}

function defineShortcuts<T extends Record<string, AppShortcutDef>>(
  shortcuts: T
): Record<keyof T, AppShortcutDef> {
  return shortcuts as Record<keyof T, AppShortcutDef>;
}

export const APP_SHORTCUTS = defineShortcuts({
  commandPalette: {
    defaultHotkey: 'Mod+K',
    label: 'Command Palette',
    description: 'Open the command palette to quickly search and navigate',
    category: 'Navigation',
  },
  openFile: {
    defaultHotkey: 'Mod+P',
    label: 'Open File',
    description: 'Open the file picker to select a file from the workspace tree',
    category: 'Navigation',
  },
  settings: {
    defaultHotkey: 'Mod+,',
    label: 'Settings',
    description: 'Open application settings',
    category: 'Navigation',
  },
  library: {
    defaultHotkey: 'Mod+L',
    label: 'Library',
    description: 'Open the Library',
    category: 'Navigation',
  },
  /**
   * ⌘B is the code-editor convention — VS Code, Cursor and Zed all toggle the primary side bar with
   * it — and it was this app's first answer. Those editors have nothing else that wants ⌘B; this app
   * does. The composer is TipTap with StarterKit's marks left on, so ⌘B already means "bold" wherever
   * the caret sits, and one keypress both bolded the word and collapsed the sidebar (#5802).
   *
   * Every app that ships a rich composer *and* a collapsible sidebar has already moved off ⌘B:
   * Notion ⌘\, Slack ⌘⇧D, Linear ⌃⇧L, Claude and ChatGPT ⌘⇧S. This takes the last of those — the
   * two nearest peers, chat clients with a model on the other end. (⌘\ is `splitPane` below, VS
   * Code's own convention, worth keeping.)
   *
   * ⌘⇧S was *Strike* in that composer right up until this same change turned the mark off — owner's
   * call, 2026-09-18: nobody was using strikethrough, and nobody could, because the composer
   * serializes to plain text and drops every mark on the way out (#5803). So this chord is free by
   * construction rather than by luck; if the mark ever comes back, the chord has to move.
   *
   * Only the default moves. A user who had already rebound this keeps their binding, and ⌘B is now
   * unclaimed, so anyone who wants the editor chord back can set it in the keyboard settings card.
   */
  toggleLeftSidebar: {
    defaultHotkey: 'Mod+Shift+S',
    label: 'Toggle Left Sidebar',
    description: 'Show or hide the left sidebar',
    category: 'View',
  },
  toggleRightSidebar: {
    defaultHotkey: 'Mod+.',
    label: 'Toggle Right Sidebar',
    description: 'Show or hide the right sidebar',
    category: 'View',
  },
  zenMode: {
    defaultHotkey: 'Control+Z',
    label: 'Zen Mode',
    description: 'Hide both sidebars',
    category: 'View',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  closeModal: {
    defaultHotkey: 'Escape',
    label: 'Close Modal',
    description: 'Close the current modal or dialog',
    category: 'Navigation',
    hideFromSettings: true,
  },
  newSession: {
    defaultHotkey: 'Mod+N',
    label: 'New Task',
    description: 'Create a new task',
    category: 'Navigation',
  },
  archiveSession: {
    defaultHotkey: 'Mod+Shift+E',
    label: 'Archive Task',
    description: 'Archive the current task',
    category: 'Task View',
    ignoreWhenMonacoFocused: true,
  },
  newProject: {
    defaultHotkey: 'Mod+Shift+N',
    label: 'New Project',
    description: 'Create a new project',
    category: 'Navigation',
  },
  openInEditor: {
    defaultHotkey: 'Mod+O',
    label: 'Open in Editor',
    description: 'Open the project in the default editor',
    category: 'Navigation',
  },
  sidebarChanges: {
    defaultHotkey: 'Mod+Shift+1',
    label: 'View Changes',
    description: 'Open the Review tab in the file panel',
    category: 'Task View',
  },
  sidebarFiles: {
    defaultHotkey: 'Mod+Shift+2',
    label: 'View Files',
    description: 'Open the Files tab in the file panel',
    category: 'Task View',
  },
  tabNext: {
    defaultHotkey: 'Mod+Alt+ArrowRight',
    label: 'Next Tab',
    description: 'Switch to the next tab',
    category: 'Tab Navigation',
    conflictBehavior: 'allow',
  },
  tabPrev: {
    defaultHotkey: 'Mod+Alt+ArrowLeft',
    label: 'Previous Tab',
    description: 'Switch to the previous tab',
    category: 'Tab Navigation',
    conflictBehavior: 'allow',
  },
  tabClose: {
    defaultHotkey: 'Mod+W',
    label: 'Close Tab',
    description: 'Close the active tab',
    category: 'Tab Navigation',
    conflictBehavior: 'allow',
  },
  tabReopen: {
    defaultHotkey: 'Mod+Shift+T',
    label: 'Reopen Closed Tab',
    description: 'Reopen the most recently closed tab',
    category: 'Tab Navigation',
    conflictBehavior: 'allow',
  },
  tabRename: {
    defaultHotkey: 'Mod+Shift+R',
    label: 'Rename Tab',
    description: 'Rename the active tab (when supported)',
    category: 'Tab Navigation',
    conflictBehavior: 'allow',
  },
  // ⌘T 照浏览器是「新页签」= 打开这一格的「+」(spec session-page「常用键照浏览器」);侧边聊天是「+」里的第一项。
  openAddMenu: {
    defaultHotkey: 'Mod+T',
    label: 'New Tab',
    description: 'Open the + menu of the focused pane',
    category: 'Tab Navigation',
    conflictBehavior: 'allow',
  },
  sideSession: {
    label: 'Side Chat',
    description: 'Fork the current task into a temporary side chat',
    category: 'Task View',
  },
  newTerminal: {
    defaultHotkey: 'Mod+Shift+`',
    label: 'New Terminal',
    description: 'Create a new terminal in the current task',
    category: 'Task View',
  },
  openBrowser: {
    defaultHotkey: 'Mod+Shift+B',
    label: 'Open Browser',
    description: 'Open an in-app browser in the current task',
    category: 'Task View',
  },
  browserCopyUrl: {
    defaultHotkey: 'Mod+Shift+C',
    label: 'Copy Browser URL',
    description: 'Copy the current in-app browser URL',
    category: 'Task View',
  },
  toggleTerminalDrawer: {
    defaultHotkey: 'Mod+J',
    label: 'Toggle Terminal Drawer',
    description: 'Show or hide the terminal drawer',
    category: 'Task View',
  },
  confirm: {
    defaultHotkey: 'Mod+Enter',
    label: 'Confirm',
    description: 'Confirm the current dialog action',
    category: 'Navigation',
  },
  navigateBack: {
    defaultHotkey: 'Mod+[',
    label: 'Go Back',
    description: 'Navigate to the previous location',
    category: 'Navigation',
  },
  navigateForward: {
    defaultHotkey: 'Mod+]',
    label: 'Go Forward',
    description: 'Navigate to the next location',
    category: 'Navigation',
  },
  splitPane: {
    defaultHotkey: 'Mod+\\',
    label: 'Split Pane',
    description: 'Show the active tab side by side with the last one, or separate the pair',
    category: 'Tab Navigation',
    conflictBehavior: 'allow',
  },
  focusSidebar: {
    defaultHotkey: 'Mod+0',
    label: 'Focus Sidebar',
    description: 'Move focus to the left sidebar',
    category: 'Navigation',
  },
  /**
   * ⇧Esc, not ⌘E. ⌘E is *inline code* in the composer (@tiptap/extension-code binds `Mod-e`), and in
   * a Work/ACP session — where the follow-up composer IS that editor — one ⌘E both focused the
   * composer and wrapped the selection in <code>. Measured on a real session, 2026-09-18: Work form
   * ⇒ focus moves AND `<code>` appears; Code/TUI form ⇒ the composer is a plain textarea, so only the
   * focus half fires. Same defect as #5802, one page over (#5803).
   *
   * ⇧Esc is ChatGPT's "jump to the message box", and it pairs with this registry's own
   * `sessionLeaveComposer` = Escape: Escape leaves the composer, ⇧Esc goes back in. Measured free
   * here too — the nav layer matches bare Escape exactly, so ⇧Esc inside the composer does not leave
   * it, and the editor itself does not bind it.
   */
  focusComposer: {
    defaultHotkey: 'Shift+Escape',
    label: 'Focus Composer',
    description: 'Focus the message composer input',
    category: 'Task View',
    ignoreWhenMonacoFocused: true,
  },
  addContext: {
    defaultHotkey: 'Mod+Shift+A',
    label: 'Add Context',
    description: 'Open the context picker for the active task',
    category: 'Task View',
    ignoreWhenMonacoFocused: true,
  },
  stageAll: {
    defaultHotkey: 'Mod+Shift+G',
    label: 'Stage All',
    description: 'Stage all unstaged files',
    category: 'Task View',
    ignoreWhenMonacoFocused: true,
  },
  timelineNext: {
    defaultHotkey: 'Alt+]',
    label: 'Next Timeline Entry',
    description: 'Jump to the next timeline entry',
    category: 'Task View',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  timelinePrev: {
    defaultHotkey: 'Alt+[',
    label: 'Previous Timeline Entry',
    description: 'Jump to the previous timeline entry',
    category: 'Task View',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  showKeyboardShortcuts: {
    defaultHotkey: 'Mod+/',
    label: 'Keyboard Shortcuts',
    description: 'Show the keyboard shortcuts cheat sheet',
    category: 'Navigation',
  },
  // behavior session-page「键盘导航」. All nine are `conflictBehavior: 'allow'` on purpose: that is
  // what keeps CommandShortcutBinder from turning them into document-wide hotkeys (same escape
  // hatch the tab-navigation keys use). They are dispatched by the session navigation listener,
  // which acts in the nav layer, plus the two composer exits below — so a terminal keeps ⌃R for its
  // history search, a text field keeps ⌃X for cut, and bare ↑↓ in a composer stay the composer's
  // own (they walk that session's sent prompts, they do not switch sessions).
  // Registering them here is still what makes them user-rebindable and visible in the cheat sheet.
  // Category is deliberately an existing one: the cheat sheet only renders four hard-coded
  // categories, so a new category would silently drop these rows from it.
  sessionNext: {
    defaultHotkey: 'Mod+ArrowDown',
    label: 'Next Task',
    description: 'Move to the next task in the sidebar and show it',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  sessionPrev: {
    defaultHotkey: 'Mod+ArrowUp',
    label: 'Previous Task',
    description: 'Move to the previous task in the sidebar and show it',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  sessionFocusComposer: {
    defaultHotkey: 'ArrowRight',
    label: 'Focus Composer From Sidebar',
    description: 'Hand the keyboard back to the composer',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  sessionNewInProject: {
    defaultHotkey: 'ArrowLeft',
    label: 'Project Home',
    description: "Jump to the parent project's home, where a new task is started",
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  // Shares ← with sessionNewInProject by design: that one is the nav layer's parent jump, this one
  // is the composer's exit, and no keypress is ever in both layers at once (behavior session-page
  // 「键盘导航」). Inside the composer it only fires with the caret at the very start and nothing
  // selected — anywhere else ← still moves the caret.
  sessionBackToList: {
    defaultHotkey: 'ArrowLeft',
    label: 'Back To Task List',
    description: 'Leave the composer for the sidebar when the caret is at the start',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  // behavior session-page「键盘导航」: the way out of a terminal / TUI session, where ← cannot be the
  // exit. Inside a terminal the host has no way to know whether the TUI's own prompt line is empty
  // — that grid is drawn by another process — so a bare ← would either steal the caret or need a
  // guess, and a guess that fires mid-typing is worse than no exit at all. This chord needs no
  // guess: it is measurably unclaimed by the TUIs we run, so it is idle there by construction.
  //
  // One chord on every platform — the same physical key, only the keycap differs (Option on a Mac,
  // Alt elsewhere; `event.altKey` either way). Picking a chord here means surveying three layers,
  // not two, and the first attempt surveyed only the outer two:
  //   1. the TUIs — measured 2026-08-10 (claude 2.1.x bundle keymap, codex codex-rs/tui/keymap.rs):
  //      Shift+← is claude's `selection:extendLeft`; Control+← is codex's `move_word_left`; Alt+←
  //      is unbound in claude and is one of three `move_word_left` bindings in codex (Alt+B and
  //      Control+← survive), plus codex's own Alt+←/→ thread switching, which is separate from
  //      this app's modified session switch.
  //   2. xterm.js — drops every meta-modified arrow before the PTY, but see 3.
  //   3. **this app's own terminal key handler** (lib/pty/use-pty.ts) — which overrides 2 and
  //      synthesises Command+← → \x01 / Command+→ → \x05 so macOS users get line start/end. So
  //      Command+← is NOT free here however unclaimed it looks in the TUIs: taking it would delete
  //      a working editing key. Alt+← is the only two-key arrow chord no layer already owns.
  // The cost is stated rather than hidden: inside a terminal Alt+← stops being "back one word".
  // Owner 2026-08-11 weighed that against losing line-start and chose this one.
  terminalBackToList: {
    defaultHotkey: 'Alt+ArrowLeft',
    label: 'Leave Terminal For Task List',
    description: 'Hand the keyboard from a terminal task back to the sidebar',
    category: 'Navigation',
    conflictBehavior: 'allow',
    // Every session-nav sibling carries these; without them this one would start firing inside the
    // code editor and the in-app browser the day it gains a command registration.
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  sessionLeaveComposer: {
    defaultHotkey: 'Escape',
    label: 'Leave Composer',
    description: 'Return from the composer to sidebar navigation, keeping the draft',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  renameSession: {
    defaultHotkey: (platform) => sessionActionDefault('R', platform),
    label: 'Rename Task',
    description: 'Rename the highlighted task in place',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  pinSession: {
    defaultHotkey: (platform) => sessionActionDefault('P', platform),
    label: 'Pin Task',
    description: 'Pin or unpin the highlighted task',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
  archiveHighlightedSession: {
    defaultHotkey: (platform) => sessionActionDefault('X', platform),
    label: 'Archive Highlighted Task',
    description: 'Archive the highlighted task (press twice to confirm)',
    category: 'Navigation',
    conflictBehavior: 'allow',
    ignoreWhenMonacoFocused: true,
    ignoreWhenBrowserFocused: true,
  },
});

export type ShortcutSettingsKey = keyof typeof APP_SHORTCUTS;

/**
 * Pairs that deliberately answer to the same chord, with the reason they can never both fire.
 *
 * Runtime knowledge, not test knowledge: the keyboard settings card refuses any binding that
 * collides with another shortcut, so without this list a user who rebinds one of a shared pair can
 * never set it back — the product would contradict the behavior doc that registers the share.
 */
export const INTENTIONALLY_SHARED_CHORDS: ReadonlyArray<{
  readonly keys: readonly [ShortcutSettingsKey, ShortcutSettingsKey];
  readonly why: string;
}> = [
  {
    keys: ['closeModal', 'sessionLeaveComposer'],
    why: 'Disjoint by modal state: session navigation stands down while a modal is open.',
  },
  {
    keys: ['sessionNewInProject', 'sessionBackToList'],
    why: 'Disjoint by focus layer: a keypress is either in the composer or in the nav layer.',
  },
];

/** Whether these two shortcuts are allowed to answer to the same chord. */
export function sharesChordIntentionally(a: string, b: string): boolean {
  return INTENTIONALLY_SHARED_CHORDS.some(
    ({ keys }) => (keys[0] === a && keys[1] === b) || (keys[0] === b && keys[1] === a)
  );
}
