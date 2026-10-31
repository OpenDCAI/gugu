import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { Avatar } from '@/components/Avatar';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@gugu/session-shared/animation-visibility.css';

// The running pulse is bound to one status change: it plays a few cycles when the badge turns to working, then the
// rings hold still at their base style. An infinite pulse made a screen of working agents repaint every frame.
const avatar = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="20" height="20"%3E%3Crect width="20" height="20" fill="gray"/%3E%3C/svg%3E';
const stop: Array<() => void> = [];
afterEach(() => { stop.splice(0).forEach((fn) => fn()); });

it('a working badge pulses three times, then holds a still ring; a new working status pulses again', async () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  stop.push(() => { root.unmount(); host.remove(); });
  const render = (status: 'working' | 'idle') => root.render(<Avatar name="Agent" seed="pulse-guard" avatarUrl={avatar} isAgent agentStatus={status} harnessBadge={false} />);
  const pulses = () => host.getAnimations({ subtree: true }).filter((a) => (a as CSSAnimation).animationName === 'av-status-pulse');

  render('working');
  await until('two rings pulse', () => pulses().length === 2 && pulses().every((a) => a.playState === 'running'));
  expect(pulses().map((a) => a.effect?.getComputedTiming().iterations)).toEqual([3, 3]);
  await until('the pulse has stopped (3 × 1.4 s, the second ring 0.7 s later)', () => pulses().length === 0);
  const rings = [...host.querySelectorAll<HTMLElement>('.av-status__pulse')];
  expect(rings).toHaveLength(2);
  for (const ring of rings) {
    const style = getComputedStyle(ring);
    expect(style.opacity).toBe('0.55');
    expect(style.borderTopStyle).toBe('solid');
    expect(ring.getAnimations()).toHaveLength(0);
  }

  render('idle');
  await until('idle has no rings', () => host.querySelectorAll('.av-status__pulse').length === 0);
  render('working');
  await until('working again pulses again', () => pulses().length === 2);
});
