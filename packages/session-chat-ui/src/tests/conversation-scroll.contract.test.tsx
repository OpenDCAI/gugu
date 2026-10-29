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
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:800px';
  document.body.append(host);
  let view = createChatView({ context, state, parent: host });
  dispose.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const set = (parts: number, longReply = false) => state.transcript.activeTurn.set({ id: 'scroll', seq: 0, initiator: 'user',
    items: Array.from({ length: parts + 2 }, (_, i) => ({ kind: 'message', id: `say-${i}`, seq: i,
      role: i === 0 ? 'user' : 'assistant', text: longReply && i === parts + 1 ? 'Long reply paragraph for the shared preview cap.\n\n'.repeat(60) : `${i === 1 ? 'needle-first ' : ''}Visible process part ${i}` } as ChatMessage)),
  } as TranscriptTurn);
  return { host, set, state, find: (text: string) => view.find(text), scrollTo: (id: string) => view.scrollToItem(id), remount: () => {
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
    expect(state.parseCaches.processScrollPositions.get('scroll:process:steps')).toMatchObject({ top: 64, atEnd: false });
    remount();
    expect(state.parseCaches.processScrollPositions.get('scroll:process:steps')).toMatchObject({ top: 64, atEnd: false });
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

  it('matches the collapsed long bubble height and keeps the exact row measurement', async () => {
    const { host, set } = mount();
    set(14, true);
    await until('long reply is visible', () => !!host.querySelector('[data-expand-user-card]'));
    const viewport = host.querySelector<HTMLElement>('[data-slot="conversation-process-steps"]')!;
    const bubble = host.querySelector<HTMLElement>('[data-agent-conversation-message="say-15"] [data-user-card]')!;
    expect(CONVERSATION_PREVIEW_MAX_H).toBe(252);
    expect(viewport.clientHeight).toBe(bubble.offsetHeight);
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

});
