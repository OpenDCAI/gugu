import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { i18n } from '@/i18n';
import { AppWindow, MessageCircle, Terminal } from '@/lib/icons';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { SessionModeMenuView, type SessionModeEntry } from '@renderer/features/sessions/view/session-mode-menu';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

// #7167 模式按钮:真 Chromium、真 Base UI 菜单与提示。owner 定的几条在这里判结果,❌ 判类名:
//   · 停一下就开(openOnHover),选了就收;
//   · 选不了的那行留在原地、变淡,停上去说原因,点了不动(❌ 藏起来,❌ 点了没反应也不说为什么);
//   · 宽度随内容,❌ 照抄「排序方式」的 192;
//   · 去处和动作分开(10-14「编程和通用一般是二选一」「尽量不要让用户误触」):分隔线上面是去处 —— 聊天、
//     正在用的那种(打勾);下面只有动作「切换为另一种」。❌ 两种并排成一样的单选,❌ 在它们头上挂一行说明。

const NO_ID = '这条任务还没有咕咕身份，暂时去不了聊天';

const NO_SSH = '这台机器不是用 SSH 添加的，用不了编程模式';
const views = (codeLock: string | null = null): SessionModeEntry[] => [
  { mode: 'code', Icon: Terminal, label: '编程', lock: codeLock },
  { mode: 'general', Icon: AppWindow, label: '通用', lock: null },
];
const chatEntry = (lock: string | null): SessionModeEntry => ({ mode: 'chat', Icon: MessageCircle, label: '聊天', lock });

describe('SessionModeMenuView (#7167)', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let previousLanguage = 'en-US';
  const onPick = vi.fn();

  const render = (chatLock: string | null, current: 'code' | 'general' = 'general', codeLock: string | null = null) => {
    root!.render(
      <SessionLocalizationProvider>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 8 }}>
          <SessionModeMenuView current={current} chat={chatEntry(chatLock)} views={views(codeLock)} chatBusy={false} onPick={onPick} />
        </div>
      </SessionLocalizationProvider>
    );
  };
  /** 菜单里从上到下:单选的去处记 `place:<模式>`,动作记 `action:<模式>`,分隔线记 'sep'。 */
  const layout = () => {
    const popup = row('chat')!.closest<HTMLElement>('[data-slot="dropdown-menu-content"]')!;
    return [...popup.querySelectorAll<HTMLElement>('[data-testid^="session-mode-"], [data-slot="dropdown-menu-separator"]')].map((el) =>
      el.dataset.slot === 'dropdown-menu-separator'
        ? 'sep'
        : `${el.getAttribute('role') === 'menuitemradio' ? 'place' : 'action'}:${el.dataset.testid!.replace('session-mode-', '')}`
    );
  };
  const trigger = () => document.querySelector<HTMLElement>('[data-testid="session-mode-trigger"]')!;
  const row = (mode: string) => document.querySelector<HTMLElement>(`[data-testid="session-mode-${mode}"]`);
  const openByHover = async () => {
    await userEvent.hover(trigger());
    await until('menu opened by hovering', () => row('chat') !== null);
  };

  beforeEach(async () => {
    previousLanguage = i18n.language;
    await i18n.changeLanguage('zh-CN');
    await page.viewport(900, 500);
    onPick.mockReset();
    container = document.createElement('div');
    container.className = 'emlight gugu-skin bg-background';
    document.body.classList.add('emlight', 'gugu-skin');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await i18n.changeLanguage(previousLanguage);
    document.body.classList.remove('emlight', 'gugu-skin');
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
  });

  it('shows the current mode, opens on hover, checks the current row, and fits its content', async () => {
    render(null);
    await until('trigger mounted', () => document.querySelector('[data-testid="session-mode-trigger"]') !== null);
    expect(trigger().textContent).toBe('通用');
    // 平时不铺底(与同排「换模型」那颗同一档)。
    expect(getComputedStyle(trigger()).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    await openByHover();
    expect(row('general')!.hasAttribute('data-checked')).toBe(true);
    expect(row('chat')!.hasAttribute('data-checked')).toBe(false);
    const popup = row('chat')!.closest<HTMLElement>('[data-slot="dropdown-menu-content"]')!;
    expect(popup.getBoundingClientRect().width).toBeLessThan(180);
  });

  it('above the divider: chat, then the mode in use (checked); below it: only the switch to the other mode', async () => {
    render(null, 'general');
    await until('trigger mounted', () => document.querySelector('[data-testid="session-mode-trigger"]') !== null);
    await openByHover();
    expect(layout()).toEqual(['place:chat', 'place:general', 'sep', 'action:code']);
    expect(row('general')!.hasAttribute('data-checked')).toBe(true);
    expect(row('code')!.textContent).toBe('切换为编程模式');
    // 菜单里没有一行说明文字:代价由确认框在点下去时说。
    expect(row('chat')!.closest('[data-slot="dropdown-menu-content"]')!.querySelector('[data-slot="dropdown-menu-label"]')).toBeNull();
  });

  it('when the task runs in Code, Code is the place and the switch goes to General', async () => {
    render(null, 'code');
    await until('trigger mounted', () => document.querySelector('[data-testid="session-mode-trigger"]') !== null);
    expect(trigger().textContent).toBe('编程');
    await openByHover();
    expect(layout()).toEqual(['place:chat', 'place:code', 'sep', 'action:general']);
    expect(row('code')!.hasAttribute('data-checked')).toBe(true);
    expect(row('general')!.textContent).toBe('切换为通用模式');
  });

  it('picking an open row reports it and closes the menu', async () => {
    render(null);
    await until('trigger mounted', () => document.querySelector('[data-testid="session-mode-trigger"]') !== null);
    await openByHover();
    await userEvent.click(row('code')!);
    expect(onPick).toHaveBeenCalledWith('code');
    await until('menu closed after picking', () => row('code') === null);
  });

  it('a locked row stays in place, dimmed; hovering says why; clicking does nothing', async () => {
    render(NO_ID);
    await until('trigger mounted', () => document.querySelector('[data-testid="session-mode-trigger"]') !== null);
    await openByHover();
    const chat = row('chat')!;
    expect(chat.hasAttribute('data-disabled')).toBe(true);
    expect(Number(getComputedStyle(chat).opacity)).toBeLessThan(1);
    await userEvent.hover(chat);
    await until('reason tooltip shown', () =>
      [...document.querySelectorAll('[data-slot="tooltip-content"]')].some((tip) => tip.textContent === NO_ID)
    );
    await userEvent.click(chat, { force: true });
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a switch that this machine cannot do stays in place, dimmed, and says why', async () => {
    render(null, 'general', NO_SSH);
    await until('trigger mounted', () => document.querySelector('[data-testid="session-mode-trigger"]') !== null);
    await openByHover();
    const action = row('code')!;
    expect(action.hasAttribute('data-disabled')).toBe(true);
    expect(Number(getComputedStyle(action).opacity)).toBeLessThan(1);
    await userEvent.hover(action);
    await until('reason tooltip shown', () =>
      [...document.querySelectorAll('[data-slot="tooltip-content"]')].some((tip) => tip.textContent === NO_SSH)
    );
    await userEvent.click(action, { force: true });
    expect(onPick).not.toHaveBeenCalled();
  });
});
