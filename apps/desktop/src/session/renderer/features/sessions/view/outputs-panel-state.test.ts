import { describe, expect, it } from 'vitest';
import {
  INITIAL_OUTPUTS_PANEL,
  isOutputsPanelOpen,
  OutputsPanelStore,
  outputsPanelEventFor,
  reduceOutputsPanel,
  type OutputsPanelEvent,
  type OutputsPanelMode,
  type OutputsPanelState,
} from './outputs-panel-state';

/**
 * #6572 情况表,一格一条(编号与 PR 正文的表一致)。
 *
 * 「切走」在这里就是**什么都不报**:弹层只替正在显示的那条会话报屏上在跑的列表,别的 task 此刻不产生任何事件;
 * 「切回」= 按那一刻在跑的列表报一次 `running`。点侧栏切走本身是一次「点外面」,所以切走那一步写成 OUTSIDE。
 *
 * 人的手势(点 Outputs / 点外面 / 按 Esc)走组件用的同一个 `outputsPanelEventFor`,再进 reducer ——
 * 判「这一下收不收」的规则只有那一处。
 */
const running = (...ids: string[]): OutputsPanelEvent => ({ type: 'running', ids });
const dismiss = (id: string): OutputsPanelEvent => ({ type: 'dismiss', id });

type Gesture = { readonly gesture: 'button' | 'outside' | 'focus-out' | 'esc-outside' | 'esc-in-panel' };
const BUTTON: Gesture = { gesture: 'button' };
const OUTSIDE: Gesture = { gesture: 'outside' };
const FOCUS_OUT: Gesture = { gesture: 'focus-out' };
const ESC_OUTSIDE: Gesture = { gesture: 'esc-outside' };
const ESC_IN_PANEL: Gesture = { gesture: 'esc-in-panel' };

function apply(state: OutputsPanelState, step: OutputsPanelEvent | Gesture): OutputsPanelState {
  if (!('gesture' in step)) return reduceOutputsPanel(state, step);
  const open = isOutputsPanelOpen(state);
  const request = ((): [boolean, string, boolean] => {
    switch (step.gesture) {
      case 'button':
        return [!open, 'trigger-press', false];
      case 'outside':
        return [false, 'outside-press', false];
      case 'focus-out':
        return [false, 'focus-out', false];
      case 'esc-outside':
        return [false, 'escape-key', false];
      case 'esc-in-panel':
        return [false, 'escape-key', true];
    }
  })();
  // 收着的弹层不会再报「要收」—— 与 Base UI 一致,只有按钮能在收着时报开。
  if (!open && !request[0]) return state;
  const event = outputsPanelEventFor(request[0], request[1], { fromPanel: request[2], state });
  return event ? reduceOutputsPanel(state, event) : state;
}

type Step = readonly [OutputsPanelEvent | Gesture, OutputsPanelMode];
type Cell = { readonly name: string; readonly steps: readonly Step[] };

const CELLS: readonly Cell[] = [
  {
    name: '1 没有在跑的,点 Outputs ⇒ 开',
    steps: [
      [running(), 'closed'],
      [BUTTON, 'manual'],
    ],
  },
  {
    name: '2 开着,再点 Outputs ⇒ 收(自己弹的、人开的都一样)',
    steps: [
      [BUTTON, 'manual'],
      [BUTTON, 'closed'],
      [running('a'), 'auto'],
      [BUTTON, 'closed'],
    ],
  },
  {
    name: '3 收着,出现一条新的在跑条目 ⇒ 自己弹出来',
    steps: [
      [running(), 'closed'],
      [running('a'), 'auto'],
    ],
  },
  {
    name: '4 屏上有在跑的:点侧栏 / 点正文 / 焦点离开 / 焦点在外面按 Esc ⇒ 都不收',
    steps: [
      [running('a'), 'auto'],
      [OUTSIDE, 'auto'],
      [FOCUS_OUT, 'auto'],
      [ESC_OUTSIDE, 'auto'],
      [BUTTON, 'closed'],
      [BUTTON, 'manual'],
      [OUTSIDE, 'manual'],
      [ESC_OUTSIDE, 'manual'],
    ],
  },
  {
    name: '4b 焦点在面板里按 Esc ⇒ 收(等同手动收)',
    steps: [
      [running('a'), 'auto'],
      [ESC_IN_PANEL, 'closed'],
      [running('a'), 'closed'],
    ],
  },
  {
    name: '5 自己弹出来 → 点侧栏切走 → 切回,还在跑 ⇒ 还在',
    steps: [
      [running('a'), 'auto'],
      [OUTSIDE, 'auto'],
      [running('a'), 'auto'],
    ],
  },
  {
    name: '6 自己弹出来 → 切走期间全部结束 → 切回 ⇒ 已收',
    steps: [
      [running('a', 'b'), 'auto'],
      [OUTSIDE, 'auto'],
      [running(), 'closed'],
    ],
  },
  {
    name: '7 自己弹出来,看着全部结束 ⇒ 自己收',
    steps: [
      [running('a'), 'auto'],
      [running(), 'closed'],
    ],
  },
  {
    name: '8 多条部分结束 ⇒ 不收,最后一条结束才收',
    steps: [
      [running('a', 'b', 'c'), 'auto'],
      [running('b', 'c'), 'auto'],
      [running('c'), 'auto'],
      [running(), 'closed'],
    ],
  },
  {
    name: '9 自己弹出来后又起一条 ⇒ 保持,仍等全部结束',
    steps: [
      [running('a'), 'auto'],
      [running('a', 'b'), 'auto'],
      [running('b'), 'auto'],
      [running(), 'closed'],
    ],
  },
  {
    name: '10 手动收起后同一批还在跑,切走切回 ⇒ 还是收着',
    steps: [
      [running('a', 'b'), 'auto'],
      [BUTTON, 'closed'],
      [running('a', 'b'), 'closed'],
      [running('b'), 'closed'],
    ],
  },
  {
    name: '11 手动收起后又来一条新的 ⇒ 再自己弹出来',
    steps: [
      [running('a'), 'auto'],
      [BUTTON, 'closed'],
      [running('a', 'b'), 'auto'],
      [running('a'), 'auto'],
      [running(), 'closed'],
    ],
  },
  {
    name: '12 人开着(没在跑的)→ 命令开始(常驻)→ 结束 ⇒ 仍开着,变回普通浮层,点外面就收',
    steps: [
      [running(), 'closed'],
      [BUTTON, 'manual'],
      [running('a'), 'manual'],
      [OUTSIDE, 'manual'],
      [running(), 'manual'],
      [OUTSIDE, 'closed'],
    ],
  },
  {
    name: '13 自己弹 → 手动收 → 还在跑时手动开 → 结束 ⇒ 仍开着(普通浮层)',
    steps: [
      [running('a'), 'auto'],
      [BUTTON, 'closed'],
      [BUTTON, 'manual'],
      [running(), 'manual'],
      [FOCUS_OUT, 'closed'],
    ],
  },
  {
    name: '14 切走期间起了新的,切回时还在跑 ⇒ 切回时弹出来',
    steps: [
      [running(), 'closed'],
      [running('c'), 'auto'],
    ],
  },
  {
    name: '15 切走期间起了又结束 ⇒ 切回时收着',
    steps: [
      [running(), 'closed'],
      [running(), 'closed'],
    ],
  },
  {
    name: '22 卡上 × 移走最后一张在跑的 ⇒ 不自己收,变普通浮层;那条后来真结束也不收;点外面收',
    steps: [
      [running('a'), 'auto'],
      [dismiss('a'), 'manual'],
      // 移走之后花名册已滤掉它 ⇒ 屏上在跑的是空的。
      [running(), 'manual'],
      [OUTSIDE, 'closed'],
    ],
  },
  {
    name: '23 × 移走一张但还有别的在跑 ⇒ 仍常驻;剩下的全部结束 ⇒ 自己收',
    steps: [
      [running('a', 'b'), 'auto'],
      [dismiss('a'), 'auto'],
      [running('b'), 'auto'],
      [OUTSIDE, 'auto'],
      [running(), 'closed'],
    ],
  },
  {
    name: '25 没有在跑的时候人开着,点侧栏切 task ⇒ 收(普通浮层)',
    steps: [
      [BUTTON, 'manual'],
      [running(), 'manual'],
      [OUTSIDE, 'closed'],
    ],
  },
];

describe('#6572 情况表', () => {
  for (const cell of CELLS) {
    it(cell.name, () => {
      let state = INITIAL_OUTPUTS_PANEL;
      cell.steps.forEach(([step, expected], index) => {
        state = apply(state, step);
        expect({ step: index, mode: state.mode }).toEqual({ step: index, mode: expected });
        expect(isOutputsPanelOpen(state)).toBe(expected !== 'closed');
      });
    });
  }

  it('没变就原样返回同一个对象(调用方靠它判要不要写回)', () => {
    const state = reduceOutputsPanel(INITIAL_OUTPUTS_PANEL, running('a'));
    expect(reduceOutputsPanel(state, running('a'))).toBe(state);
    expect(reduceOutputsPanel(INITIAL_OUTPUTS_PANEL, { type: 'close' })).toBe(INITIAL_OUTPUTS_PANEL);
    expect(reduceOutputsPanel(INITIAL_OUTPUTS_PANEL, running())).toBe(INITIAL_OUTPUTS_PANEL);
    expect(reduceOutputsPanel(state, dismiss('not-shown'))).toBe(state);
  });

  it('打开的请求只认 Outputs 按钮', () => {
    for (const reason of ['outside-press', 'focus-out', 'escape-key', 'imperative-action', 'none']) {
      expect(outputsPanelEventFor(true, reason, { fromPanel: true, state: INITIAL_OUTPUTS_PANEL })).toBeNull();
    }
  });
});

describe('OutputsPanelStore — 按会话、按 task 各记各的', () => {
  it('16 同一 task 的两条会话互不串', () => {
    const panel = new OutputsPanelStore();
    panel.dispatch('conv-a', running('a1'));
    panel.dispatch('conv-b', running());
    expect(panel.stateOf('conv-a').mode).toBe('auto');
    expect(panel.stateOf('conv-b').mode).toBe('closed');

    panel.dispatch('conv-a', { type: 'close' });
    panel.dispatch('conv-b', running('b1'));
    expect(panel.stateOf('conv-a').mode).toBe('closed');
    expect(panel.stateOf('conv-b').mode).toBe('auto');
  });

  it('16/17 两个 task 各一份(每个 task 的视图模型一份 store),A 开着不会带到 B', () => {
    const sessionA = new OutputsPanelStore();
    const sessionB = new OutputsPanelStore();
    sessionA.dispatch('conv', running('a1'));
    expect(sessionA.stateOf('conv').mode).toBe('auto');
    expect(sessionB.stateOf('conv').mode).toBe('closed');

    // 切到 B 再切回 A:B 这一侧只报 B 自己的列表,A 的状态原样留着。
    sessionB.dispatch('conv', running());
    expect(sessionA.stateOf('conv').mode).toBe('auto');
  });

  it('同一条 id 出现在另一个 task 里照样算新的(seen 不跨 task)', () => {
    const sessionA = new OutputsPanelStore();
    const sessionB = new OutputsPanelStore();
    sessionA.dispatch('conv', running('same'));
    sessionA.dispatch('conv', { type: 'close' });
    sessionB.dispatch('conv', running('same'));
    expect(sessionA.stateOf('conv').mode).toBe('closed');
    expect(sessionB.stateOf('conv').mode).toBe('auto');
  });

  it('20/21 空闲回收 / 重启 ⇒ 新视图模型 = 新 store,人开过的也回到收着', () => {
    const before = new OutputsPanelStore();
    before.dispatch('conv', { type: 'open' });
    expect(before.stateOf('conv').mode).toBe('manual');

    const after = new OutputsPanelStore();
    expect(after.stateOf('conv')).toBe(INITIAL_OUTPUTS_PANEL);
    // 重放出来的命令不算在跑(runningBackgroundCommands 的重放规则)⇒ 列表是空的,不会弹。
    after.dispatch('conv', running());
    expect(after.stateOf('conv').mode).toBe('closed');
  });

  it('没见过的会话读出初始态,且读不写', () => {
    const panel = new OutputsPanelStore();
    expect(panel.stateOf('never')).toBe(INITIAL_OUTPUTS_PANEL);
    panel.dispatch('never', { type: 'close' });
    expect(panel.stateOf('never')).toBe(INITIAL_OUTPUTS_PANEL);
  });
});
