import { action, makeObservable, observable } from 'mobx';
import type { ScreenBlockContent } from './screen-layout';

/** 一条会话的页签存储里管单独成窗那几格的部分(PaneLayoutStore)。 */
export interface TabWindowHome {
  readonly windowPanes: ReadonlyMap<string, unknown>;
  returnFromWindow(windowPaneId: string, opts?: { activate?: boolean }): void;
}

/** 单独成窗的一枚页签:哪条会话的、装在那条会话页签存储(`home`)里哪一格。 */
export type AuxTabContent = { kind: 'tab'; projectId: string; sessionId: string; paneId: string; home: TabWindowHome };

/** 一扇窗装的:一整块(一个会话 / 一个 App),或一枚页签。 */
export type AuxWindowContent = ScreenBlockContent | AuxTabContent;

export type AuxWindow = {
  id: string;
  content: AuxWindowContent;
  /** 浏览器给的那扇窗;打开成功之前是 null。 */
  handle: Window | null;
  /** 拖到窗口外松手的那一点(屏幕坐标):窗开在那里。 */
  at?: { screenX: number; screenY: number };
  /** 开窗之前它在这屏的哪儿(挨着哪块、哪一边):「放回咕咕」回到这里。 */
  origin?: { neighborId: string; edge: 'left' | 'right' | 'top' | 'bottom' };
};

let nextWindow = 1;

/**
 * 单独成窗的那几样(spec session-page「一屏几块」:一枚页签、一整块、一个 App 都能单独成窗;窗口怎么叠交给系统)。
 *
 * 一样东西只在一处:在窗里 = 不在这屏的任何一块里,也不在别的窗里。窗里那块的界面由 AuxWindowHost 画进那扇窗,
 * 用的是同一份数据;这里只记有哪几扇、各装着什么、此刻焦点在哪扇(快捷键只给焦点所在的那一处)。
 */
export class AuxWindowStore {
  readonly windows = observable.map<string, AuxWindow>({}, { deep: false });
  /** 系统焦点此刻在哪扇子窗;在主窗 = null。 */
  focusedWindowId: string | null = null;

  constructor() {
    makeObservable(this, {
      focusedWindowId: observable,
      add: action,
      remove: action,
      setHandle: action,
      setFocused: action,
    });
  }

  add(content: AuxWindowContent, at?: AuxWindow['at'], origin?: AuxWindow['origin'] | null): string {
    const id = `w${nextWindow++}`;
    this.windows.set(id, { id, content, handle: null, ...(at ? { at } : {}), ...(origin ? { origin } : {}) });
    return id;
  }

  remove(id: string): AuxWindow | undefined {
    const window = this.windows.get(id);
    this.windows.delete(id);
    if (this.focusedWindowId === id) this.focusedWindowId = null;
    return window;
  }

  setHandle(id: string, handle: Window): void {
    const window = this.windows.get(id);
    if (window) this.windows.set(id, { ...window, handle });
  }

  setFocused(id: string | null): void {
    this.focusedWindowId = id;
  }

  windowOfSession(sessionId: string): AuxWindow | undefined {
    for (const window of this.windows.values()) {
      if (window.content.kind === 'session' && window.content.sessionId === sessionId) return window;
    }
    return undefined;
  }

  /** 装着这条会话里某几枚页签的那几扇窗。 */
  tabWindowsOfSession(sessionId: string): AuxWindow[] {
    return [...this.windows.values()].filter((window) => window.content.kind === 'tab' && window.content.sessionId === sessionId);
  }

  windowOfApp(tabKind: string): AuxWindow | undefined {
    for (const window of this.windows.values()) {
      if (window.content.kind === 'app' && window.content.tabKind === tabKind) return window;
    }
    return undefined;
  }

  /** 装着这条会话里某一枚页签的那扇窗(那一格的 id)。 */
  windowOfTabPane(paneId: string): AuxWindow | undefined {
    for (const window of this.windows.values()) {
      if (window.content.kind === 'tab' && window.content.paneId === paneId) return window;
    }
    return undefined;
  }

  windowOf(content: ScreenBlockContent): AuxWindow | undefined {
    return content.kind === 'session' ? this.windowOfSession(content.sessionId) : this.windowOfApp(content.tabKind);
  }
}

export const auxWindows = new AuxWindowStore();
