/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { CONVERSATION_PREVIEW_MAX_H } from '@session-chat/components/engine/row-metrics';
import { createChatState } from '@session-chat/state/chat-state';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const dispose: (() => void)[] = [];
afterEach(() => dispose.splice(0).forEach(fn => fn()));
function mount() {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:800px';
  document.body.append(host);
  let view = createChatView({ context, state, parent: host });
  dispose.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const record = (parts: number, longReply = false) => ({ id: 'scroll', seq: 0, initiator: 'user',
    items: Array.from({ length: parts + 2 }, (_, i) => ({ kind: 'message', id: `say-${i}`, seq: i,
      role: i === 0 ? 'user' : 'assistant', text: longReply && i === parts + 1 ? 'Long reply paragraph for the shared preview cap.\n\n'.repeat(60) : `${i === 1 ? 'needle-first ' : ''}Visible process part ${i}` } as ChatMessage)),
  } as TranscriptTurn);
  const set = (parts: number, longReply = false) => state.transcript.activeTurn.set(record(parts, longReply));
  const complete = (parts: number, longReply = false, fillers = 0) => {
    state.transcript.activeTurn.set(null);
    state.transcript.history.seed([{ ...record(parts, longReply), outcome: { kind: 'done' } }, ...Array.from({ length: fillers }, (_, i) => ({
      id: `filler-${i}`, seq: i + 1, initiator: 'user', outcome: { kind: 'done' }, items: [
        { kind: 'message', id: `fq-${i}`, seq: 0, role: 'user', text: `Question ${i}` },
        { kind: 'message', id: `fa-${i}`, seq: 1, role: 'assistant', text: `Answer ${i}` },
      ],
    } as TranscriptTurn))]);
  };
  const open = () => state.viewState.setCollapsed('scroll:process', true);
  return { complete, open, bottom: () => view.scrollToBottom(), host, set, state, find: (text: string) => view.find(text), scrollTo: (id: string) => view.scrollToItem(id), remount: () => {
    view.dispose(); view = createChatView({ context, state, parent: host });
  } };
}

describe('running process native scrolling', () => {
  it('caps the process, keeps all rows, follows only near the bottom and fades the scrolled top', async () => {
    const { host, set } = mount();
    set(12);
    await until('the latest bubble renders', () => !!host.querySelector('[data-agent-conversation-message="say-13"]'));
    await untilStable('transcript geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
    const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    expect(viewport).not.toBeNull();
    expect(viewport!.clientHeight).toBe(CONVERSATION_PREVIEW_MAX_H);
    expect(viewport!.scrollHeight).toBeGreaterThan(viewport!.clientHeight);
    expect(viewport!.querySelectorAll('[data-conversation-narration]')).toHaveLength(12);
    expect(host.textContent).not.toMatch(/earlier parts|前面还有/);
    await until('starts at latest step', () => viewport!.scrollHeight - viewport!.scrollTop - viewport!.clientHeight < 1);
    expect(getComputedStyle(viewport!).scrollbarWidth).toBe('none');
    expect(getComputedStyle(viewport!, '::-webkit-scrollbar').width).toBe('0px');
    const fade = host.querySelector<HTMLElement>('[data-slot="conversation-process-top-fade"]')!;
    expect(fade).not.toBeNull();
    expect(getComputedStyle(fade).pointerEvents).toBe('none');
    expect(getComputedStyle(fade).backgroundImage).toContain('linear-gradient');
    expect(getComputedStyle(fade).opacity).toBe('1');
    viewport!.scrollTop = 32;
    viewport!.dispatchEvent(new Event('scroll'));
    set(14);
    await until('new step is present without moving reader', () => !!viewport!.querySelector('[data-conversation-narration="say-14"]'));
    await untilStable('preserved scroll offset', () => viewport!.scrollTop);
    expect(viewport!.scrollTop).toBe(32);
    viewport!.scrollTop = viewport!.scrollHeight;
    viewport!.dispatchEvent(new Event('scroll'));
    set(16);
    await until('follows appended steps at bottom', () => !!viewport!.querySelector('[data-conversation-narration="say-16"]') && viewport!.scrollHeight - viewport!.scrollTop - viewport!.clientHeight < 1);
  });

  it('uses content height for a short process', async () => {
    const { host, set } = mount();
    set(1);
    await until('the latest bubble renders', () => !!host.querySelector('[data-agent-conversation-message="say-2"]'));
    const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    expect(viewport).not.toBeNull();
    expect(viewport!.clientHeight).toBe(32);
  });
  it('keeps the reader position when the virtual view remounts and reveals a targeted inner step', async () => {
    const { host, set, remount, scrollTo, state } = mount();
    set(20);
    const viewport = () => host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    await until('viewport is mounted at tail', () => !!viewport() && viewport()!.scrollTop > 0);
    viewport()!.scrollTop = 64;
    viewport()!.dispatchEvent(new Event('scroll'));
    expect(state.parseCaches.processScrollPositions.get('scroll:process:steps:live')).toMatchObject({ top: 64, atEnd: false });
    remount();
    expect(state.parseCaches.processScrollPositions.get('scroll:process:steps:live')).toMatchObject({ top: 64, atEnd: false });
    await until('remounted viewport appears', () => !!viewport());
    await untilStable('remounted reader position settles', () => viewport()?.scrollTop);
    expect(viewport()!.scrollTop).toBe(64);
    scrollTo('say-1');
    await untilStable('navigation settles', () => viewport()?.scrollTop);
    expect(viewport()!.scrollTop).toBe(0);
    expect(getComputedStyle(host.querySelector<HTMLElement>('[data-slot="conversation-process-top-fade"]')!).opacity).toBe('0');
  });

  it('follows within 24px but preserves the position at that boundary', async () => {
    const { host, set } = mount();
    set(12);
    const viewport = () => host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    await until('viewport starts at tail', () => !!viewport() && viewport()!.scrollTop > 0);
    const el = viewport()!;
    el.scrollTop = el.scrollHeight - el.clientHeight - 24;
    el.dispatchEvent(new Event('scroll'));
    const before = el.scrollTop;
    set(13);
    await until('new process step arrives', () => !!el.querySelector('[data-conversation-narration="say-13"]'));
    await untilStable('24px boundary keeps its offset', () => el.scrollTop);
    expect(el.scrollTop).toBe(before);
    el.scrollTop = el.scrollHeight - el.clientHeight - 23;
    el.dispatchEvent(new Event('scroll'));
    set(14);
    await until('inside threshold follows the new tail', () => !!el.querySelector('[data-conversation-narration="say-14"]') && el.scrollHeight - el.scrollTop - el.clientHeight < 1);
  });

  it('bounds the process while keeping the latest long bubble full and the row measurement exact', async () => {
    const { host, set } = mount();
    set(14, true);
    await until('long reply is present', () => !!host.querySelector('[data-user-card="say-15"]'));
    const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]')!;
    const bubble = host.querySelector<HTMLElement>('[data-agent-conversation-message="say-15"] [data-user-card]')!;
    expect(CONVERSATION_PREVIEW_MAX_H).toBe(252);
    expect(bubble.offsetHeight).toBeGreaterThan(CONVERSATION_PREVIEW_MAX_H);
    expect(host.querySelector('[data-expand-user-card="say-15"]')).toBeNull();
    expect(viewport.clientHeight).toBe(CONVERSATION_PREVIEW_MAX_H);
    const row = viewport.closest<HTMLElement>('[data-row-kind="conversation-process-steps"]')!;
    expect(row.offsetHeight).toBe(viewport.clientHeight + parseFloat(getComputedStyle(row).paddingTop));
  });

  it('find reveals a match above the independently scrolled process viewport', async () => {
    const { host, set, find } = mount();
    set(20);
    const viewport = () => host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    await until('viewport starts at tail', () => !!viewport() && viewport()!.scrollTop > 0);
    expect(find('needle-first').total).toBe(1);
    const highlighted = () => (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gugu-chat-find')?.values().next().value;
    await until('find paints its matched text', () => !!highlighted());
    await untilStable('find scroll settles', () => [viewport()!.scrollTop, highlighted()?.getBoundingClientRect().top]);
    const hit = highlighted()!.getBoundingClientRect();
    const box = viewport()!.getBoundingClientRect();
    expect(hit.top).toBeGreaterThanOrEqual(box.top);
    expect(hit.bottom).toBeLessThanOrEqual(box.bottom);
  });

  it('opens a completed process at the top with the same bounded viewport and no tail following', async () => {
    const { host, complete, open } = mount();
    complete(14, true, 1);
    await until('the completed reply renders', () => !!host.querySelector('[data-expand-user-card]'));
    expect(host.querySelector('[data-slot="conversation-process-steps"]')).toBeNull();
    open();
    await untilStable('completed process expands', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
    const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    expect(viewport).not.toBeNull();
    expect(viewport!.clientHeight).toBe(CONVERSATION_PREVIEW_MAX_H);
    expect(viewport!.scrollTop).toBe(0);
    expect(getComputedStyle(viewport!).scrollbarWidth).toBe('none');
    const fade = () => host.querySelector<HTMLElement>('[data-slot="conversation-process-top-fade"]')!;
    expect(getComputedStyle(fade()).opacity).toBe('0');
    viewport!.scrollTop = viewport!.scrollHeight;
    viewport!.dispatchEvent(new Event('scroll'));
    const before = viewport!.scrollTop;
    expect(getComputedStyle(fade()).opacity).toBe('1');
    complete(20, true, 1);
    await until('completed replay updates all steps', () => !!viewport!.querySelector('[data-conversation-narration="say-20"]'));
    await untilStable('completed reader offset settles', () => viewport!.scrollTop);
    expect(viewport!.scrollTop).toBe(before);
  });

  it('starts completed viewing at the top after a live process was at its tail', async () => {
    const { host, set, complete, open } = mount();
    set(14);
    const viewport = () => host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]');
    await until('live viewport is following its tail', () => !!viewport() && viewport()!.scrollTop > 0);
    complete(14);
    await until('completed process defaults closed', () => viewport() === null);
    open();
    await untilStable('completed process opens', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
    expect(viewport()).not.toBeNull();
    expect(viewport()!.scrollTop).toBe(0);
  });

  it('find locates a completed process leaf outside the outer virtual viewport', async () => {
    const { host, complete, find, bottom } = mount();
    complete(20, false, 35);
    await until('later history renders', () => !!host.querySelector('[data-agent-conversation-message="fa-34"]'));
    bottom();
    await untilStable('history is at its tail', () => host.querySelector<HTMLElement>('[data-chat-scroll]')?.scrollTop);
    expect(host.querySelector('[data-item-id="say-1"]')).toBeNull();
    expect(find('needle-first').total).toBe(1);
    const highlighted = () => (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights.get('gugu-chat-find')?.values().next().value;
    await until('completed nested match is highlighted', () => !!highlighted());
    await untilStable('completed find scroll settles', () => highlighted()?.getBoundingClientRect().top);
    const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]')!;
    const hit = highlighted()!.getBoundingClientRect();
    expect(hit.top).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
    expect(hit.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
    expect(hit.top).toBeGreaterThanOrEqual(host.getBoundingClientRect().top);
    expect(hit.bottom).toBeLessThanOrEqual(host.getBoundingClientRect().bottom);
  });

});
