/** @jsxImportSource solid-js */
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../../../../apps/desktop/src/session/renderer/index.css';
import '../../../../packages/session-ui/src/styles/tokens.css';
import { nativeChatAppearance } from '../../../../apps/desktop/src/session/renderer/lib/chat/native-chat-appearance.css';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { ChatCommands } from '@session-chat/commands';
import type { ChatLayout } from '@session-chat/core/layout/preset';
import { turnProcessUnitDef } from '@session-chat/components/rows/turn-process/turn-process.def';
import { backgroundTasksUnitDef } from '@session-chat/components/rows/background-tasks/background-tasks.def';
import type { TranscriptTurn } from '@session-chat/model';
import { zhCNMessages, type SessionMessageKey } from '../../../../apps/desktop/src/session/renderer/localization/messages';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).forEach(fn => fn()); delete document.documentElement.dataset.theme; });
const capturePhase = import.meta.env.VITE_ALIGNMENT_CAPTURE_PHASE;
const scheduled = `<gugu_delivery route="scheduled" from="咕咕系统" from_id="system:gugu" schedule="三图 + 合并账 每小时整点更新 + 任务对账" msg="msg:scheduled"><![CDATA[整点更新看板、对任务账（总主管的职责）。每小时出一次，别漏任务。

1. 先对账：把这一小时里收到的每条主管回报逐条对应到现有任务。
2. 更新看板：核对负责人、进度、下一步和截止时间。]]></gugu_delivery>`;
const incoming = `<gugu_delivery route="chat" from="云端与后端主管（Claude）" from_id="user:cloud-lead" chat="test" chat_kind="group" msg="msg:incoming"><![CDATA[预发云电脑控制器已恢复，三个服务均正常。窗口里的验证按约进行；完成后先清理专用测试宿主和会话，再交验收原件。]]></gugu_delivery>`;

function mount(width: number, mode: string, layout: ChatLayout = { preset: 'double', userGutter: 0, agentConversation: true }, finalText = '[NO_REPLY]', commands: ChatCommands = {}) {
  const host = document.createElement('div');
  host.className = `${mode === 'dark' ? 'emdark' : 'emlight'} ${nativeChatAppearance}`;
  document.documentElement.dataset.theme = mode;
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:1000px;background:var(--chat-bg);color:var(--chat-fg)`;
  document.body.append(host);
  const context = createChatContext({ locale: () => 'zh-CN', translator: (key, values) => {
    let value = zhCNMessages[key as SessionMessageKey];
    if (value === undefined) throw new Error(`Missing real translation: ${key}`);
    for (const [name, replacement] of Object.entries(values ?? {})) value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  } });
  context.setLayout(layout);
  const state = createChatState(context);
  const transcript = document.createElement('div');
  transcript.style.cssText = 'width:100%;height:1000px';
  host.append(transcript);
  const view = createChatView({ context, state, parent: transcript, padTop: 32, padBottom: 0, commands: { conversationAgentName: () => '咕咕总主管（Claude）', ...commands } });
  // Shape from the owner's target turn: one user-initiated turn receives a
  // scheduled delivery, completes a tool, then receives a chat delivery and
  // ends with explicit silence. All content/identifiers below are test data.
  state.transcript.history.seed([{
    id: 'owner-shape', seq: 579, initiator: 'user',
    startedAt: 1793811601067, endedAt: 1793811624216,
    outcome: { kind: 'done', reason: 'end_turn' },
    items: [
      { kind: 'message', id: 'scheduled-input', seq: 1, role: 'user', at: 1793811602424, text: scheduled },
      { kind: 'unknown-tool-call', id: 'tool', toolCallId: 'tool', seq: 2, at: 1793811609816,
        completedAt: 1793811622250, status: 'done', name: 'read-only probe', title: '结构复现', toolName: 'read-only probe', outputText: '测试工具结果' },
      { kind: 'message', id: 'incoming-input', seq: 3, role: 'user', at: 1793811616516, text: incoming },
      { kind: 'message', id: 'silent', seq: 4, role: 'assistant', at: 1793811624086, text: finalText },
    ],
  } as TranscriptTurn]);
  const backgroundState = state;
  state.session.setBackgroundTasks({ commands: [], subagents: [{ id: 'child', launchToolCallId: 'child-call', name: '核对验收原件', completedSteps: 0, calls: [], elapsedMs: 0, startedAt: 1793811601067, canCancel: true }] });
  dispose.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  return { host, transcript, context, state, backgroundState };
}

it.each([{ width: 1440, mode: 'light' }, { width: 1440, mode: 'dark' }, { width: 480, mode: 'light' }, { width: 480, mode: 'dark' }])('aligns delivery and background metadata at $width in $mode', async ({ width, mode }) => {
  await page.viewport(width, 1000);
  const { host } = mount(width, mode);
  const header = () => host.querySelector<HTMLElement>('[data-scheduled-prompt] [data-slot="semantic-disclosure"]');
  const background = () => host.querySelector<HTMLElement>('[data-slot="background-tasks"] [data-slot="collapse-header"]') ?? host.querySelector<HTMLElement>('[data-slot="background-tasks-pill"]');
  await until('real scheduled header and background control mount', () => !!header() && !!background());
  await untilStable('real transcript geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  await document.fonts.ready;
  await untilStable('two real transcript columns settle', () => host.querySelector('[data-slot=background-tasks]')?.getBoundingClientRect().top);
  const scheduledCard = header()!.closest('[data-scheduled-prompt]')!;
  const source = header()!.lastElementChild!;
  const lastFact = source.lastElementChild!;
  const strip = background()!;
  const silent = [...host.querySelectorAll<HTMLElement>('[data-slot="turn-process"]')].at(-1)!.lastElementChild as HTMLElement;
  const label = strip.querySelector<HTMLElement>('[data-shimmer]') ?? strip.firstElementChild as HTMLElement;
  const reading = {
    phase: capturePhase ?? 'test', width, mode,
    headerRight: lastFact.getBoundingClientRect().right,
    headerContainerRight: header()!.getBoundingClientRect().right,
    summaryCenter: (source.getBoundingClientRect().left + source.getBoundingClientRect().right) / 2,
    rowCenter: (header()!.getBoundingClientRect().left + header()!.getBoundingClientRect().right) / 2,
    stripLeft: strip.getBoundingClientRect().left,
    stripLabelLeft: label.getBoundingClientRect().left,
    bodyLeft: silent.getBoundingClientRect().left,
    headerJustify: getComputedStyle(source).justifyContent,
    backgroundInset: strip.closest<HTMLElement>('[data-row-kind]')?.dataset.rowInset,
    silentText: silent.textContent,
    font: getComputedStyle(strip).fontFamily,
  };
  if (capturePhase) {
    console.log(`ALIGNMENT_READING ${JSON.stringify(reading)}`);
    await page.screenshot({ element: host, path: `__screenshots__/alignment-${capturePhase}-${mode}-${width}.png` });
  }
  expect(scheduledCard.querySelector('[data-user-card]')).toBeNull();
  expect(scheduledCard.textContent).toBe('定时任务：三图 + 合并账 每小时整点更新 + 任务对账');
  expect(Math.abs(reading.summaryCenter - reading.rowCenter)).toBeLessThanOrEqual(1);
  expect(Math.abs(reading.stripLeft - reading.bodyLeft)).toBeLessThanOrEqual(1);
});

it('keeps the scheduled prompt and standalone roster expandable after alignment', async () => {
  await page.viewport(480, 1000);
  const { host } = mount(480, 'light');
  const card = () => host.querySelector<HTMLElement>('[data-scheduled-prompt]');
  const background = () => host.querySelector<HTMLElement>('[data-slot="background-tasks"]');
  await until('source and standalone roster mount', () => !!card() && !!background());
  card()!.querySelector<HTMLButtonElement>('button[data-collapse-id]')!.click();
  await until('scheduled original prompt opens', () => card()!.textContent!.includes('1. 先对账'));
  card()!.querySelector<HTMLButtonElement>('button[data-collapse-id]')!.click();
  await until('scheduled original prompt closes', () => !card()!.textContent!.includes('1. 先对账'));
  background()!.querySelector<HTMLElement>('[data-collapse-id]')!.click();
  await until('standalone roster opens', () => !!background()!.querySelector('[data-slot="background-task"]'));
  expect(background()!.textContent).toContain('核对验收原件');
  background()!.querySelector<HTMLElement>('[data-collapse-id]')!.click();
  await until('standalone roster closes', () => !background()!.querySelector('[data-slot="background-task"]'));
});

it('folds only the scheduled part of a mixed delivery batch', async () => {
  const { host, state } = mount(390, 'light');
  state.transcript.history.seed([{ id: 'mixed', seq: 1, initiator: 'user', trigger: { kind: 'owner' },
    outcome: { kind: 'done' }, items: [{ kind: 'message', id: 'mixed-input', seq: 0, role: 'user',
      text: `${scheduled}\n${incoming}`, _meta: { guguOwnerInput: false } }] }]);
  await until('mixed scheduled disclosure mounts', () => !!host.querySelector('[data-scheduled-prompt]'));
  const card = () => host.querySelector<HTMLElement>('[data-scheduled-prompt]')!;
  expect(card().textContent).toBe('定时任务：三图 + 合并账 每小时整点更新 + 任务对账');
  expect(host.textContent).toContain('预发云电脑控制器已恢复');
  expect(host.textContent).not.toContain('1. 先对账');
  card().querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
  await until('one mixed prompt expands', () => card().textContent!.includes('1. 先对账'));
  expect(card().textContent).not.toContain('预发云电脑控制器已恢复');
});

it('uses a generic schedule label when authentic older metadata has no title', async () => {
  const { host, state } = mount(390, 'dark');
  state.transcript.history.seed([{ id: 'old-schedule', seq: 1, initiator: 'user', outcome: { kind: 'done' },
    items: [{ kind: 'message', id: 'old-input', seq: 0, role: 'user', text: scheduled.replace(/ schedule="[^"]*"/, '') }] }]);
  await until('untitled scheduled disclosure mounts', () => !!host.querySelector('[data-scheduled-prompt]'));
  expect(host.querySelector('[data-scheduled-prompt]')!.textContent).toBe('定时任务');
});

it.each([{ width: 1440, mode: 'light' }, { width: 1440, mode: 'dark' }, { width: 480, mode: 'light' }, { width: 480, mode: 'dark' }])('keeps single full-width source metadata at its original edge at $width in $mode', async ({ width, mode }) => {
  await page.viewport(width, 1000);
  const { host } = mount(width, mode, { preset: 'single', userGutter: 0 });
  const card = () => host.querySelector<HTMLElement>('[data-delivery-route="scheduled"]');
  await until('single full-width delivery mounts', () => !!card()?.querySelector('[data-slot="delivery-avatar"]'));
  const source = card()!.querySelector<HTMLElement>('[data-slot="delivery-header"]')!;
  const avatar = source.querySelector<HTMLElement>('[data-slot="delivery-avatar"]')!;
  const bubble = card()!.querySelector<HTMLElement>('[data-user-card]')!;
  await untilStable('single source position settles', () => avatar.getBoundingClientRect().left);
  const reading = {
    phase: capturePhase ?? 'test', width, mode, layout: 'single',
    avatarLeft: avatar.getBoundingClientRect().left,
    senderLeft: source.querySelector('[data-slot="delivery-sender"]')!.getBoundingClientRect().left,
    routeLeft: source.querySelector('[data-slot="delivery-route"]')!.getBoundingClientRect().left,
    sourceRight: source.firstElementChild!.lastElementChild!.getBoundingClientRect().right,
    headerLeft: source.getBoundingClientRect().left,
    bubbleLeft: bubble.getBoundingClientRect().left,
    bubbleRight: bubble.getBoundingClientRect().right,
  };
  if (capturePhase) {
    console.log(`SINGLE_ALIGNMENT_READING ${JSON.stringify(reading)}`);
    await page.screenshot({ element: host, path: `__screenshots__/alignment-${capturePhase}-single-${mode}-${width}.png` });
  }
  expect(bubble.getBoundingClientRect().width).toBeGreaterThan(100);
  expect(Math.abs(reading.avatarLeft - reading.headerLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(reading.avatarLeft - reading.bubbleLeft)).toBeLessThanOrEqual(1);
});

it('retains the traditional transcript inset and attached process controls', async () => {
  await page.viewport(1440, 1000);
  const { host, transcript, state, context } = mount(1440, 'light', { preset: 'double', userGutter: 0, agentConversation: true }, '任务已完成，核对记录保留。');
  state.session.setBackgroundTasks({ commands: [{ id: 'command', launchToolCallId: 'launch', taskId: 'task', name: 'pnpm test' }], subagents: [] });
  await until('background remains attached to the conversation process', () => !!transcript.querySelector('[data-slot="background-tasks-pill"]'));
  expect(transcript.querySelector('[data-slot="background-tasks"]')).toBeNull();
  context.setLayout({ preset: 'single', userGutter: 0 });
  await until('traditional standalone row restores the tool inset', () => host.querySelector<HTMLElement>('[data-slot="background-tasks"]')?.closest<HTMLElement>('[data-row-kind]')?.dataset.rowInset === '16');
});


function textBox(element: HTMLElement, contains?: string) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.textContent?.trim() || (contains && !node.textContent.includes(contains))) continue;
    const parent = node.parentElement;
    if (parent?.closest('[aria-hidden="true"]')) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width) return { top: box.top, bottom: box.bottom, center: (box.top + box.bottom) / 2, height: box.height };
  }
  throw new Error('Missing visible text geometry');
}

it.each([{ width: 1440, mode: 'light' }, { width: 1440, mode: 'dark' }, { width: 480, mode: 'light' }, { width: 480, mode: 'dark' }])('keeps the silent turn background at the sibling seam at $width in $mode', async ({ width, mode }) => {
  await page.viewport(width, 1000);
  const { host } = mount(width, mode);
  await until('owner-shaped silent turn and standalone background mount', () => !!host.querySelector('[data-slot="background-tasks"]') && !!host.querySelector('[data-slot="turn-process"]'));
  await untilStable('owner-shaped root settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  await document.fonts.ready;
  const process = [...host.querySelectorAll<HTMLElement>('[data-slot="turn-process"]')].at(-1)!;
  const silent = process.lastElementChild as HTMLElement;
  const strip = host.querySelector<HTMLElement>('[data-slot="background-tasks"]')!;
  const silentText = textBox(silent, '不回话');
  const stripText = textBox(strip, '后台');
  const siblingGap = Math.max(turnProcessUnitDef.margin?.bottom ?? 0, backgroundTasksUnitDef.margin?.top ?? 0);
  const reading = { phase: capturePhase ?? 'test', width, mode, roots: host.querySelectorAll('[data-chat-root]').length,
    sequence: [...host.querySelectorAll<HTMLElement>('[data-row-kind]')].map(row => row.dataset.rowKind),
    silentText, stripText, textCenterDistance: stripText.center - silentText.center,
    silentBottom: silent.getBoundingClientRect().bottom, stripTop: strip.getBoundingClientRect().top,
    emptySpace: strip.getBoundingClientRect().top - silent.getBoundingClientRect().bottom, siblingGap,
    completionHeight: host.querySelector('[data-slot="turn-completion"]')?.getBoundingClientRect().height ?? 0,
  };
  console.log(`SILENT_GAP_READING ${JSON.stringify(reading)}`);
  if (capturePhase) await page.screenshot({ element: host, path: `__screenshots__/gap-${capturePhase}-${mode}-${width}.png` });
  const copy = silent.querySelector<HTMLElement>('[data-slot="message-copy"]');
  if (copy) {
    const originalTop = strip.getBoundingClientRect().top;
    await userEvent.hover(silent);
    await until('inline copy appears without changing geometry', () => getComputedStyle(copy.parentElement!).opacity === '1');
    expect(strip.getBoundingClientRect().top).toBe(originalTop);
    expect(silent.getBoundingClientRect().height).toBe(22);
    console.log(`SILENT_HOVER_READING ${JSON.stringify({ width, mode, silentHeight: silent.getBoundingClientRect().height, stripTop: strip.getBoundingClientRect().top, originalTop })}`);
    if (capturePhase) await page.screenshot({ element: host, path: `__screenshots__/gap-${capturePhase}-hover-${mode}-${width}.png` });
    await userEvent.hover(document.body);
  }

  expect(reading.roots).toBe(1);
  expect(reading.emptySpace).toBe(siblingGap);
});

it.each([{ width: 1440, mode: 'light' }, { width: 1440, mode: 'dark' }, { width: 480, mode: 'light' }, { width: 480, mode: 'dark' }])('preserves a normal reply footer in the same root at $width in $mode', async ({ width, mode }) => {
  await page.viewport(width, 1000);
  const { host } = mount(width, mode, { preset: 'double', userGutter: 0, agentConversation: true }, '任务已完成，核对记录保留。');
  await until('normal visible reply and its footer mount', () => !!host.querySelector('[data-agent-conversation-message="silent"] [data-user-message-actions]'));
  await untilStable('normal reply root settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  const reply = host.querySelector<HTMLElement>('[data-agent-conversation-message="silent"]')!;
  const footer = reply.querySelector<HTMLElement>('[data-user-message-actions]')!;
  const reading = { phase: capturePhase ?? 'test', width, mode, roots: host.querySelectorAll('[data-chat-root]').length,
    replyTop: reply.getBoundingClientRect().top, replyBottom: reply.getBoundingClientRect().bottom,
    footerTop: footer.getBoundingClientRect().top, footerBottom: footer.getBoundingClientRect().bottom,
    footerHeight: footer.getBoundingClientRect().height, copies: footer.querySelectorAll('[data-slot="message-copy"]').length,
    completionRows: host.querySelectorAll('[data-slot="turn-completion"]').length,
  };
  console.log(`NORMAL_FOOTER_READING ${JSON.stringify(reading)}`);
  if (capturePhase) await page.screenshot({ element: host, path: `__screenshots__/normal-${capturePhase}-${mode}-${width}.png` });
  expect(reading.roots).toBe(1);
  expect(reading.footerHeight).toBe(20);
  expect(reading.copies).toBe(1);
  expect(reading.completionRows).toBe(0);
});


it('keeps the silent copy available to hover and keyboard without moving any row', async () => {
  await page.viewport(480, 1000);
  const writeClipboardText = vi.fn();
  const { host } = mount(480, 'light', { preset: 'double', userGutter: 0, agentConversation: true }, '[NO_REPLY]', { writeClipboardText });
  await until('inline copy and standalone background mount', () => !!host.querySelector('[data-slot="turn-silence"] [data-slot="message-copy"]') && !!host.querySelector('[data-slot="background-tasks"]'));
  const line = host.querySelector<HTMLElement>('[data-slot="turn-silence"]')!;
  const button = line.querySelector<HTMLButtonElement>('[data-slot="message-copy"]')!;
  const actions = button.parentElement!;
  const background = host.querySelector<HTMLElement>('[data-slot="background-tasks"]')!;
  const geometry = () => ({ height: line.getBoundingClientRect().height, backgroundTop: background.getBoundingClientRect().top });
  const resting = geometry();
  await userEvent.hover(document.body);
  expect(getComputedStyle(actions).opacity).toBe('0');
  await userEvent.hover(line);
  await until('the actual copy control is revealed by hover', () => getComputedStyle(actions).opacity === '1');
  expect(geometry()).toEqual(resting);
  if (capturePhase) await page.screenshot({ element: host, path: `__screenshots__/gap-${capturePhase}-hover-light-480.png` });
  await userEvent.hover(document.body);
  for (let i = 0; i < 30 && document.activeElement !== button; i++) await userEvent.tab();
  expect(document.activeElement).toBe(button);
  await until('keyboard focus reveals the same control', () => getComputedStyle(actions).opacity === '1');
  expect(geometry()).toEqual(resting);
  await userEvent.keyboard('{Enter}');
  await until('keyboard copy uses the real clipboard command', () => writeClipboardText.mock.calls.length === 1);
  expect(writeClipboardText).toHaveBeenCalledWith('结构复现\n测试工具结果');
  console.log(`SILENT_INTERACTION_READING ${JSON.stringify({ resting, hover: geometry(), focus: document.activeElement === button, copied: writeClipboardText.mock.calls[0][0] })}`);
});

it.each([{ width: 1440, mode: 'light' }, { width: 1440, mode: 'dark' }, { width: 480, mode: 'light' }, { width: 480, mode: 'dark' }])('preserves ordinary tool-only completion without explicit silence at $width in $mode', async ({ width, mode }) => {
  await page.viewport(width, 1000);
  const { host } = mount(width, mode, { preset: 'double', userGutter: 0, agentConversation: true }, '');
  await until('ordinary tool completion mounts', () => !!host.querySelector('[data-slot="turn-completion"]'));
  const completion = host.querySelector<HTMLElement>('[data-slot="turn-completion"]')!;
  expect(completion.getBoundingClientRect().height).toBe(20);
  expect(completion.querySelectorAll('[data-slot="message-copy"]')).toHaveLength(1);
  expect(host.querySelector('[data-slot="turn-silence"]')).toBeNull();
  console.log(`ORDINARY_COMPLETION_READING ${JSON.stringify({ phase: capturePhase ?? 'test', width, mode, top: completion.getBoundingClientRect().top, height: completion.getBoundingClientRect().height })}`);
  if (capturePhase) await page.screenshot({ element: host, path: `__screenshots__/ordinary-${capturePhase}-${mode}-${width}.png` });
});
