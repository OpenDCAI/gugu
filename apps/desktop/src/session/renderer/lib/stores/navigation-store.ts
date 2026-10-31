import { makeAutoObservable, toJS } from 'mobx';
import type { GuardResult, ViewId, WrapParams } from '@renderer/app/view-registry';
import { modalStore } from '@renderer/lib/modal/modal-store';
import type { NavigationSnapshot } from '@shared/view-state';
import { appState } from './app-state';
import type { Snapshottable } from './snapshottable';

type ViewParamsStore = Partial<{ [K in ViewId]: WrapParams<K> }>;

type LibraryViewId = 'library';
type NonLibraryViewId = Exclude<ViewId, LibraryViewId>;

function isLibraryView(viewId: ViewId): viewId is LibraryViewId {
  return viewId === 'library';
}

export class NavigationStore implements Snapshottable<NavigationSnapshot> {
  currentViewId: ViewId = 'home';
  viewParamsStore: ViewParamsStore = {};
  isNavigating: boolean = false;
  lastNonLibraryView: NonLibraryViewId = 'home';

  private readonly _guards = new Map<ViewId, (params: unknown) => GuardResult>();
  private readonly _registeredViewIds = new Set<ViewId>();
  private readonly _transientParamKeys = new Map<ViewId, readonly string[]>();

  constructor() {
    makeAutoObservable(this);
  }

  registerView(viewId: ViewId, options?: { transientParams?: readonly string[] }): void {
    this._registeredViewIds.add(viewId);
    if (options?.transientParams?.length) {
      this._transientParamKeys.set(viewId, options.transientParams);
    }
  }

  isRegisteredViewId(value: unknown): value is ViewId {
    return typeof value === 'string' && this._registeredViewIds.has(value as ViewId);
  }

  registerGuard(viewId: ViewId, guard: (params: unknown) => GuardResult): void {
    this._guards.set(viewId, guard);
  }

  private _runGuard(viewId: ViewId, params: unknown): GuardResult {
    return this._guards.get(viewId)?.(params) ?? { ok: true };
  }

  /**
   * @@@transient-view-params (#6033) - view params 有两种寿命,混在同一张表里就是那个 bug 的病根。
   *
   * **记住的参数**说的是「你上次在哪」(资源库停在哪一格、项目开的是哪个),它跨越离开与重启;
   * **转瞬参数**说的是「这一次进去要干什么」(把某个 agent 的详情抽屉打开),它只活这一次到访。
   *
   * 两者的区别本来只存在于人的脑子里:`navigate(viewId)` 不带 params 时会整份继承上次那一份
   * (那正是「位置记忆」这个功能),于是一个一次性意图一旦写进去,就获得了位置的寿命 ——
   * 每次进这个视图它都会再被执行一遍。⇒ 让视图在注册表里**说出**哪些键是转瞬的。
   *
   * 意图能活下来的路**一共三条**,三条都要堵,漏一条 bug 就整条回来:
   *   ① 参数表里躺着 → 落到另一个真会待着的视图时作废(见 `_applyNavigation`);
   *   ② 被录进后退栈 → 录之前就摘掉(见 `navigate`);
   *   ③ 被写进快照 → 恢复时不还原(见 `restoreSnapshot`)。
   * 「到访」是这三条共用的那个概念:它结束于你去了一个真会待着的地方,且不跨重启。
   */
  private _withoutTransientKeys<T extends ViewId>(viewId: T, params: WrapParams<T>): WrapParams<T> {
    const transientKeys = this._transientParamKeys.get(viewId);
    if (!transientKeys || !params) return params;
    const entries = Object.entries(params as Record<string, unknown>);
    const kept = entries.filter(([key]) => !transientKeys.includes(key));
    if (kept.length === entries.length) return params;
    return Object.fromEntries(kept) as WrapParams<T>;
  }

  private _viewParamsWithoutTransient(viewId: ViewId, store: ViewParamsStore): ViewParamsStore {
    const params = store[viewId];
    if (params === undefined) return store;
    const stripped = this._withoutTransientKeys(viewId, params as WrapParams<ViewId>);
    if (stripped === params) return store;
    return { ...store, [viewId]: stripped } as ViewParamsStore;
  }

  revalidate(): void {
    const result = this._runGuard(this.currentViewId, this.viewParamsStore[this.currentViewId]);
    if (!result.ok) this._applyNavigation(result.redirect, result.params as WrapParams<ViewId>);
  }

  navigate<T extends ViewId>(viewId: T, params?: WrapParams<T>): void {
    if (viewId !== 'session') {
      // 后退回到的是**位置**,不是当时那次意图:历史条目会被原样重放
      // (`applyHistoryEntry` → `_applyNavigation(viewId, entry.params)`),意图录进去就等于
      // 给它开了一条绕过「离开即作废」的后门 —— 用户明明把抽屉关掉了,按一下后退它又回来。
      const recorded = params ?? this.viewParamsStore[viewId] ?? ({} as WrapParams<T>);
      appState.history.push({
        kind: 'view',
        viewId,
        params: this._withoutTransientKeys(viewId, recorded),
      });
    }
    this._applyNavigation(viewId, params);
  }

  /**
   * behavior session-page「键盘导航」: ↑↓ take the main area with them, so those are not navigations
   * the user should have to walk back through — arrowing past ten projects must not leave ten
   * entries in the back stack. (`navigate('session')` already skips history for the same reason.)
   */
  navigateTransient<T extends ViewId>(viewId: T, params?: WrapParams<T>): void {
    this._applyNavigation(viewId, params);
  }

  _applyNavigation<T extends ViewId>(viewId: T, params?: WrapParams<T>): void {
    const resolvedParams = params ?? this.viewParamsStore[viewId];
    const guard = this._runGuard(viewId, resolvedParams);
    if (!guard.ok) {
      this._applyNavigation(guard.redirect, guard.params as WrapParams<typeof guard.redirect>);
      return;
    }

    if (viewId !== this.currentViewId) {
      // 到访结束于「你去了一个真的会待着的地方」:落地到某个视图时,**除目的地之外**每个视图的
      // 转瞬参数一律作废。设置是壳的弹窗(product spec),不经过这里,也就不结束到访。
      for (const owner of this._transientParamKeys.keys()) {
        if (owner === viewId) continue;
        this.viewParamsStore = this._viewParamsWithoutTransient(owner, this.viewParamsStore);
      }
      this.currentViewId = viewId;
      if (!isLibraryView(viewId)) {
        this.lastNonLibraryView = viewId;
      }
      this.isNavigating = true;
    }
    if (params !== undefined) {
      this.viewParamsStore = { ...this.viewParamsStore, [viewId]: params };
    }
    // Arriving at a session reveals it in the sidebar.
    if (viewId === 'session') {
      const session = this.viewParamsStore.session;
      appState.sidebar.revealActiveSession(
        session?.projectId && session.sessionId ? { projectId: session.projectId, sessionId: session.sessionId } : null
      );
    } else {
      appState.sidebar.revealActiveSession(null);
    }
    modalStore.closeModal();
  }

  updateViewParams<TId extends ViewId>(
    viewId: TId,
    update: Partial<WrapParams<TId>> | ((prev: WrapParams<TId>) => WrapParams<TId>)
  ): void {
    const current = (this.viewParamsStore[viewId] ?? {}) as WrapParams<TId>;
    const next = typeof update === 'function' ? update(current) : { ...current, ...update };
    this.viewParamsStore = { ...this.viewParamsStore, [viewId]: next };
  }

  get snapshot(): NavigationSnapshot {
    return {
      currentViewId: this.currentViewId,
      viewParams: toJS(this.viewParamsStore) as Record<string, unknown>,
    };
  }

  restoreSnapshot(snapshot: Partial<NavigationSnapshot>): void {
    // 设置从前是本页的一个视图,现在是壳的弹窗;旧快照里停在 'settings' 的,与任何认不出来的视图
    // 一样不还原,留在首页(isRegisteredViewId)。
    if (this.isRegisteredViewId(snapshot.currentViewId)) {
      this.currentViewId = snapshot.currentViewId;
      if (!isLibraryView(snapshot.currentViewId)) {
        this.lastNonLibraryView = snapshot.currentViewId;
      }
    }
    if (snapshot.viewParams) {
      const filtered: ViewParamsStore = {};
      for (const [key, value] of Object.entries(snapshot.viewParams)) {
        if (this.isRegisteredViewId(key)) {
          (filtered as Record<ViewId, unknown>)[key] = value;
        }
      }
      // 一次到访不跨重启:快照里残留的转瞬参数不恢复,否则上次没关的抽屉会跟着开机弹出来
      // (浮层不是你住的地方)。
      let restoredParams = filtered;
      for (const viewId of this._transientParamKeys.keys()) {
        restoredParams = this._viewParamsWithoutTransient(viewId, restoredParams);
      }
      this.viewParamsStore = restoredParams;
    }

    // Validate after params are loaded so the guard has full context.
    const guard = this._runGuard(this.currentViewId, this.viewParamsStore[this.currentViewId]);
    if (!guard.ok) {
      this.currentViewId = guard.redirect;
      if (!isLibraryView(guard.redirect)) {
        this.lastNonLibraryView = guard.redirect;
      }
      if (guard.params !== undefined) {
        this.viewParamsStore = { ...this.viewParamsStore, [guard.redirect]: guard.params };
      }
    }
  }
}
