import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_SNAPSHOT_MAX_BYTES } from '@shared/extensions/extension-check';
import { AXTree, ariaSnapshot, locate, runSteps, type AXNode, type StepHost } from './extension-check-steps';

/**
 * `app_check { steps }` (owner 10-12): a control is found by its role and accessible name in the page's accessibility
 * tree, strictly (one or the step fails, naming candidates with the `within` that would name each), and the steps run
 * in order, each saying what it did and what the page said and would have done meanwhile. The trees here are shaped like
 * the ones read from four real Apps on mac1 (gugu-base evidence/2026-10-12-app-check-steps/m1): 片场's unnamed card
 * articles with a bold title, 全能搜索's named regions.
 */

let nextId = 0;
interface Spec {
  role: string;
  name?: string;
  children?: Spec[];
  ignored?: boolean;
  value?: string;
  props?: Record<string, unknown>;
}
function tree(spec: Spec): AXNode[] {
  const nodes: AXNode[] = [];
  const add = (s: Spec, parentId?: string): string => {
    const nodeId = String(++nextId);
    const node: AXNode = {
      nodeId,
      ...(parentId ? { parentId } : {}),
      role: { value: s.role },
      ...(s.name !== undefined ? { name: { value: s.name } } : {}),
      ...(s.ignored ? { ignored: true } : {}),
      ...(s.value !== undefined ? { value: { value: s.value } } : {}),
      properties: Object.entries(s.props ?? {}).map(([name, value]) => ({ name, value: { value } })),
      backendDOMNodeId: Number(nodeId),
    };
    nodes.push(node);
    node.childIds = (s.children ?? []).map((child) => add(child, nodeId));
    return nodeId;
  };
  add(spec);
  return nodes;
}
const text = (t: string): Spec => ({ role: 'StaticText', name: t });
const button = (name: string, props?: Record<string, unknown>): Spec => ({ role: 'button', name, children: [text(name)], ...(props ? { props } : {}) });
const card = (title: string, ...controls: Spec[]): Spec => ({
  role: 'article',
  children: [text('打不开：No such file there'), { role: 'strong', children: [text(title)] }, ...controls],
});
/** 片场's stage: two cards, each with its own 播放原片 and 批注; one picked. */
const studio = () =>
  tree({
    role: 'RootWebArea',
    children: [
      { role: 'generic', children: [button('开一轮'), button('设置')] },
      { role: 'main', children: [card('一句话进来（eve 配音）', button('播放原片'), button('经过：交了 1 版 · 选中'), button('批注')), card('一句话进来（eve）', button('播放原片'), button('经过：交了 1 版'), button('选这张'), button('批注'))] },
      { role: 'button', name: '隐藏的', ignored: true },
    ],
  });

describe('locate: role and name, strictly (Playwright getByRole)', () => {
  it('the same name wins over names containing it; one containing it, case aside, when none is the same; ignored never; img is image', () => {
    const t = new AXTree(studio());
    const name = (target: Parameters<typeof locate>[1]) => {
      const found = locate(t, target);
      return 'node' in found ? found.node.name?.value : found.error;
    };
    expect(name({ role: 'button', name: '选这张' })).toBe('选这张');
    expect(name({ role: 'button', name: '经过：交了 1 版' })).toBe('经过：交了 1 版');
    expect(name({ role: 'button', name: '交了 1 版 · 选' })).toBe('经过：交了 1 版 · 选中');
    expect(name({ role: 'button', name: '隐藏的' })).toBe('nothing matches button "隐藏的"');
    const none = locate(t, { role: 'button', name: '发布' });
    expect(none).toMatchObject({ error: 'nothing matches button "发布"', matched: 0 });
    expect(('candidates' in none && none.candidates.length) || 0).toBeGreaterThan(5);
    expect(locate(t, { role: 'checkbox' })).toMatchObject({ error: 'no checkbox here at all', candidates: [] });
    expect('node' in locate(new AXTree(tree({ role: 'RootWebArea', children: [{ role: 'image', name: 'Radar' }] })), { role: 'img', name: 'Radar' })).toBe(true);
  });

  it('several match: each candidate with the within that tells it apart, which narrows it — by name, or by text in a card without one; the within is strict too', () => {
    const t = new AXTree(studio());
    expect(locate(t, { role: 'button', name: '播放原片' })).toEqual({
      error: '2 match button "播放原片"',
      matched: 2,
      candidates: [
        'button "播放原片" within {"role":"article","text":"一句话进来（eve 配音）"}',
        'button "播放原片" within {"role":"article","text":"一句话进来（eve）"}',
      ],
    });
    const second = locate(t, { role: 'button', name: '播放原片', within: { role: 'article', text: '（eve）' } });
    expect('node' in second && t.ancestors(second.node).some((up) => t.textOf(up).includes('一句话进来（eve）'))).toBe(true);
    expect(locate(t, { role: 'button', name: '播放原片', within: { role: 'article', text: '一句话进来' } }))
      .toMatchObject({ error: '2 match the within {"role":"article","text":"一句话进来"}', matched: 2 });
    const regions = new AXTree(tree({ role: 'RootWebArea', children: [{ role: 'region', name: 'Web search', children: [button('Check')] }, { role: 'region', name: 'Read pages', children: [button('Check')] }] }));
    expect(locate(regions, { role: 'button', name: 'Check' })).toMatchObject({
      candidates: ['button "Check" within {"role":"region","name":"Web search"}', 'button "Check" within {"role":"region","name":"Read pages"}'],
    });
    expect('node' in locate(regions, { role: 'button', name: 'Check', within: { role: 'region', name: 'Read pages' } })).toBe(true);
    const nested = new AXTree(tree({ role: 'RootWebArea', children: [{ role: 'group', children: [text('Settings'), { role: 'group', children: [text('Keys'), button('Save')] }, button('Save')] }] }));
    const inner = locate(nested, { role: 'button', name: 'Save', within: { role: 'group', text: 'Keys' } });
    expect('node' in inner && nested.ancestors(inner.node)[0] && nested.textOf(nested.ancestors(inner.node)[0]!)).toBe('Keys Save');
  });
});

describe('the snapshot: ARIA YAML of what the page shows', () => {
  it('a line per node — role, name, states, a field\'s value once — wrappers folded, a name\'s own text not said twice; cut at its size', () => {
    const nodes = tree({
      role: 'RootWebArea',
      children: [
        { role: 'generic', children: [{ role: 'heading', name: 'Votes', props: { level: 1 }, children: [text('Votes')] }] },
        { role: 'textbox', name: 'API key', value: 'fc-F••••WXYZ', children: [text('fc-F••••WXYZ')] },
        { role: 'button', name: 'Preview', props: { pressed: true }, children: [text('Preview')] },
        { role: 'button', name: 'Hidden', ignored: true },
        { role: 'list', children: [{ role: 'listitem', children: [{ role: 'ListMarker', name: '•' }, text('火锅 2 票')] }] },
      ],
    });
    expect(ariaSnapshot(nodes)).toBe(
      [
        '- heading "Votes" [level=1]',
        '- textbox "API key": "fc-F••••WXYZ"',
        '- button "Preview" [pressed]',
        '- list',
        '  - listitem',
        '    - text: "火锅 2 票"',
      ].join('\n'),
    );
    const many = ariaSnapshot(tree({ role: 'RootWebArea', children: Array.from({ length: 400 }, (_, i) => button(`按钮 ${i} 的名字长一点`)) }));
    expect(Buffer.byteLength(many)).toBeLessThanOrEqual(EXTENSION_SNAPSHOT_MAX_BYTES);
    expect(many).toMatch(/\n- … \d+ more lines \(the snapshot stops at 6 KB\)$/);
    expect(ariaSnapshot(tree({ role: 'RootWebArea', children: [button('One')] })), 'control: a small page is whole').toBe('- button "One"');
    const long = ariaSnapshot(tree({ role: 'RootWebArea', children: [{ role: 'paragraph', children: [text('长'.repeat(10_000))] }, button('After')] }));
    expect(long).toMatch(/^- paragraph\n {2}- text: "长+…\n- button "After"$/);
  });
});

/**
 * A page for the steps: its tree (changeable), boxes, text, and every CDP command it was sent. `release`: how a mouse
 * button's release is answered — at once, late, or never (a page busy with what the press set off).
 */
function fakePage(initial: AXNode[]) {
  const page = {
    nodes: initial,
    text: '',
    sent: [] as { method: string; params?: Record<string, unknown> }[],
    errors: [] as ReturnType<StepHost['said']>['errors'],
    writes: 0,
    release: 'now' as 'now' | 'late' | 'never',
  };
  const host = (overrides: Partial<StepHost> = {}): StepHost => ({
    cdp: async (method, params) => {
      page.sent.push({ method, ...(params ? { params } : {}) });
      if (method === 'Accessibility.getFullAXTree') return { nodes: page.nodes };
      if (method === 'DOM.getBoxModel') return { model: { border: [10, 20, 110, 20, 110, 60, 10, 60] } };
      if (method === 'DOM.resolveNode') return { object: { objectId: 'obj-1' } };
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && page.release !== 'now') {
        return new Promise((resolve) => page.release === 'late' && setTimeout(() => resolve({}), 1_600));
      }
      return {};
    },
    evaluate: async (code) => {
      if (code.includes('innerText')) return page.text;
      throw new Error('boom');
    },
    settle: async () => true,
    said: () => ({ errors: [...page.errors], console: [], readings: { writes: page.writes, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 1, opensSettled: 1, shown: [] } }),
    picture: async (label) => ({ label, mimeType: 'image/jpeg', data: 'AAAA' }),
    touch: false,
    deadline: Date.now() + 15_000,
    ...overrides,
  });
  return { page, host };
}
const inputs = (page: ReturnType<typeof fakePage>['page']) => page.sent.filter(({ method }) => /^Input\.|callFunctionOn/.test(method));

describe('runSteps: in order, each saying what it did', () => {
  it('a click is a mouse click at the control\'s centre, a tap on a phone; look adds a picture after that step', async () => {
    const { page, host } = fakePage(studio());
    const ran = await runSteps([{ click: { role: 'button', name: '选这张' }, look: true }], host());
    expect(ran.results).toEqual([{ step: 1, ok: true, did: 'clicked button "选这张"' }]);
    expect(ran.pictures.map(({ label }) => label)).toEqual(['after step 1']);
    expect(inputs(page).map(({ params }) => params)).toEqual([
      { type: 'mouseMoved', x: 60, y: 40 },
      { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 },
    ]);
    const phone = fakePage(studio());
    const tapped = await runSteps([{ click: { role: 'button', name: '选这张' } }], phone.host({ touch: true }));
    expect(tapped.results[0]!.did).toBe('tapped button "选这张"');
    expect(inputs(phone.page).map(({ method, params }) => `${method} ${String(params?.type)}`)).toEqual(['Input.dispatchTouchEvent touchStart', 'Input.dispatchTouchEvent touchEnd']);
  });

  it('a step that cannot be done fails saying why — several match, disabled, not shown, not a field — and stops the rest; fill types over what was there', async () => {
    const { host } = fakePage(studio());
    const ran = await runSteps([{ click: { role: 'button', name: '开一轮' } }, { click: { role: 'button', name: '播放原片' } }, { click: { role: 'button', name: '设置' } }], host());
    expect(ran.results.map(({ ok }) => ok)).toEqual([true, false, null]);
    expect(ran.results[1]).toMatchObject({ error: '2 match button "播放原片"', candidates: [expect.stringContaining('within'), expect.stringContaining('within')] });
    expect(ran.results[2]).toEqual({ step: 3, ok: null, error: 'not run: step 2 failed' });
    const nodes = tree({ role: 'RootWebArea', children: [button('Send', { disabled: true }), { role: 'textbox', name: 'Title', value: 'old' }, button('Go')] });
    const form = fakePage(nodes);
    const results = async (step: Parameters<typeof runSteps>[0][number], h = form.host()) => (await runSteps([step], h)).results[0];
    expect(await results({ click: { role: 'button', name: 'Send' } })).toMatchObject({ ok: false, error: 'button "Send" is disabled' });
    expect(await results({ fill: { role: 'button', name: 'Go' }, text: 'x' })).toMatchObject({ ok: false, error: 'button "Go" is not something to type in' });
    const hidden = fakePage(nodes);
    const noBox: StepHost['cdp'] = (method, params) => (method === 'DOM.getBoxModel' ? Promise.reject(new Error('Could not compute box model.')) : hidden.host().cdp(method, params));
    expect(await results({ click: { role: 'button', name: 'Go' } }, hidden.host({ cdp: noBox }))).toMatchObject({ ok: false, error: 'button "Go" is not shown' });
    expect(await results({ fill: { role: 'textbox', name: 'Title' }, text: '周五吃什么' })).toMatchObject({ ok: true, did: 'filled textbox "Title" with "周五吃什么"' });
    expect(inputs(form.page).map(({ method }) => method).slice(-5)).toEqual(['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Runtime.callFunctionOn', 'Input.insertText']);
    expect(form.page.sent.at(-1)!.params).toEqual({ text: '周五吃什么' });
  });

  // Owner 10-13: 日历 adds a to-do on Enter (a form with no button) — a key on what has the focus, as a person's.
  it('press: a key down and up on what has the focus — Enter with its text, so a form submits; a key that types nothing raw', async () => {
    const { page, host } = fakePage(tree({ role: 'RootWebArea', children: [{ role: 'textbox', name: '加一条待办，回车' }] }));
    const ran = await runSteps([{ fill: { role: 'textbox', name: '加一条待办' }, text: '买菜' }, { press: 'Enter' }, { press: 'Escape' }], host());
    expect(ran.results.map(({ ok, did }) => [ok, did])).toEqual([[true, 'filled textbox "加一条待办" with "买菜"'], [true, 'pressed Enter'], [true, 'pressed Escape']]);
    expect(page.sent.filter(({ method }) => method === 'Input.dispatchKeyEvent').map(({ params }) => params)).toEqual([
      { type: 'keyDown', text: '\r', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
      { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
      { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ]);
  });

  it('waits up to 5 s for what is not there yet — waitFor (another member\'s change too) and a click\'s control alike; several match fail at once', async () => {
    vi.useFakeTimers();
    try {
      const { page, host } = fakePage(tree({ role: 'RootWebArea', children: [button('选这张')] }));
      const waiting = runSteps([{ waitFor: { role: 'heading', name: '剪整片' } }, { waitFor: { text: '片子做好了' } }], host());
      setTimeout(() => {
        page.nodes = tree({ role: 'RootWebArea', children: [{ role: 'heading', name: '剪整片', children: [text('剪整片')] }] });
        page.text = '剪整片\n片子做好了';
      }, 1_200);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await waiting).results).toEqual([{ step: 1, ok: true, did: 'saw heading "剪整片"' }, { step: 2, ok: true, did: 'saw the text "片子做好了"' }]);
      const late = runSteps([{ waitFor: { text: '下一轮' } }], host());
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await late).results[0]).toMatchObject({ ok: false, error: 'the text "下一轮" did not show in 5 s' });
      expect((await runSteps([{ waitFor: { role: 'button', name: '播放原片' } }], fakePage(studio()).host())).results[0]).toMatchObject({ ok: false, error: '2 match button "播放原片"' });
      // mac1 10-12: 片场 0.5.0 drew its cards after the check settled — the click waits for its card.
      const drawing = fakePage(tree({ role: 'RootWebArea', children: [button('开一轮')] }));
      const drawn = runSteps([{ click: { role: 'button', name: '选这张', within: { role: 'article', text: '卡甲' } } }], drawing.host());
      setTimeout(() => { drawing.page.nodes = tree({ role: 'RootWebArea', children: [card('卡甲：一句话进来', button('选这张'))] }) }, 1_500);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((await drawn).results[0]).toMatchObject({ ok: true, did: 'clicked button "选这张" within {"role":"article","text":"卡甲"}' });
      const never = runSteps([{ click: { role: 'button', name: '发布' } }], drawing.host());
      await vi.advanceTimersByTimeAsync(6_000);
      expect((await never).results[0]).toMatchObject({ ok: false, error: 'nothing matches button "发布" (waited 5 s)' });
    } finally {
      vi.useRealTimers();
    }
  });

  // Review 10-12: a step that never answered, or a picture that never came, held app_check (and its hidden window) for good.
  it('nothing outlasts the steps\' time: a step or a picture that never comes fails its step there, the rest are not run; waits stop at it, saying how long they waited', async () => {
    vi.useFakeTimers();
    // Whether the steps returned within `ms` (a run that never returns fails here, never hangs the test).
    const by = async (ms: number, running: ReturnType<typeof runSteps>) => {
      let ran: Awaited<typeof running> | undefined;
      void running.then((value) => (ran = value));
      await vi.advanceTimersByTimeAsync(ms);
      expect(ran, `the steps returned within ${ms} ms`).toBeDefined();
      return ran!.results;
    };
    try {
      const { page, host } = fakePage(studio());
      page.release = 'never';
      expect(await by(2_000, runSteps([{ click: { role: 'button', name: '开一轮' } }, { click: { role: 'button', name: '设置' } }], host({ deadline: Date.now() + 1_500 })))).toEqual([
        { step: 1, ok: false, error: 'it did not finish within the steps\' time' },
        { step: 2, ok: null, error: 'not run: step 1 failed' },
      ]);
      page.release = 'now';
      const blind = host({ deadline: Date.now() + 1_500, picture: () => new Promise(() => undefined) });
      expect((await by(2_000, runSteps([{ click: { role: 'button', name: '开一轮' }, look: true }, { click: { role: 'button', name: '设置' } }], blind))).map(({ ok, error }) => [ok, error]))
        .toEqual([[false, 'its picture did not come within the steps\' time'], [null, 'not run: step 1 failed']]);
      expect((await by(2_000, runSteps([{ waitFor: { text: '下一轮' } }], host({ deadline: Date.now() + 1_500 }))))[0])
        .toMatchObject({ ok: false, error: 'the text "下一轮" did not show in 1.5 s' });
      expect((await by(2_000, runSteps([{ click: { role: 'button', name: '发布' } }], host({ deadline: Date.now() + 1_500 }))))[0])
        .toMatchObject({ ok: false, error: 'nothing matches button "发布" (waited 1.5 s)' });
      // Review r1: a step done within the poll of grace keeps its picture — the picture's race has the same grace.
      page.release = 'late';
      const quick = host({ deadline: Date.now() + 1_500, picture: (label) => new Promise((resolve) => setTimeout(() => resolve({ label, mimeType: 'image/jpeg', data: 'AAAA' }), 50)) });
      expect(await by(2_500, runSteps([{ click: { role: 'button', name: '开一轮' }, look: true }], quick))).toEqual([{ step: 1, ok: true, did: 'clicked button "开一轮"' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('what the page said and would have done during a step is that step\'s alone; past the steps\' time the rest are not run', async () => {
    const { page, host } = fakePage(studio());
    page.errors.push({ kind: 'uncaught', level: 'error', message: 'old' });
    const ran = await runSteps([{ click: { role: 'button', name: '选这张' } }], {
      ...host(),
      settle: async () => {
        page.errors.push({ kind: 'uncaught', level: 'error', message: 'TypeError: card is undefined' });
        page.writes += 2;
        return true;
      },
    });
    expect(ran.results[0]).toMatchObject({ ok: true, errors: [{ message: 'TypeError: card is undefined' }], writes: 2 });
    // Review r2: a page that stops answering after a step fails that step, whatever the step itself did.
    expect((await runSteps([{ click: { role: 'button', name: '开一轮' } }, { click: { role: 'button', name: '设置' } }], host({ settle: async () => false }))).results).toEqual([
      { step: 1, ok: false, error: 'the page stopped answering after it' },
      { step: 2, ok: null, error: 'not run: step 1 failed' },
    ]);
    expect((await runSteps([{ click: { role: 'button', name: '开一轮' } }, { click: { role: 'button', name: '设置' } }], host({ deadline: Date.now() - 1 }))).results).toEqual([
      { step: 1, ok: null, error: 'not run: the steps\' time was up (0 of 2 done)' },
      { step: 2, ok: null, error: 'not run: the steps\' time was up (0 of 2 done)' },
    ]);
  });
});
