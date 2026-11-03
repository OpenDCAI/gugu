import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionTimelineRail } from '@renderer/features/sessions/view/session-timeline-rail';
import type { TimelineTurn } from '@renderer/features/sessions/view/session-timeline-turns';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@renderer/index.css';

vi.mock('@renderer/lib/chat/chat-name', () => ({ chatDisplayName: () => 'Study group' }));

let host: HTMLDivElement;
let column: HTMLDivElement;
let root: Root;
const own: TimelineTurn = { id: 'own', anchorItemId: 'mine', itemIds: ['mine'], prompt: 'Own input', reply: '', mine: true };
const other: TimelineTurn = { id: 'other', anchorItemId: 'theirs', itemIds: ['theirs'], prompt: 'Other input', reply: '', mine: false, sender: { kind: 'chat', name: 'Ada' } };

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  column = document.createElement('div');
  column.className = 'relative';
  Object.assign(column.style, { height: '240px', width: '600px' });
  host.append(column);
  document.body.append(host);
  root = createRoot(column);
});
afterEach(() => { root.unmount(); host.remove(); });

function referenceTone(tone: string): string {
  const reference = document.createElement('span');
  reference.className = tone;
  host.append(reference);
  const color = getComputedStyle(reference).backgroundColor;
  reference.remove();
  return color;
}
async function render(turns: TimelineTurn[], current: string | null = null, onJump = vi.fn()) {
  root.render(<SessionLocalizationProvider><SessionTimelineRail turns={turns} currentTurnId={current} onJump={onJump} /></SessionLocalizationProvider>);
  await expect.poll(() => column.querySelectorAll('[data-slot="tick"]').length).toBeGreaterThan(0);
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await Promise.all([...column.querySelectorAll<HTMLElement>('[data-slot="tick"]')].flatMap(pill => pill.getAnimations().map(animation => animation.finished)));
  return [...column.querySelectorAll<HTMLButtonElement>('[data-tick-index]')];
}

describe('UI-17 own turn emphasis', () => {
  it.each(['emlight', 'emdark'])('uses full ink at18px for mine and muted40 at8px for others in %s', async (theme) => {
    host.className = `gugu-skin ${theme}`;
    const buttons = await render([own, other]);
    const [mine, theirs] = buttons.map(button => button.querySelector<HTMLElement>('[data-slot="tick"]')!);
    expect(mine.getBoundingClientRect().width).toBe(18);
    expect(theirs.getBoundingClientRect().width).toBe(8);
    expect(getComputedStyle(mine).backgroundColor).toBe(referenceTone('bg-foreground'));
    expect(getComputedStyle(theirs).backgroundColor).toBe(referenceTone('bg-foreground-muted/40'));
  });

  it.each([own, other])('keeps current $id blue without changing the source length', async (turn) => {
    const [button] = await render([turn], turn.id);
    const pill = button.querySelector<HTMLElement>('[data-slot="tick"]')!;
    expect(getComputedStyle(pill).backgroundColor).toBe(referenceTone('bg-foreground-info'));
    expect(pill.getBoundingClientRect().width).toBe(turn.mine ? 18 : 8);
  });

  it('clicks a mixed tick into its own input and preserves its group in the preview label', async () => {
    column.style.height = '12px';
    const groupOwn: TimelineTurn = { ...own, sender: { kind: 'group', name: 'Me', chatId: 'study' } };
    const onJump = vi.fn();
    await render([other, groupOwn], null, onJump);
    await expect.poll(() => column.querySelectorAll('[data-tick-index]').length).toBe(1);
    const button = column.querySelector<HTMLButtonElement>('[data-tick-index]')!;
    expect(button.dataset.tickSpan).toBe('1-2');
    button.focus();
    await expect.poll(() => document.querySelector('[data-slot="preview-sender"]')?.textContent).toContain('Study group');
    button.click();
    expect(onJump).toHaveBeenCalledWith('mine');
  });
});
