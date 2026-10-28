import { action, makeObservable, observable, reaction } from 'mobx';

/**
 * 页签全屏(owner 10-28「全屏和 separate view 肯定是不一样的两个操作」):这一枚页签临时盖住整个工作区(这一屏所有块),
 * **不动布局** —— 并排、分界比例、哪块在哪都原样,也不进任何存档;退出就是这个状态清掉,布局本来就没变过。
 * 拆开 / separate view(`PaneStore.separatePair`)才是改布局,两者各走各的。
 *
 * 只认格子本身(PaneStore 实例)和页签 id:哪一格在画它,哪一格就把自己整个铺到工作区上(pane-content)。
 */
export type TabFullscreenPane = {
  readonly entries: { has(tabId: string): boolean };
  readonly resolvedActiveTabId: string | null | undefined;
};

export type TabFullscreenTarget = { pane: TabFullscreenPane; tabId: string };

/** 工作区的锚点名:ScreenFrame(这一屏的骨架)挂着它,全屏的那一格贴到它的四条边上。 */
export const WORKSPACE_ANCHOR = '--gg-workspace';

class TabFullscreen {
  target: TabFullscreenTarget | null = null;

  constructor() {
    makeObservable(this, { target: observable.ref, toggle: action, exit: action });
    // 这一枚关掉了、或这一格换成别的页签了 ⇒ 自己退出(别处打开了别的东西,焦点也就不在它上面了)。
    reaction(
      () => {
        const target = this.target;
        return target !== null && (!target.pane.entries.has(target.tabId) || target.pane.resolvedActiveTabId !== target.tabId);
      },
      (gone) => { if (gone) this.exit(); },
    );
    // 全屏时 Esc 退出;但 Esc 先给正在用它的东西:弹窗 / 菜单、输入框、终端、编辑器。
    reaction(
      () => this.target !== null,
      (on) => {
        if (!on || typeof window === 'undefined') return;
        const onKey = (event: KeyboardEvent) => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !escapeIsFree(event.target)) return;
          event.preventDefault();
          this.exit();
        };
        window.addEventListener('keydown', onKey);
        const stop = reaction(() => this.target !== null, (still) => { if (!still) { window.removeEventListener('keydown', onKey); stop(); } });
      },
    );
  }

  isOn(pane: TabFullscreenPane, tabId?: string): boolean {
    const target = this.target;
    return target !== null && target.pane === pane && (tabId === undefined || target.tabId === tabId);
  }

  toggle(pane: TabFullscreenPane, tabId: string): void {
    this.target = this.isOn(pane, tabId) ? null : { pane, tabId };
  }

  exit(): void {
    this.target = null;
  }
}

/** Esc 这一下是不是没人在用:焦点在输入框 / 终端 / 编辑器里,或者开着弹窗、菜单,都留给它们。 */
export function escapeIsFree(target: EventTarget | null): boolean {
  if (typeof document === 'undefined') return true;
  const el = target instanceof Element ? target : null;
  if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .xterm, .monaco-editor, [role="dialog"], [role="menu"], [role="listbox"]')) return false;
  return document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]') === null;
}

export const tabFullscreen = new TabFullscreen();
