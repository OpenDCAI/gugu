// @vitest-environment jsdom
//
// #7243(owner 2026-10-15):任务页的 agent 状态不画咕咕小鸟 —— 在跑 = 墨色转圈字形、后台运行中 = 同一枚字形静止、
// 等你 = 黄点、出错 = 红点、空闲不画。判的是渲染出来的东西:每一态都没有小鸟的画布。
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import type { AgentStatus, AgentStatusDetail } from '@shared/core/agents/agentEvents';
import { AgentStatusGlyph } from './agent-status-indicator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderGlyph(status: AgentStatus, detail: AgentStatusDetail | null = null): void {
  const presentation = presentAgentStatus({ reading: { status, detail } });
  act(() => root.render(createElement(AgentStatusGlyph, { presentation, label: presentation.label })));
}

function expectNoBird(): void {
  expect(container.querySelector('canvas')).toBeNull();
  expect(container.querySelector('[data-agent-avatar]')).toBeNull();
}

describe('任务页的状态字形(#7243)', () => {
  it('在跑 = 转圈字形,不是小鸟', () => {
    renderGlyph('working');
    expectNoBird();
    expect(container.textContent).toMatch(/^[⠀-⣿]$/u);
    expect(container.querySelector('[data-animate="false"]')).toBeNull();
  });

  it('后台运行中 = 同一枚字形静止', () => {
    renderGlyph('working', 'parked');
    expectNoBird();
    expect(container.querySelector('[data-animate="false"]')?.textContent).toBe('⠋');
  });

  it('等你 = 黄点,出错 = 红点', () => {
    renderGlyph('needs_user', 'approval');
    expectNoBird();
    expect(container.querySelector('span')?.className).toContain('bg-[var(--agent-tone-needs-user)]');

    renderGlyph('error');
    expectNoBird();
    expect(container.querySelector('span')?.className).toContain('bg-[var(--agent-tone-error)]');
  });

  it('空闲不画', () => {
    renderGlyph('idle');
    expect(container.innerHTML).toBe('');
  });
});
