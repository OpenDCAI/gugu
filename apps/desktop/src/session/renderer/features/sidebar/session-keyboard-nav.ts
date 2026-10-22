import { makeAutoObservable, runInAction } from 'mobx';
import { archiveSessionNow } from '@renderer/features/sessions/archive-session-flow';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { focusedSessionId } from '@renderer/features/sessions/pane-selectors';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { navNodeKey, navNodesEqual, type SidebarNavNode } from './sidebar-store';
import { withMountedSession } from './with-mounted-session';
import {
  sessionNavigationFocus,
  type SessionNavFocusLayer,
} from './session-navigation-focus';

/** 主区是一个站点(新建任务那一屏、项目首页、会话)的那几种页面;`home` 和 `new-session` 是同一屏(app/home-view.tsx)。 */
const STATION_VIEWS: ReadonlySet<string> = new Set(['home', 'new-session', 'project', 'session']);

/**
 * behavior session-page「键盘导航」 — the controller behind the two focus layers.
 *
 * Keyboard focus is split into a NAV layer (does not accept characters) and the COMPOSER layer.
 * Two layers rather than one is not decoration: if focus always stayed in the composer and the only
 * gate were "is it empty", then stepping onto a conversation that has a saved draft would mount a
 * non-empty composer, the arrows would go dead, and the user would be stuck on that conversation
 * with no keyboard way out.
 */

export const SESSION_NAV_FOCUS_REGION = 'session-nav-focus';

const COMPOSER_INPUT_SELECTOR =
  '.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"], textarea';

/**
 * ↑↓ walks stations and the main area follows each one. Opening is coalesced so holding ↓ does not
 * fire one navigation per station — only the station you land on is actually opened.
 */
const OPEN_COALESCE_MS = 100;

/** How long the first ⌃X stays armed before the archive silently disarms itself. */
export const ARCHIVE_CONFIRM_WINDOW_MS = 3_000;

/**
 * Focus the composer of whatever the main area currently shows. Mirrors the `session.focusComposer` command.
 * `within` = the composer inside that element (a block's own new-task box).
 */
export function focusSessionComposer(within: ParentNode = document): boolean {
  const composer = within.querySelector<HTMLElement>('[data-region="composer"]');
  const input = composer?.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR);
  if (!input) return false;
  input.focus();
  return true;
}

/**
 * behavior session-page「键盘导航」: 一条 TUI 会话的「界面」和「输入框」是同一个东西 —— 进去之后
 * 光标由 TUI 自己放在它的提示行上,所以 → 对这类会话就该落到终端,不必另设一个「聚焦面板」键。
 *
 * 必须限定在**当前会话那一格**里找:工作区的「终端」面板、草稿面板都渲染同一个 xterm 组件,
 * 全文档搜「第一个 .xterm」会把键盘交给另一条会话的活 PTY —— 下一句 prompt 就打进别人的进程了。
 * ❌ 用 offsetParent 判「可见」来代替限定:卸载的终端是被搬进屏幕外宿主(position:fixed;left:-10000px),
 * 不是 display:none,offsetParent 照样非空,那条判据根本不成立。
 */
export function focusSessionTerminal(): boolean {
  const input = document.querySelector<HTMLElement>(
    '[data-region="session-terminal"] .xterm-helper-textarea'
  );
  if (!input) return false;
  input.focus();
  return true;
}

function focusNavLayer(): boolean {
  const holder = document.querySelector<HTMLElement>(`[data-region="${SESSION_NAV_FOCUS_REGION}"]`);
  if (!holder) return false;
  holder.focus();
  return true;
}

function focusNavCursorRow(): boolean {
  const row = document.querySelector<HTMLElement>('[data-nav-cursor]');
  if (!row) return false;
  row.focus({ preventScroll: true });
  return document.activeElement === row;
}

class SessionKeyboardNavStore {
  /** Explicit cursor. Null means "wherever the main area currently is" (see `cursor`). */
  private _cursor: SidebarNavNode | null = null;
  get focusLayer(): SessionNavFocusLayer {
    return sessionNavigationFocus.focusLayer;
  }
  /** Conversation armed for archiving by a first ⌃X, waiting for the confirming second press. */
  pendingArchiveSessionId: string | null = null;

  private _focusAttempt = 0;
  private _archiveTimer: ReturnType<typeof setTimeout> | null = null;
  private _openTimer: ReturnType<typeof setTimeout> | null = null;
  private _disposeOpen: (() => void) | null = null;

  constructor() {
    makeAutoObservable<
      this,
      '_disposeOpen' | '_openTimer' | '_archiveTimer' | '_focusAttempt'
    >(this, {
      _disposeOpen: false,
      _openTimer: false,
      _archiveTimer: false,
      _focusAttempt: false,
    });
  }

  /**
   * The station the highlight sits on. The cursor and "what you are looking at" are the same thing —
   * there is only ever one highlight, and it must not disagree with the main area. So an explicit
   * cursor is only honoured while it still exists in the chain; otherwise we fall back to the view.
   */
  get cursor(): SidebarNavNode | null {
    // 主区在一个不是站点的页面上(会话历史、已安排……):没有哪个站点正被看着,光标也就不在任何一行上 ——
    // 点过「新建任务」再点「会话历史」,❌ 让「新建任务」那一行留着光标的底色(和「会话历史」同时亮)。
    if (!STATION_VIEWS.has(appState.navigation.currentViewId)) return null;
    const chain = sidebarStore.navChain;
    if (this._cursor) {
      const key = navNodeKey(this._cursor);
      const live = chain.find((node) => navNodeKey(node) === key);
      if (live) return live;
    }
    return this.viewNode;
  }

  /** Where the main area currently is, expressed as a station. */
  get viewNode(): SidebarNavNode | null {
    const nav = appState.navigation;
    const view = nav.currentViewId;
    if (view === 'new-session') return { kind: 'new-session' };
    if (view === 'project') {
      const projectId = (nav.viewParamsStore.project as { projectId?: string } | undefined)
        ?.projectId;
      return projectId ? { kind: 'project', projectId } : null;
    }
    if (view === 'session') {
      const params = nav.viewParamsStore.session as
        | { projectId?: string; sessionId?: string }
        | undefined;
      const projectId = params?.projectId;
      const pageSessionId = params?.sessionId;
      if (!projectId || !pageSessionId) return null;
      const focusedPane = getSessionView(projectId, pageSessionId)?.paneLayout.focusedPane;
      const sessionId = focusedPane ? focusedSessionId(focusedPane) : undefined;
      if (!sessionId) return null;
      return { kind: 'conversation', projectId, sessionId };
    }
    return null;
  }

  get isCursorOnSession(): boolean {
    return this.cursor?.kind === 'conversation';
  }

  setFocusLayer(layer: SessionNavFocusLayer): void {
    sessionNavigationFocus.focusLayer = layer;
  }

  /** Keep the focus-layer fact aligned with the real DOM focus owner. */
  syncFocusFromElement(element: Element): void {
    if (
      element.closest(
        `[data-region="${SESSION_NAV_FOCUS_REGION}"], [data-nav-cursor], [role="treeitem"]`,
      )
    ) {
      this.setFocusLayer('nav');
      return;
    }
    if (
      element.closest(
        `${COMPOSER_INPUT_SELECTOR}, .xterm-helper-textarea, .monaco-editor, webview, iframe`,
      )
    ) {
      this.setFocusLayer('composer');
    }
  }

  /** Move one station and let the main area follow. Stops at both ends; never wraps. */
  move(delta: 1 | -1): boolean {
    const returnToComposer = this.focusLayer === 'composer';
    const from = this.cursor;
    if (delta === 1 && from) {
      // A "Show more" row is only a length cap, not a "don't show me this" — walk through it.
      const overflowProjectId = sidebarStore.idleOverflowProjectAfter(from);
      if (overflowProjectId) sidebarStore.ensureIdleExpanded(overflowProjectId);
    }
    // Session switching walks the visible conversation rows only. The shared navigation chain
    // also contains the New task entry and project homes for their own shortcuts; those are not
    // sessions and must not become Cmd+Arrow destinations.
    const chain = sidebarStore.navChain.filter((node) => node.kind === 'conversation');
    if (chain.length === 0) return false;
    const index = from ? chain.findIndex((node) => navNodesEqual(node, from)) : -1;
    const next = index === -1 ? (delta === 1 ? chain[0] : chain[chain.length - 1]) : chain[index + delta];
    if (!next) return false;
    if (returnToComposer) {
      this.clearPendingArchive();
      this._cursor = next;
      this.setFocusLayer('composer');
      this._scheduleApply(next, () => this.handOffToComposer());
    } else {
      this.setCursor(next);
    }
    return true;
  }

  /** Put the cursor on a station and take the main area there. */
  setCursor(node: SidebarNavNode): void {
    this.clearPendingArchive();
    this._cursor = node;
    this.setFocusLayer('nav');
    focusNavLayer();
    this._scheduleApply(node, () => {
      if (this.focusLayer !== 'nav' || !navNodesEqual(this.cursor, node)) return;
      // The auto-focus writers yield while focusLayer is nav, so one settled attempt is enough.
      // A virtualized row may not be mounted yet; the holder remains the explicit nav focus target.
      focusNavCursorRow();
    });
  }

  /** Click and other pointer paths land here: same cursor, but focus is the caller's business. */
  syncCursorFromPointer(node: SidebarNavNode): void {
    this._cursor = node;
    // Pointer activation follows the existing product path: opening a session hands the keyboard
    // to its composer. A later focusin keeps the same fact true if another surface wins the race.
    this.setFocusLayer('composer');
    this.clearPendingArchive();
  }

  /**
   * ← : jump to the parent station. A conversation's parent is its project row (its project home,
   * where a new session is started); a standalone conversation's is the New session page. On a project
   * row ← collapses it, which is also what makes the keyboard skip it afterwards.
   */
  goToParent(): boolean {
    const node = this.cursor;
    if (!node || node.kind === 'new-session') return false;
    if (node.kind === 'project') {
      if (!sidebarStore.expandedProjectIds.has(node.projectId)) return false;
      sidebarStore.collapseProject(node.projectId);
      return true;
    }
    // 父站是这条会话显示在下面的那一行(#6264 别的机器上任务工作区里的在那台机器的「~」那一行;别的机器上的 child
    // 在父会话那一行);「任务」分区里的回「新建任务」。
    const row = appState.projects.projects.has(node.projectId)
      ? sidebarStore.rowOfSession(node.projectId, node.sessionId)
      : null;
    const parent: SidebarNavNode = row === null ? { kind: 'new-session' } : { kind: 'project', projectId: row };
    this._cursor = parent;
    this.clearPendingArchive();
    this._applyNow(parent);
    // The project home and the New session page exist to be typed into, so ← lands in the composer.
    this.handOffToComposer();
    return true;
  }

  /**
   * → : hand the keyboard to this session's own interface. On a collapsed project row it expands
   * instead.
   *
   * Which interface depends on the conversation, not on where the keyboard came from: an ACP
   * session is our chat UI, so it means the composer; a pty session *is* a terminal, so it means
   * the terminal. ❌ Remembering "the panel you left from": once ↑↓ walk to another session that
   * panel belongs to a different conversation and the key has no defined target.
   */
  handOffToComposer(): boolean {
    const node = this.cursor;
    if (node?.kind === 'project' && !sidebarStore.expandedProjectIds.has(node.projectId)) {
      sidebarStore.ensureProjectExpanded(node.projectId);
      return true;
    }
    // 'composer' here names the layer that accepts characters, terminal included.
    this.setFocusLayer('composer');
    // Re-classified on every retry frame, not captured once: the retry loop exists because the
    // conversation record may not be in the registry yet, and a target locked in at t0 stays
    // wrong for the whole window even after the terminal mounts.
    const focusTarget = (): boolean =>
      this._isTerminalSession(node) ? focusSessionTerminal() : focusSessionComposer();
    // ← navigates and focuses in one keystroke, but the target composer mounts a render later —
    // and a project home whose task is still provisioning can take longer than a single frame.
    // One rAF was not enough in practice (the real-Electron run typed into nothing), so retry
    // until it lands, bounded, and give up quietly if the user has meanwhile moved on.
    if (!focusTarget()) {
      const startedAt = this._focusAttempt + 1;
      this._focusAttempt = startedAt;
      let framesLeft = 40;
      const retry = () => {
        if (this._focusAttempt !== startedAt) return;
        if (this.focusLayer !== 'composer') return;
        if (focusTarget() || framesLeft-- <= 0) return;
        requestAnimationFrame(retry);
      };
      requestAnimationFrame(retry);
    }
    return true;
  }

  /**
   * A pty conversation renders as a terminal; an ACP one renders our chat UI.
   *
   * `!== 'acp'` rather than `=== 'pty'`: `type` is optional on the record with 'pty' as the
   * documented default, and every other classifier in this tree splits the same way. A record
   * that has not loaded yet answers false so the caller retries — it must not be read as ACP.
   */
  private _isTerminalSession(node: SidebarNavNode | null): boolean {
    if (node?.kind !== 'conversation') return false;
    const session = sessionRegistry.get(node.sessionId)?.sessions.get(node.sessionId);
    if (!session) return false;
    return session.data.runtime !== 'acp';
  }

  /** Esc from a composer with text in it — the only keyboard way out. Drafts are left untouched. */
  leaveComposer(): boolean {
    // Report first, mutate only on success: the terminal seam turns a false return into "not my
    // key", and a store that already said 'nav' while focus never left would desync the two.
    const left = focusNavLayer();
    if (left) this.setFocusLayer('nav');
    return left;
  }

  // ---- conversation actions (never act on a project row or the New task entry) ----

  /** Open the shared session rename dialog for the exact conversation under the cursor. */
  startRename(target?: SidebarNavNode): boolean {
    const node = target ?? this.cursor;
    if (node?.kind !== 'conversation') return false;
    this.clearPendingArchive();
    this._cursor = node;
    // 别的机器上还没挂的那一行:先挂上(没连上 / 挂完找不到都当场说),键已经接住。
    withMountedSession(node.projectId, node.sessionId, (session) =>
      showModal('renameSessionModal', {
        sessionId: node.sessionId,
        currentTitle: session.data.title,
      })
    );
    return true;
  }

  togglePin(): boolean {
    const node = this.cursor;
    if (node?.kind !== 'conversation') return false;
    this.clearPendingArchive();
    // Pinning lifts the conversation out of its project subtree into the Pinned section; the cursor
    // is keyed by conversation id, so the highlight follows the row to its new home by itself.
    withMountedSession(node.projectId, node.sessionId, (session, manager) => {
      void manager.setSessionPinned(node.sessionId, session.data.isPinned !== true);
    });
    return true;
  }

  /**
   * ⌃X. Archiving stops the agent running in that conversation and takes the row out of the list,
   * so the first press only arms it — the second press within the window is the confirmation.
   * Archive, not delete (#6949): the person's side only ever archives, same as the agent's
   * `session_archive`; the undo toast and Session history bring it back.
   */
  pressArchive(): boolean {
    const node = this.cursor;
    if (node?.kind !== 'conversation') return false;
    if (this.pendingArchiveSessionId === node.sessionId) {
      this.clearPendingArchive();
      this._archiveCursorSession(node);
      return true;
    }
    this.armArchive(node.sessionId);
    return true;
  }

  armArchive(sessionId: string): void {
    this.pendingArchiveSessionId = sessionId;
    if (this._archiveTimer) clearTimeout(this._archiveTimer);
    this._archiveTimer = setTimeout(() => {
      runInAction(() => {
        this.pendingArchiveSessionId = null;
        this._archiveTimer = null;
      });
    }, ARCHIVE_CONFIRM_WINDOW_MS);
  }

  clearPendingArchive(): void {
    if (!this.pendingArchiveSessionId) return;
    this.pendingArchiveSessionId = null;
    if (this._archiveTimer) {
      clearTimeout(this._archiveTimer);
      this._archiveTimer = null;
    }
  }

  private _archiveCursorSession(node: SidebarNavNode & { kind: 'conversation' }): void {
    withMountedSession(node.projectId, node.sessionId, () => {
      const chain = sidebarStore.navChain;
      const index = chain.findIndex((entry) => navNodesEqual(entry, node));
      const successor = index === -1 ? null : (chain[index + 1] ?? chain[index - 1] ?? null);
      const moveOn = () => {
        const target = successor ?? { kind: 'new-session' as const };
        runInAction(() => {
          this._cursor = target;
        });
        this._applyNow(target);
      };
      // The two key presses ARE this path's confirmation (behavior session-page「键盘导航」), so no
      // dialog; the scope is this one session, as before.
      archiveSessionNow({ projectId: node.projectId, sessionId: node.sessionId, withChildren: false });
      moveOn();
    });
  }

  // ---- main-area follow ----

  private _scheduleApply(node: SidebarNavNode, onApplied?: () => void): void {
    if (this._openTimer) clearTimeout(this._openTimer);
    this._openTimer = setTimeout(() => {
      this._openTimer = null;
      this._applyNow(node);
      onApplied?.();
    }, OPEN_COALESCE_MS);
  }

  private _applyNow(node: SidebarNavNode): void {
    // An immediate apply supersedes a scheduled one. Without this, ← pressed within the coalesce
    // window of the ↓ before it lands on the project home and is then dragged back to the
    // conversation when the stale timer fires — the highlight says one thing, the main area another.
    if (this._openTimer) {
      clearTimeout(this._openTimer);
      this._openTimer = null;
    }
    // A pending open for the station we just left would otherwise land later, or time out into a
    // toast for a conversation the user has already arrowed past.
    this._disposeOpen?.();
    this._disposeOpen = null;
    const nav = appState.navigation;
    if (node.kind === 'new-session') {
      nav.navigateTransient('new-session');
      return;
    }
    if (node.kind === 'project') {
      sidebarStore.ensureProjectExpanded(node.projectId);
      // 代位的任务工作区那一行(那台机器还没有主目录项目):它的「主页」是预选那台机器的新建页。
      const standIn = sidebarStore.homeLayout.standIns.get(node.projectId);
      if (standIn) {
        remoteHostsStore.requestNewSession(standIn, null);
        nav.navigateTransient('new-session');
        return;
      }
      nav.navigateTransient('project', { projectId: node.projectId });
      return;
    }
    nav.navigateTransient('session', { projectId: node.projectId, sessionId: node.sessionId });
    this._disposeOpen = openSessionInSessionWhenReady({
      projectId: node.projectId,
      sessionId: node.sessionId,
      preview: true,
    });
  }
}

export const sessionKeyboardNav = new SessionKeyboardNavStore();
