/**
 * owner 10-07:「新建 task 选属性的时候,比如换一个模型或者换一个 thinking level,我发现只要一选,整个……pop-up menu
 * 就直接没了。这是不对的,应该是我调完一个设置后还可以继续调另一个」。两颗选项胶囊(新建、会话)同一条:
 *   · 在下钻页选 → 回顶层,抽屉还在,摘要行上是刚改的值,接着点下一项;
 *   · 在顶层选 → 留在顶层、勾移过去;
 *   · 会话胶囊重选当前值 → 回顶层,不下发;下发失败 → 停在原页、写出错误;
 *   · 关只靠 ✕;下发还在路上时关掉的抽屉,机器回话后不再自己弹开(复核 #6972 F1)。
 * 手机视口、真 Chromium、真组件;会话那颗的机器端换成内存里的一份选项,每条用例从同一份起步。
 */
import { createRoot, type Root } from 'react-dom/client';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SessionOptionsPill } from '@/mobile/agent-watch/SessionOptionsPill';
import { CreateOptionsPill } from '@/mobile/agent-watch/CreateOptionsPill';
import type { CreateSelection } from '@/mobile/agent-watch/create-session-form';
import '@/i18n';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import '@/mobile/agent-watch/agent-watch.css';

type Group = { selected: string; available: Array<{ id: string; name: string }> };
const { machine, initialOptions } = vi.hoisted(() => {
  const group = (ids: string[]) => ({ selected: ids[0]!, available: ids.map((id) => ({ id, name: id })) });
  const initialOptions = (): Record<string, Group> => ({ model: group(['model-1', 'model-2', 'model-3']), mode: group(['default', 'plan']), effort: group(['low', 'high']) });
  return {
    initialOptions,
    machine: {
      options: initialOptions(),
      sets: 0,
      failNext: false,
      /** 为真时下发停在路上,直到用例调 `release()`(机器回话)。 */
      hold: false,
      release: null as null | (() => void),
    },
  };
});
vi.mock('@/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class extends Error {},
  fetchSessionOptions: async () => structuredClone(machine.options),
  setSessionOption: async (_device: string, { dimension, value }: { dimension: string; value: string }) => {
    machine.sets += 1;
    if (machine.hold) await new Promise<void>((resolve) => { machine.release = resolve; });
    if (machine.failNext) {
      machine.failNext = false;
      throw new Error('the machine refused');
    }
    machine.options[dimension]!.selected = value;
    return structuredClone(machine.options);
  },
  reloadSessionModel: async () => structuredClone(machine.options),
}));

let root: Root | null = null;
beforeEach(() => {
  Object.assign(machine, { options: initialOptions(), sets: 0, failNext: false, hold: false, release: null });
  return page.viewport(412, 842);
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.replaceChildren();
});
const mount = (node: ReactNode) => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  root.render(node);
};
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const click = async (selector: string) => {
  await until(`${selector} is on screen`, () => q(selector) != null);
  await userEvent.click(q(selector)!);
};

const OPTIONS = {
  projects: [{ id: 'p1', name: 'project-1', path: '/Users/owner/Codebase/project-1' }, { id: 'p2', name: 'project-2', path: '/Users/owner/Codebase/project-2' }],
  harnesses: [
    { id: 'codex', name: 'Codex', status: 'available', sessionViews: ['general', 'code'], permissionModes: ['plan', 'read-only', 'edit', 'full-access'], watchable: true },
    { id: 'claude', name: 'Claude', status: 'available', sessionViews: ['general'], permissionModes: [], watchable: true },
  ],
  lastUsed: null,
} as unknown as Parameters<typeof CreateOptionsPill>[0]['options'];
const MODELS = {
  harness: 'codex', transport: 'acp', selected: null, selectedEffort: null, harnessState: 'ready', harnessReason: null, guguReason: null,
  models: [{ id: 'm1', name: 'Model 1', source: 'harness' }, { id: 'm2', name: 'Model 2', source: 'harness' }],
  efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
} as unknown as Parameters<typeof CreateOptionsPill>[0]['models'];

/** 新建页那一层:选择留在页面状态里,胶囊只回报。 */
function CreatePage({ terminalEnabled = false }: { terminalEnabled?: boolean }) {
  const [selection, setSelection] = useState<CreateSelection>({ projectId: 'p1', harness: 'codex', model: null, permissionMode: null, effort: null });
  return <CreateOptionsPill terminalEnabled={terminalEnabled} options={OPTIONS} selection={selection} onChange={setSelection} busy={false} models={MODELS} modelsState="ready" />;
}

it('create options: picking a model, then a thinking level, then a project keeps the sheet open; the summary shows each new value', async () => {
  mount(<CreatePage />);
  await click('[data-testid="agent-watch-create-options-open"]');
  const sheet = '[data-testid="agent-watch-create-options"]';
  const atRoot = () => q(`${sheet} .gg-aw-summary-group`) != null;
  const summary = (dimension: string) => q(`${sheet} [data-testid="agent-watch-create-options-drill"][data-dimension="${dimension}"] .gg-aw-summary-value`)?.textContent;
  await until('the sheet opens on the root page', atRoot);
  const defaultModel = summary('model');

  await click(`${sheet} [data-testid="agent-watch-create-options-drill"][data-dimension="model"]`);
  await until('the model page', () => q(`${sheet} [data-dimension="model"][role="radiogroup"]`) != null && !atRoot());
  await click(`${sheet} [data-testid="agent-watch-create-choice"][data-dimension="model"][data-option-id="m2"]`);
  await until('back on the root page after picking a model', atRoot);
  expect(q(sheet), 'the sheet is still open').toBeTruthy();
  expect(summary('model')).toBe('Model 2');

  await click(`${sheet} [data-testid="agent-watch-create-options-drill"][data-dimension="effort"]`);
  await until('the effort page', () => !atRoot());
  await click(`${sheet} [data-testid="agent-watch-create-choice"][data-dimension="effort"][data-option-id="high"]`);
  await until('back on the root page after picking a thinking level', atRoot);
  expect(q(sheet), 'the sheet is still open').toBeTruthy();
  expect(summary('effort')).toBe('High');
  expect(summary('model'), 'the model picked before is kept').toBe('Model 2');

  // 顶层那一档(项目):留在顶层,勾移过去。
  await click(`${sheet} [data-testid="agent-watch-create-choice"][data-dimension="project"][data-option-id="p2"]`);
  await until('the tick moves to project-2', () => q(`${sheet} [data-dimension="project"][data-option-id="p2"]`)?.getAttribute('aria-checked') === 'true');
  expect(atRoot(), 'still on the root page').toBe(true);

  // 换 harness 会把模型、推理档重置成那一家的:回顶层后摘要读到的是重置后的值。
  await click(`${sheet} [data-testid="agent-watch-create-options-drill"][data-dimension="harness"]`);
  await click(`${sheet} [data-testid="agent-watch-create-choice"][data-dimension="harness"][data-option-id="claude"]`);
  await until('back on the root page after switching harness', atRoot);
  expect(summary('harness')).toBe('Claude');
  expect(summary('model'), 'the model went back to the default with the harness').toBe(defaultModel);

  await click('[data-testid="agent-watch-create-options-nav"]');
  await until('✕ closes the sheet', () => q(sheet) == null);
});

it('session options: a root pick stays on the root, a drill-down pick comes back to it, a re-pick sends nothing, a refused pick stays with the error', async () => {
  mount(<SessionOptionsPill deviceId="device" sessionId="conversation" busy={false} />);
  await click('[data-testid="agent-watch-options-open"]');
  const sheet = '[data-testid="agent-watch-options"]';
  const atRoot = () => q(`${sheet} .gg-aw-summary-group`) != null;
  const choice = (dimension: string, id: string) => `${sheet} [data-testid="agent-watch-option-choice"][data-dimension="${dimension}"][data-option-id="${id}"]`;
  const summary = (dimension: string) => q(`${sheet} [data-testid="agent-watch-options-drill"][data-dimension="${dimension}"] .gg-aw-summary-value`)?.textContent;
  await until('the sheet opens on the model page (the root)', () => atRoot() && q(choice('model', 'model-1')) != null);

  await click(choice('model', 'model-2'));
  await until('the machine took model-2 and the tick moved', () => q(choice('model', 'model-2'))?.getAttribute('aria-checked') === 'true');
  expect(q(sheet), 'the sheet is still open').toBeTruthy();
  expect(atRoot(), 'still on the root page').toBe(true);

  await click(`${sheet} [data-testid="agent-watch-options-drill"][data-dimension="mode"]`);
  await until('the mode page', () => !atRoot());
  await click(choice('mode', 'plan'));
  await until('back on the root page after the mode was set', atRoot);
  expect(summary('mode')).toBe('plan');

  const sets = machine.sets;
  await click(`${sheet} [data-testid="agent-watch-options-drill"][data-dimension="effort"]`);
  await until('the effort page', () => !atRoot());
  await click(choice('effort', 'low'));
  await until('a re-pick of the current value goes back to the root page', atRoot);
  expect(machine.sets, 'a re-pick sends nothing').toBe(sets);

  machine.failNext = true;
  await click(`${sheet} [data-testid="agent-watch-options-drill"][data-dimension="effort"]`);
  await until('the effort page', () => !atRoot());
  await click(choice('effort', 'high'));
  await until('the refusal is written in the sheet', () => q(`${sheet} [data-testid="agent-watch-options-error"]`) != null);
  expect(atRoot(), 'a refused pick stays on its page').toBe(false);
  expect(q(choice('effort', 'low'))?.getAttribute('aria-checked'), 'the shown value is still the machine\'s').toBe('true');

  await click('[data-testid="agent-watch-options-nav"]');
  await until('← goes back to the root page', atRoot);
  await click('[data-testid="agent-watch-options-nav"]');
  await until('✕ closes the sheet', () => q(sheet) == null);
});

// 复核 #6972 F1:选完模型、不等机器回话就点 ✕ —— 抽屉关了;机器回话后它不该自己再弹开。
// 判据等事实:胶囊上的文字换成 model-2,说明回话已经提交(setOptions 与 setView 在同一个 .then 里),再看抽屉。
it('session options: a sheet closed while a pick is in flight stays closed when the machine answers', async () => {
  machine.hold = true;
  mount(<SessionOptionsPill deviceId="device" sessionId="conversation" busy={false} />);
  const pill = '[data-testid="agent-watch-options-open"]';
  const sheet = '[data-testid="agent-watch-options"]';
  const choice = `${sheet} [data-testid="agent-watch-option-choice"][data-dimension="model"][data-option-id="model-2"]`;
  await click(pill);
  await click(choice);
  await until('the pick is in flight', () => machine.release != null && q('[data-testid="agent-watch-options-pending"]') != null);
  await click('[data-testid="agent-watch-options-nav"]');
  await until('✕ closed the sheet', () => q(sheet) == null);
  machine.release!();
  await until('the machine answered (the pill now reads model-2)', () => q(pill)?.textContent?.includes('model-2') === true);
  expect(q(sheet), 'the sheet the person closed stays closed').toBeNull();
});


it('only offers manual modes when the selected host enables Terminal, without changing the default', async () => {
  mount(<CreatePage />);
  await click('[data-testid="agent-watch-create-options-open"]');
  const drill = '[data-testid="agent-watch-create-options-drill"][data-dimension="view"]';
  await until('root options open', () => q('.gg-aw-summary-group') !== null);
  expect(q(drill)).toBeNull();
  root!.render(<CreatePage terminalEnabled />);
  await until('host setting exposes manual mode', () => q(drill) !== null);
  await click(drill);
  expect(q('[data-dimension="view"][data-option-id="general"]')?.getAttribute('aria-checked')).toBe('true');
  await click('[data-dimension="view"][data-option-id="code"]');
  await until('the selected mode is shown on the root', () => q(drill) !== null);
  expect(q(`${drill} .gg-aw-summary-value`)?.textContent).toMatch(/Terminal|终端/);
  root!.render(<CreatePage terminalEnabled={false} />);
  await until('disabling Terminal hides the switch', () => q(drill) === null);
});
