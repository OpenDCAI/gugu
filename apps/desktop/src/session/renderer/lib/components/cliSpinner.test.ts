// @vitest-environment jsdom
//
// spec agent-status「附属态」:后台运行中(回合已结束、只剩后台 / 定时)= 同一枚转圈字形、动画停。
// 判的是字形本身:animate=false 不起计时器(时间走多久都是同一帧),且那一帧就是转圈里本来就有的字形。
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLISpinner } from './cliSpinner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(props: { variant?: '1' | '2'; animate?: boolean }): void {
  act(() => root.render(createElement(CLISpinner, props)));
}

/** 连续取样 `ticks` 个 80ms 帧,返回看到过的所有字形。 */
function sample(ticks: number): string[] {
  const seen: string[] = [];
  for (let i = 0; i < ticks; i += 1) {
    seen.push(container.textContent ?? '');
    act(() => vi.advanceTimersByTime(80));
  }
  return seen;
}

describe('CLISpinner animate', () => {
  it.each(['1', '2'] as const)('variant %s: animate=false 画同一帧、不起计时器', (variant) => {
    render({ variant, animate: false });
    expect(vi.getTimerCount(), '静止的字形不该有计时器').toBe(0);
    const seen = sample(30);
    expect(new Set(seen).size).toBe(1);
    expect(container.querySelector('[data-animate="false"]')).not.toBeNull();
  });

  it.each(['1', '2'] as const)('variant %s: 静止的那一帧是转圈本来就会画的字形(同一枚字形)', (variant) => {
    render({ variant, animate: true });
    // 阳控:在动的时候确实会换帧 —— 否则上面「只有一帧」的判据平凡为真。
    const animated = sample(30);
    expect(new Set(animated).size).toBeGreaterThan(1);
    expect(container.querySelector('[data-animate]')).toBeNull();

    render({ variant, animate: false });
    const paused = container.textContent ?? '';
    expect(animated).toContain(paused);
  });

  it('默认仍在动(没有附属态的 working = 基础态画法)', () => {
    render({ variant: '2' });
    expect(new Set(sample(30)).size).toBeGreaterThan(1);
  });

  it.each([true, false])('animate=%s: 字形不上状态色(owner 2026-09-26:转圈回到墨色)', (animate) => {
    render({ variant: '2', animate });
    const glyph = container.firstElementChild as HTMLElement;
    expect(glyph.className).toContain('text-foreground/60');
    expect(glyph.className).not.toContain('agent-tone');
  });
});
