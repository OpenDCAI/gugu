/**
 * owner 10-07:「新建 task 选属性的时候,比如换一个模型或者换一个 thinking level,我发现只要一选,整个……pop-up menu
 * 就直接没了。这是不对的,应该是我调完一个设置后还可以继续调另一个」。新建页的选项胶囊:
 *   · 在下钻页选 → 回顶层,抽屉还在,摘要行上是刚改的值,接着点下一项;
 *   · 在顶层选 → 留在顶层、勾移过去;
 *   · 关只靠 ✕。
 * 手机视口、真 Chromium、真组件。
 */
import { createRoot, type Root } from 'react-dom/client';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { CreateOptionsPill } from '@/mobile/agent-watch/CreateOptionsPill';
import type { CreateSelection } from '@/mobile/agent-watch/create-session-form';
import '@/i18n';
import '@/styles/tokens.css';
import '@/mobile/agent-watch/agent-watch.css';

let root: Root | null = null;
beforeEach(() => page.viewport(412, 842));
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
function CreatePage() {
  const [selection, setSelection] = useState<CreateSelection>({ projectId: 'p1', harness: 'codex', model: null, permissionMode: null, effort: null });
  return <CreateOptionsPill options={OPTIONS} selection={selection} onChange={setSelection} busy={false} models={MODELS} modelsState="ready" />;
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
