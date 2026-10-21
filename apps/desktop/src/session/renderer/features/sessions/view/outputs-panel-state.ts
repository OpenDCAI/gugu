import { observable, runInAction } from 'mobx';

/**
 * 「输出/来源」面板开还是收(#6572)。
 *
 * owner 2026-09-26:「有 background commands 的时候,不应该因为我点击了其它 task 切走了就永久隐藏了。
 * 应该等我切回去之后还能在那边。只有我手动点击了 x 或者 outputs 按钮才会折叠起来。而本身因为
 * background commands 展开的情况下,当 background commands 都结束后,也会自动收起来。」
 * 同日补的几格:子智能体与后台命令同算;焦点在面板里按 Esc 算手动收;用卡上的 × 把最后一张在跑的卡移走
 * 「不应该主动收吧。不过这时候应该转变为,用户点击其它地方就可以收的形态」。
 *
 * # 一条规则
 *
 * - **屏上还有在跑的条目(没被 × 移走的)⇒ 常驻**:点外面、切 task 都不收,只认 Outputs 按钮与面板里的 Esc。
 * - **屏上没有在跑的了 ⇒ 普通浮层**:点外面就收。
 * - 自己弹出来的(`auto`)在跑的一条不剩就自己收;人点开的(`manual`)不自己收。
 *   用 × 移走最后一张卡的那一刻,自己弹出来的面板改记成人接手的(`manual`):不自己收,点外面收。
 *
 * # `seen`:同一批不弹第二次
 *
 * 触发自动弹出的是「**出现了以前没见过的那一条**」,❌ 不是「列表非空」:后者会在人收起之后,
 * 趁那几条还在跑又把面板弹回来,变成关不掉的东西。记的是 id 的集合而不是个数:三条跑完、又起三条新的,
 * 个数没变但确实该弹。
 *
 * # 状态住在哪儿
 *
 * 按会话一份,挂在这个 task 的 `WorkspaceViewModel` 上(`OutputsPanelStore`)。
 * ❌ 组件 state:切 task 时任务视图**不重建**(`workspace.tsx` 的 WrapView 不带 key),同一个弹层实例
 * 换个 conversationId 接着用 ⇒ 所有 task 共用一份开合,切走时那次外部点击把它关掉,切回来 `seen` 又拦着不弹 ——
 * 这就是「切走一次就永久隐藏」。挂在视图模型上:切 task 保留;空闲回收 / 归档会换一个新视图模型、
 * 重启全部重来 ⇒ 回来时是「重启后还没打开过」的样子。
 */
export type OutputsPanelMode = 'closed' | 'auto' | 'manual';

export type OutputsPanelState = {
  readonly mode: OutputsPanelMode;
  /** 已经为它弹过的在跑条目 id(后台命令 / 子智能体的转录条目 id)。 */
  readonly seen: ReadonlySet<string>;
  /** 上一次报来的「屏上在跑的」(已按过 × 的不在里面)。非空 ⇒ 面板常驻。 */
  readonly shown: ReadonlySet<string>;
};

export type OutputsPanelEvent =
  /** 这条会话**此刻**屏上在跑的条目 —— 每次花名册变了就报一次(报的是全量,不是增量)。 */
  | { readonly type: 'running'; readonly ids: readonly string[] }
  /** 人点 Outputs 打开。 */
  | { readonly type: 'open' }
  /** 人收起:点 Outputs、焦点在面板里按 Esc、或普通浮层形态下点了外面。 */
  | { readonly type: 'close' }
  /** 人按卡上的 × 把这一条从面板上移走(命令照跑)。 */
  | { readonly type: 'dismiss'; readonly id: string };

export const INITIAL_OUTPUTS_PANEL: OutputsPanelState = {
  mode: 'closed',
  seen: new Set(),
  shown: new Set(),
};

function sameIds(a: ReadonlySet<string>, b: readonly string[]): boolean {
  return a.size === b.length && b.every((id) => a.has(id));
}

/** 纯函数;没变就原样返回同一个对象(调用方靠引用相等判「要不要写回」)。 */
export function reduceOutputsPanel(
  state: OutputsPanelState,
  event: OutputsPanelEvent
): OutputsPanelState {
  switch (event.type) {
    case 'open':
      return state.mode === 'manual' ? state : { ...state, mode: 'manual' };
    case 'close':
      return state.mode === 'closed' ? state : { ...state, mode: 'closed' };
    case 'dismiss': {
      if (!state.shown.has(event.id)) return state;
      const shown = new Set(state.shown);
      shown.delete(event.id);
      // 自己弹出来的面板,人把最后一张卡移走 ⇒ ❌ 替他收(owner:「不应该主动收吧」),改成人接手的。
      const mode = state.mode === 'auto' && shown.size === 0 ? 'manual' : state.mode;
      return { ...state, mode, shown };
    }
    case 'running': {
      const fresh = event.ids.filter((id) => !state.seen.has(id));
      const seen = fresh.length === 0 ? state.seen : new Set([...state.seen, ...fresh]);
      const shown = sameIds(state.shown, event.ids) ? state.shown : new Set(event.ids);
      let mode = state.mode;
      // 收着 + 来了新的 ⇒ 自己弹出来。人开着的不改成 auto:它不是因为命令才开的,命令结束也不该收。
      if (fresh.length > 0 && mode === 'closed') mode = 'auto';
      // 因为命令弹出来的 ⇒ 在跑的一条不剩就自己收。人没看着(切走了)也一样:切回来就是收着的。
      else if (event.ids.length === 0 && mode === 'auto') mode = 'closed';
      return mode === state.mode && seen === state.seen && shown === state.shown
        ? state
        : { mode, seen, shown };
    }
  }
}

export function isOutputsPanelOpen(state: OutputsPanelState): boolean {
  return state.mode !== 'closed';
}

/**
 * 弹层报来的一次开合请求(Base UI `onOpenChange` 的 reason)算不算人的动作;`null` = 面板不动。
 *
 * - Outputs 按钮(`trigger-press`):开 / 收。
 * - Esc:只在按键就发自面板里时算(等同手动收)。焦点在终端 / 输入框里的 Esc 是「打断」,不是冲着面板来的。
 * - 点外面(`outside-press`,含点侧栏切 task)与焦点离开(`focus-out`):屏上还有在跑的条目 ⇒ 常驻,不收;
 *   没有了 ⇒ 普通浮层,收。
 */
export function outputsPanelEventFor(
  nextOpen: boolean,
  reason: string,
  input: { readonly fromPanel: boolean; readonly state: OutputsPanelState }
): OutputsPanelEvent | null {
  if (reason === 'trigger-press') return { type: nextOpen ? 'open' : 'close' };
  if (nextOpen) return null;
  if (reason === 'escape-key') return input.fromPanel ? { type: 'close' } : null;
  if (reason === 'outside-press' || reason === 'focus-out') {
    return input.state.shown.size === 0 ? { type: 'close' } : null;
  }
  return null;
}

/** 一个 task 的面板开合,按会话各记一份(同一 task 里的 side chat / 子会话互不串)。 */
export class OutputsPanelStore {
  private readonly _bySession = observable.map<string, OutputsPanelState>(
    {},
    { deep: false }
  );

  stateOf(sessionId: string): OutputsPanelState {
    return this._bySession.get(sessionId) ?? INITIAL_OUTPUTS_PANEL;
  }

  dispatch(sessionId: string, event: OutputsPanelEvent): void {
    const previous = this.stateOf(sessionId);
    const next = reduceOutputsPanel(previous, event);
    if (next === previous) return;
    runInAction(() => {
      this._bySession.set(sessionId, next);
    });
  }
}
