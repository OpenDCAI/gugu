/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../../../../apps/desktop/src/session/renderer/index.css';
import '../../../../packages/session-ui/src/styles/tokens.css';
import { nativeChatAppearance } from '../../../../apps/desktop/src/session/renderer/lib/chat/native-chat-appearance.css';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
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

function mount(width: number, mode: string) {
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
  context.setLayout({ preset: 'double', userGutter: 0, agentConversation: true });
  const state = createChatState(context);
  const transcript = document.createElement('div');
  transcript.style.cssText = 'width:100%;height:500px';
  host.append(transcript);
  const view = createChatView({ context, state, parent: transcript, padTop: 32, padBottom: 0, commands: { conversationAgentName: () => '咕咕总主管（Claude）' } });
  const turn = (id: string, seq: number, text: string): TranscriptTurn => ({
    id, seq, initiator: 'agent', startedAt: 1793808000000 + seq * 20000,
    endedAt: 1793808007000 + seq * 20000, outcome: { kind: 'done', reason: 'end_turn' },
    items: [
      { kind: 'message', id: `${id}-input`, seq: 0, role: 'user', text },
      { kind: 'message', id: `${id}-silent`, seq: 1, role: 'assistant', text: '[NO_REPLY]' },
    ],
  });
  state.transcript.history.seed([turn('scheduled', 0, scheduled), turn('incoming', 1, incoming)]);
  // A second real ChatRoot exercises the standalone fallback without forcing the
  // first transcript's background-ownership state or copying its row layout.
  const backgroundHost = document.createElement('div');
  backgroundHost.style.cssText = 'width:100%;height:100px';
  host.append(backgroundHost);
  const backgroundState = createChatState(context);
  const backgroundView = createChatView({ context, state: backgroundState, parent: backgroundHost, padTop: 0, padBottom: 0 });
  backgroundState.session.setBackgroundTasks({ commands: [], subagents: [{ id: 'child', launchToolCallId: 'child-call', name: '核对验收原件', completedSteps: 0, calls: [], elapsedMs: 0, startedAt: Date.now(), canCancel: true }] });
  dispose.push(() => { backgroundView.dispose(); backgroundState.dispose(); view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  return { host, transcript, context, state, backgroundState };
}

it.each([{ width: 1440, mode: 'light' }, { width: 1440, mode: 'dark' }, { width: 480, mode: 'light' }, { width: 480, mode: 'dark' }])('aligns delivery and background metadata at $width in $mode', async ({ width, mode }) => {
  await page.viewport(width, 1000);
  const { host, transcript } = mount(width, mode);
  const header = () => host.querySelector<HTMLElement>('[data-delivery-route="scheduled"] [data-slot="delivery-header"]');
  const background = () => host.querySelector<HTMLElement>('[data-slot="background-tasks"] [data-slot="collapse-header"]') ?? host.querySelector<HTMLElement>('[data-slot="background-tasks-pill"]');
  await until('real scheduled header and background control mount', () => !!header() && !!background());
  await untilStable('real transcript geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  await document.fonts.ready;
  transcript.style.height = `${transcript.querySelector<HTMLElement>('[data-chat-canvas]')!.offsetHeight + 32}px`;
  await untilStable('two real transcript columns settle', () => host.querySelector('[data-slot=background-tasks]')?.getBoundingClientRect().top);
  const scheduledCard = header()!.closest('[data-delivery-card]')!;
  const bubble = scheduledCard.querySelector<HTMLElement>('[data-user-card]')!;
  const source = header()!.firstElementChild!;
  const lastFact = source.lastElementChild!;
  const strip = background()!;
  const silent = [...host.querySelectorAll<HTMLElement>('[data-slot="turn-process"]')].at(-1)!.lastElementChild as HTMLElement;
  const label = strip.querySelector<HTMLElement>('[data-shimmer]') ?? strip.firstElementChild as HTMLElement;
  const reading = {
    phase: capturePhase ?? 'test', width, mode,
    headerRight: lastFact.getBoundingClientRect().right,
    headerContainerRight: header()!.getBoundingClientRect().right,
    bubbleRight: bubble.getBoundingClientRect().right,
    stripLeft: strip.getBoundingClientRect().left,
    stripLabelLeft: label.getBoundingClientRect().left,
    bodyLeft: silent.getBoundingClientRect().left,
    headerJustify: getComputedStyle(source).justifyContent,
    backgroundInset: strip.closest<HTMLElement>('[data-row-kind]')?.dataset.rowInset,
    silentText: silent.textContent,
    font: getComputedStyle(strip).fontFamily,
    bubbleBackground: getComputedStyle(bubble).backgroundColor,
  };
  if (capturePhase) {
    console.log(`ALIGNMENT_READING ${JSON.stringify(reading)}`);
    await page.screenshot({ element: host, path: `__screenshots__/alignment-${capturePhase}-${mode}-${width}.png` });
  }
  expect(bubble.getBoundingClientRect().width).toBeGreaterThan(100);
  expect(Math.abs(reading.headerRight - reading.bubbleRight)).toBeLessThanOrEqual(1);
  expect(Math.abs(reading.stripLeft - reading.bodyLeft)).toBeLessThanOrEqual(1);
});

it('keeps the source details and standalone roster expandable after alignment', async () => {
  await page.viewport(480, 1000);
  const { host } = mount(480, 'light');
  const card = () => host.querySelector<HTMLElement>('[data-delivery-route="scheduled"]');
  const background = () => host.querySelector<HTMLElement>('[data-slot="background-tasks"]');
  await until('source and standalone roster mount', () => !!card() && !!background());
  card()!.querySelector<HTMLButtonElement>('button[data-collapse-id]')!.click();
  await until('scheduled source details open', () => !!card()!.querySelector('[data-slot="delivery-facts"]'));
  card()!.querySelector<HTMLButtonElement>('button[data-collapse-id]')!.click();
  await until('scheduled source details close', () => !card()!.querySelector('[data-slot="delivery-facts"]'));
  background()!.querySelector<HTMLElement>('[data-collapse-id]')!.click();
  await until('standalone roster opens', () => !!background()!.querySelector('[data-slot="background-task"]'));
  expect(background()!.textContent).toContain('核对验收原件');
  background()!.querySelector<HTMLElement>('[data-collapse-id]')!.click();
  await until('standalone roster closes', () => !background()!.querySelector('[data-slot="background-task"]'));
});

it('retains the traditional transcript inset and attached process controls', async () => {
  await page.viewport(1440, 1000);
  const { host, transcript, state, context } = mount(1440, 'light');
  state.session.setBackgroundTasks({ commands: [{ id: 'command', launchToolCallId: 'launch', taskId: 'task', name: 'pnpm test' }], subagents: [] });
  await until('background remains attached to the conversation process', () => !!transcript.querySelector('[data-slot="background-tasks-pill"]'));
  expect(transcript.querySelector('[data-slot="background-tasks"]')).toBeNull();
  context.setLayout({ preset: 'single', userGutter: 0 });
  await until('traditional standalone row restores the tool inset', () => host.querySelector<HTMLElement>('[data-slot="background-tasks"]')?.closest<HTMLElement>('[data-row-kind]')?.dataset.rowInset === '16');
});
