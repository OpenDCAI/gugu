import type React from 'react';
import type { CommandId } from '@shared/commands';
import type { TabHistorySnapshot } from '@shared/view-state';
import type { TabBarItemProps, TabContentProps } from './tab-host';
import type { TabOpenOptions } from './tab-provider-registry';

/**
 * Plain-data identity for a single open tab.
 * The engine serializes provider state and this context's page history independently.
 * Live view-model state lives in the domain resource returned by initialize().
 */
export interface TabEntry<S = unknown> {
  readonly kind: string;
  readonly tabId: string;
  history?: TabHistorySnapshot;
  openerTabId?: string;
  /**
   * Reactive, serializable domain state for this tab.
   * Mutated in-place; the snapshot serializer reads it directly (no per-kind hook).
   * Replaces the old readonly `payload` + `getSerializablePayload` escape hatch.
   */
  state: S;
}

/**
 * Minimal shape every domain resource must satisfy.
 * Domain managers ref-count their internal state inside initialize/dispose.
 */
export interface TabResource {
  /** Its content holds what would be lost if unmounted (unsaved edits): the pane keeps it mounted. */
  readonly holdsUnsaved?: boolean;
  /** Called when the engine permanently removes the tab. Must be idempotent. */
  dispose(): void;
  /**
   * Called when the tab becomes the active tab in a visible pane.
   * Use for mark-seen, lazy bootstrap, etc.
   */
  onActivate?(): void;
  /**
   * Called when the user hovers or focuses a tab — before it becomes active.
   * Use for optimistic prefetch so that tab switching feels instant.
   */
  onActivateIntent?(): void;
}

/**
 * Controls which pane a programmatic open targets.
 *   'active'           – focused pane (default)
 *   'right' | 'left'   – adjacent pane (split if needed)
 *   { paneId: string } – explicit pane by ID
 */
export type OpenTarget = 'active' | 'left' | 'right' | { paneId: string };

/**
 * Capability handle given to resources at initialize time.
 * Resources use this to drive programmatic close and source-aware page
 * opens — without holding a direct store reference.
 */
export interface TabHandle {
  readonly tabId: string;
  /**
   * Close this tab. By default runs the onBeforeClose veto (user-style close).
   * Pass { force: true } to skip the veto (programmatic/auto-close).
   * Returns a promise that resolves to true if the tab was actually closed.
   */
  close(opts?: { force?: boolean }): Promise<boolean>;
  /**
   * Open a tab in the view that owns this handle.
   * `kind` selects the provider; `args` are the domain open-args (the "searchParams");
   * `config` carries the explicit navigation intent and optional host target pane.
   */
  open(
    kind: string,
    args: Record<string, unknown>,
    config?: Omit<TabOpenOptions, 'from'>
  ): void;
}

/**
 * A named capability surfaced through the tab context menu and command palette.
 * Examples: `rename`, `export`, `duplicate`.
 *
 * `shortcut` may be either a user-configurable settings key (looked up to find
 * the effective hotkey) or a plain getter function returning the key string.
 * This allows commands that are not user-configurable to still show a hotkey.
 */
export interface CommandEntry<T> {
  label: string;
  /**
   * Execute the command.
   * For rename commands, `args[0]` is the new name string provided by the inline editor.
   */
  exec(resource: T, ...args: any[]): void;
  isAvailable?(resource: T): boolean;
  shortcut?: CommandId | (() => string | undefined);
}

/**
 * Generic ambient context passed to all tab-kind method implementations.
 * The engine only requires a stable viewId; domain-specific fields
 * (projectId, workspaceId, conversationId, modelRootPath) live in SessionTabContext in
 * features/sessions and are accessed via a cast at the provider boundary.
 */
/** How a close came about: the user closing just this tab, or anything else (a row of tabs, the tab itself). */
export type TabCloseRequest = { alone: boolean; navigation?: boolean };

export interface TabViewContext {
  /** Stable identifier for the view that owns this pane (e.g. conversationId). */
  viewId: string;
  /** The host's place, for providers shared by task and chat views. */
  place?:
    | { kind: 'session'; sessionId: string; projectId: string }
    | { kind: 'chat'; chatId: string };
}

/**
 * The composed resolved tab: engine identity stamped with the injected domain resource.
 * Components receive this instead of raw entry data so they never need findEntry().
 */
export type ResolvedTab<T extends TabResource = TabResource> = {
  readonly tabId: string;
  readonly kind: string;
  /** 此刻画在屏上。并排时一对两枚都是(spec session-page「并排」)—— 内容组件按「自己这种 + isActive」挑要画的那枚。 */
  readonly isActive: boolean;
  /** 拿着焦点的那一枚(并排时是点着的那一边;不并排时与 isActive 相同)。 */
  readonly isFocused?: boolean;
  /** 并排的一对里排左('start')/ 排右('end'):页签条上两枚连成一块(spec session-page「并排」)。 */
  readonly pairRole?: 'start' | 'end';
  readonly resource: T;
};

// Re-export renderer-chrome types so provider files can import from one location.
export type { TabBarItemProps, TabContentProps } from './tab-host';

/**
 * The core contract for a tab kind.
 *
 * Generic parameters
 *   K        – literal string kind discriminant
 *   S        – serializable state stored per tab entry (snapshot key)
 *   T        – the domain resource returned by initialize()
 *   OpenArgs – argument bag for opening a tab of this kind
 *              (may differ from S when onBeforeOpen transforms/enriches args)
 */
export interface TabProvider<
  K extends string = string,
  S = unknown,
  T extends TabResource = TabResource,
  OpenArgs = S,
> {
  readonly kind: K;
  /** A conversation: what is opened from it goes side by side with it (spec session-page「并排」). */
  conversation?: boolean;

  /**
   * Stable resource identity, independent of the navigation context's tab id.
   * Used for page equality and list-selection queries (isOpen / isActive).
   * Must be pure and stable across state mutations that do not change identity.
   */
  resourceKey(state: S): string;

  /** Runtime-only tabs return false so neither snapshots nor closed-tab history can resurrect them. */
  isPersistent?(state: S): boolean;


  /**
   * 格里有这一枚,这一类的内容层就一直挂着(没上屏时照常藏起、不画)。对话那一类:群信息、群文件、话题的页和对话的名字、
   * 右端按钮都由对话画进各自的格子 —— 启动时亮着的是别的页签,对话没挂上,它们就都是空的。
   */
  keepMounted?: boolean;

  /**
   * Normalize/validate open args, perform synchronous side-effects
   * (e.g. create a browser session), and return the initial serializable state.
   * Return null to abort the open.
   *
   * If absent, the open args become the initial state; routing stays in the separate open options.
   */
  onBeforeOpen?(args: OpenArgs, ctx: TabViewContext): S | null;

  /**
   * Acquire or create the domain resource. Domain managers ref-count here.
   * Returns the resource, which the engine stores keyed by tabId and injects
   * into ResolvedTab.resource for render components.
   */
  initialize(entry: TabEntry<S>, handle: TabHandle, ctx: TabViewContext): T;

  /**
   * Veto a user-initiated close (e.g. show unsaved-changes dialog).
   * Return false (or Promise<false>) to cancel; true or Promise<true> to confirm.
   * Not called for force closes (handle.close({ force: true }) / closeTab()).
   * `request.alone`: the user closed just this tab (×, ⌘W, middle click, 「关闭页签」) — not as part of a row
   * (close others / to the right / all) and not a tab closing itself through its handle.
   */
  onBeforeClose?(entry: TabEntry<S>, resource: T, ctx: TabViewContext, request: TabCloseRequest): boolean | Promise<boolean>;

  /**
   * Release the domain resource. Domain managers decrement ref counts here.
   * Called when the engine permanently removes the tab from the view.
   */
  dispose(entry: TabEntry<S>, resource: T, ctx: TabViewContext): void;

  /**
   * The tab `tabId` is closed for good, and one of its pages (now or in its Back/Forward history) was of this kind.
   * `dispose` also runs when a page leaves its tab through history navigation; this runs only on close.
   */
  closed?(tabId: string, ctx: TabViewContext): void;

  /** Named capabilities surfaced as context-menu items and keyboard commands. */
  commands?: Record<string, CommandEntry<T>>;

  /** Renders the tab's chip in the tab bar. */
  TabBarItem: React.ComponentType<TabBarItemProps<T>>;
  /** Renders the drag ghost for this tab kind. */
  TabBarItemDragPreview: React.ComponentType<{ tab: ResolvedTab<T> }>;

  /**
   * The pane body component for this kind.
   * Mounted unconditionally by PaneContent regardless of which kind is active.
   */
  TabContent: React.ComponentType<TabContentProps>;
}
