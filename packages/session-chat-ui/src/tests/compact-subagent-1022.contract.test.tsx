/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { collectSubagentRoster } from '@session-chat/lib/subagent-roster';
import type { TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const longCommand = `printf '%s\\n' '${'long-command-argument-'.repeat(24)}END1022'`;
const teardown: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (teardown.length) await teardown.pop()!(); });

function recordedTurn(command = longCommand): TranscriptTurn {
  return {
    id: 'parent', seq: 0, initiator: 'user', startedAt: Date.now() - 2000,
    outcome: { kind: 'done' }, items: [
      { kind: 'spawn-subagent-tool-call', id: 'launch', seq: 0, toolCallId: 'launch',
        title: 'Local progress check', name: 'Local progress check', status: 'done',
        background: true, agentStatus: 'running', children: [
          { kind: 'execute-tool-call', id: 'short', seq: 1, toolCallId: 'short', parentToolCallId: 'launch',
            title: 'echo short', command: 'echo short', status: 'done' },
          { kind: 'execute-tool-call', id: 'long', seq: 2, toolCallId: 'long', parentToolCallId: 'launch',
            title: command, command, status: 'done' },
          { kind: 'execute-tool-call', id: 'running', seq: 3, toolCallId: 'running', parentToolCallId: 'launch',
            title: 'sleep 180', command: 'sleep 180', status: 'running' },
        ] },
    ],
  };
}

async function mount(conversation = true) {
  const context = createChatContext({ layout: { preset: 'double', userGutter: 72, agentConversation: conversation } });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:760px;height:600px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host });
  teardown.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.session.setBackgroundTasks({ commands: [], subagents: collectSubagentRoster([recordedTurn()], null, 'Helper') });
  const pill = () => host.querySelector<HTMLElement>('[data-collapse-id="background-tasks:open"]');
  await until('background pill mounts', () => !!pill());
  pill()!.click();
  const agent = () => host.querySelector<HTMLElement>('[data-slot="background-task"][data-task-kind="subagent"]');
  await until('running card mounts', () => !!agent());
  agent()!.dispatchEvent(new MouseEvent('mouseenter'));
  const panel = () => document.querySelector<HTMLElement>('[data-slot="subagent-hover-panel"]');
  const steps = () => [...panel()!.querySelectorAll<HTMLElement>('[data-slot="subagent-timeline-step"]')];
  await until('child steps mount', () => panel()?.querySelectorAll('[data-slot="subagent-timeline-step"]').length === 3);
  return { state, host, panel, steps };
}

describe('subagent compact progress (#1022)', () => {
  it.each([false, true])('keeps long and multiline commands to one line before opening (conversation: %s)', async (conversation) => {
    const { state, steps } = await mount(conversation);
    const check = () => {
      for (const step of steps()) {
        expect(step.getBoundingClientRect().height).toBeLessThanOrEqual(parseFloat(getComputedStyle(step).lineHeight) + 1);
      }
    };
    check();
    state.session.setBackgroundTasks({ commands: [], subagents: collectSubagentRoster([recordedTurn('printf first\nprintf second\n' + longCommand)], null, 'Helper') });
    await until('multiline command reaches the view', () => steps()[1].textContent!.includes('printf second'));
    check();
  });

  it('keeps the action whole, opens clipped details, and leaves short rows inert', async () => {
    const { panel, steps } = await mount();
    const action = steps()[1].querySelector<HTMLElement>('[data-slot="subagent-step-action"]');
    expect(action).not.toBeNull();
    expect(action!.textContent).toBe('Ran 1 shell command');
    expect(action!.scrollWidth).toBeLessThanOrEqual(action!.clientWidth + 1);
    const short = steps()[0].querySelector<HTMLButtonElement>('button')!;
    expect(short.disabled).toBe(true);
    expect(getComputedStyle(short).cursor).not.toBe('pointer');
    const long = steps()[1].querySelector<HTMLButtonElement>('button')!;
    expect(long.disabled).toBe(false);
    long.click();
    await until('long step opens', () => long.getAttribute('aria-expanded') === 'true');
    const full = steps()[1].querySelector<HTMLElement>('[data-slot="subagent-step-detail"]')!;
    expect(full.textContent).toBe(longCommand);
    expect(full.getBoundingClientRect().height).toBeGreaterThan(parseFloat(getComputedStyle(full).lineHeight));
    const expandedRows = steps();
    for (let i = 1; i < expandedRows.length; i++) {
      expect(expandedRows[i].getBoundingClientRect().top).toBeGreaterThanOrEqual(expandedRows[i - 1].getBoundingClientRect().bottom);
    }
    const viewport = panel()!.querySelector<HTMLElement>('[data-slot="subagent-timeline"]')!;
    expect(getComputedStyle(viewport).overflowY).toBe('auto');
    long.click();
    await until('long step closes', () => long.getAttribute('aria-expanded') === 'false');
    expect(steps()[1].querySelector('[data-slot="subagent-step-detail"]')).toBeNull();
  });

  it('updates real arguments with an unchanged title and keeps an opened step through roster snapshots', async () => {
    const { state, steps } = await mount();
    const button = steps()[1].querySelector<HTMLButtonElement>('button')!;
    await until('long step can open', () => !button.disabled);
    button.click();
    await until('step is open', () => button.getAttribute('aria-expanded') === 'true');
    const turn = recordedTurn(longCommand + ' UPDATED1022');
    const launch = turn.items[0];
    if (launch.kind !== 'spawn-subagent-tool-call') throw new Error('fixture launch missing');
    const long = launch.children![1];
    if (long.kind !== 'execute-tool-call') throw new Error('fixture command missing');
    long.title = longCommand;
    state.session.setBackgroundTasks({ commands: [], subagents: collectSubagentRoster([turn], null, 'Helper') });
    await until('same-title argument update arrives', () => steps()[1].querySelector('[data-slot="subagent-step-detail"]')?.textContent?.endsWith('UPDATED1022') === true);
    expect(steps()[1].querySelector('button')).toBe(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the pointer inside a narrow-window panel when opening a long step', async () => {
    await page.viewport(900, 900);
    teardown.push(() => page.viewport(1280, 900));
    const { host, panel, steps } = await mount();
    const anchor = host.querySelector<HTMLElement>('[data-slot="background-task"][data-task-kind="subagent"]')!;
    // The real narrow-window card sits below a running row near the bottom.
    anchor.style.cssText += ';position:fixed;top:620px;left:330px;width:550px';
    window.dispatchEvent(new Event('resize'));
    await untilStable('collapsed panel position settles', () => panel()?.getBoundingClientRect().top);
    const button = steps()[1].querySelector<HTMLButtonElement>('button')!;
    const before = button.getBoundingClientRect();
    const pointer = { x: before.left + before.width / 2, y: before.top + before.height / 2 };
    expect(panel()!.getBoundingClientRect().top).toBeGreaterThan(anchor.getBoundingClientRect().bottom);
    await userEvent.click(button);
    await until('long detail is visible', () => !!panel()?.querySelector('[data-slot="subagent-step-detail"]'));
    await untilStable('expanded panel position settles', () => panel()?.getBoundingClientRect().top);
    expect(panel(), 'opening a step must not close the hover panel').not.toBeNull();
    const after = panel()!.getBoundingClientRect();
    expect(after.top).toBeLessThanOrEqual(pointer.y);
    expect(after.bottom).toBeGreaterThanOrEqual(pointer.y);
    expect(after.top).toBeGreaterThanOrEqual(8);
    expect(after.bottom).toBeLessThanOrEqual(innerHeight - 8);
    expect(panel()!.contains(document.elementFromPoint(pointer.x, pointer.y))).toBe(true);
    await userEvent.click(button);
    await until('long detail is collapsed', () => !panel()?.querySelector('[data-slot="subagent-step-detail"]'));
    await untilStable('collapsed position settles again', () => panel()?.getBoundingClientRect().top);
    expect(panel()).not.toBeNull();
    await page.viewport(1280, 900);
    await until('window resize places the panel beside its anchor', () => (panel()?.getBoundingClientRect().left ?? 0) > anchor.getBoundingClientRect().right);
    await userEvent.hover(document.body);
    await until('leaving the panel still closes it', () => panel() === null);
  });
});
