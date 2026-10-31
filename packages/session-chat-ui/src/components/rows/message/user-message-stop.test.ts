// @vitest-environment jsdom
/**
 * #3498 —— transcript 里那颗停止按钮必须真的接到宿主。
 *
 * ## 修之前它是什么
 *
 * `UserMessageCard` 渲染停止按钮只看 `turnStatus === 'generating'`，点击走
 * `commands().onStop?.({ itemId })`。而全仓**唯一**挂 `<ChatTranscript>` 的产品调用点
 * （`acp-chat-panel.tsx:857` 的 `commands={transcriptCommands}`）从来没有注入过 `onStop`
 * ⇒ 那个 `?.` 让整条调用在语法层短路：**按下去一个字节都不发。**
 *
 * 它一直没被发现，是因为 composer 上还有另一颗停止按钮（`onStop={a.isWorking ? handleStop : …}`），
 * 那条路一直是通的 —— 于是「产品能停」是真的，而「transcript 上这颗能停」是假的，
 * 两者在用户那里长得一模一样。
 *
 * ## 这条守的是什么
 *
 * 不是「点了会调用回调」（那本来就会），而是**没接回调时不许把按钮画出来**。
 * 一个按不动的控件比没有控件更糟：它把「这里能停」这句话许出去了，却没有人兑现。
 */
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserMessageCard } from './UserMessageCard';
import type { MessageVars } from './metrics';
import { CommandsContext } from '../../contexts/CommandsContext';
import { TurnStateContext, type TurnState } from '../../contexts/TurnStateContext';
import type { ChatCommands } from '../../../commands';
import type { ChatMessage } from '../../../model';
import { createSignal } from 'solid-js';

const MESSAGE: ChatMessage = {
  kind: 'message',
  id: 'u1',
  role: 'user',
  text: '把 README 翻译成英文',
};

const VARS: MessageVars = {
  cardBorder: 1,
  collapsedMaxH: 120,
  expandedMaxH: 360,
  userCardPadX: 16,
  userCardPadY: 16,
  attachThumb: 32,
  attachGap: 8,
  footerH: 24,
};

let dispose: (() => void) | null = null;
let host: HTMLDivElement | null = null;

function renderCard(opts: { generating: boolean; commands?: ChatCommands; message?: () => ChatMessage }): HTMLElement {
  const turnState: TurnState = {
    currentMessageId: () => MESSAGE.id,
    turnStatus: () => (opts.generating ? 'generating' : 'done'),
  };
  const commands: ChatCommands = opts.commands ?? {};
  host = document.createElement('div');
  document.body.appendChild(host);
  dispose = render(
    () =>
      TurnStateContext.Provider({
        value: turnState,
        get children() {
          return CommandsContext.Provider({
            value: () => commands,
            get children() {
              // measureCtx 省略：卡片内部对它全程可选链，缺席时只是不排版正文，
              // 而这条读的是按钮在不在，与正文排版无关。
              // 测试夹具边界
              return UserMessageCard({
                get data() { return opts.message?.() ?? MESSAGE; },
                // 测试夹具边界
                ctx: { viewState: { isCollapsed: () => false } } as any,
                vars: VARS,
                // Solid JSX 返回类型在测试里不重要
              }) as any;
            },
            // Solid JSX 返回类型在测试里不重要
          }) as any;
        },
        // Solid JSX 返回类型在测试里不重要
      }) as any,
    host,
  );
  return host;
}

const stopButton = (el: HTMLElement) =>
  el.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]');

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('#3498 transcript 的停止按钮', () => {
  it('阳性对照：正在生成且宿主接了 onStop ⇒ 按钮真的在 DOM 里', () => {
    const el = renderCard({ generating: true, commands: { onStop: () => {} } });
    expect(
      stopButton(el),
      '按钮没渲染 —— 下面每条「不渲染」都不算读数，只说明这把尺子读不到东西',
    ).toBeTruthy();
  });

  it('宿主没接 onStop ⇒ 不渲染（这正是修之前产品里的那个状态）', () => {
    const el = renderCard({ generating: true });
    expect(stopButton(el)).toBeNull();
  });

  it('没有在生成 ⇒ 不渲染（原有行为不变）', () => {
    const el = renderCard({ generating: false, commands: { onStop: () => {} } });
    expect(stopButton(el)).toBeNull();
  });

  it('按下去把这条消息的 id 交给宿主', () => {
    const onStop = vi.fn();
    const el = renderCard({ generating: true, commands: { onStop } });
    stopButton(el)!.click();
    expect(onStop).toHaveBeenCalledWith({ itemId: 'u1' });
  });
});


describe('conversation edit control', () => {
  it('shows only a real valid message time and follows virtual row reuse', () => {
    const [message, setMessage] = createSignal(MESSAGE);
    const el = renderCard({ generating: false, message });
    expect(el.querySelector('time')).toBeNull();
    setMessage({ ...MESSAGE, at: 1_790_000_000_000 });
    expect(el.querySelector('time')?.dateTime).toBe(new Date(1_790_000_000_000).toISOString());
    setMessage({ ...MESSAGE, id: 'other', at: Number.MAX_VALUE });
    expect(el.querySelector('time')).toBeNull();
  });
  const selector = 'button[aria-label="Edit message"]';
  it('shows and invokes only an actionable native boundary', () => {
    const onEditMessage = vi.fn();
    const el = renderCard({ generating: false, commands: { canRevertMessage: () => true, onEditMessage } });
    const button = el.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull(); button!.click();
    expect(onEditMessage).toHaveBeenCalledWith({ itemId: 'u1' });
    const actions = button!.closest('[data-user-message-actions]');
    const bubble = el.querySelector('[data-user-card]');
    expect(actions?.previousElementSibling).toBe(bubble);
    expect(bubble?.contains(button!)).toBe(false);
  });
  it('does not offer an unsupported, busy, or unwired action', () => {
    expect(renderCard({ generating: false, commands: { onEditMessage: () => {}, canRevertMessage: () => false } }).querySelector(selector)).toBeNull();
    dispose?.(); host?.remove();
    expect(renderCard({ generating: true, commands: { onEditMessage: () => {}, canRevertMessage: () => true } }).querySelector(selector)).toBeNull();
  });

  it('keeps copying available without a native revert point', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const el = renderCard({ generating: false, commands: { writeClipboardText: writeText } });
    el.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click();
    expect(writeText).toHaveBeenCalledWith(MESSAGE.text);
    await vi.waitFor(() => expect(el.querySelector('button[aria-label="Copied"]')).not.toBeNull());
    expect(el.querySelector(selector)).toBeNull();
  });

  it('reacts when the current session stops allowing history changes', () => {
    const [allowed, setAllowed] = createSignal(true);
    const el = renderCard({ generating: false, commands: {
      onEditMessage: () => {}, canRevertMessage: allowed,
    } });
    expect(el.querySelector(selector)).not.toBeNull();
    setAllowed(false);
    expect(el.querySelector(selector)).toBeNull();
    expect(el.querySelector('button[aria-label="Copy"]')).not.toBeNull();
  });

  it('does not carry copied feedback or the old target into a reused virtual row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const [message, setMessage] = createSignal(MESSAGE);
    const onEditMessage = vi.fn();
    const el = renderCard({ generating: false, message,
      commands: { canRevertMessage: () => true, onEditMessage, writeClipboardText: writeText } });
    el.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click();
    await vi.waitFor(() => expect(el.querySelector('button[aria-label="Copied"]')).not.toBeNull());
    setMessage({ ...MESSAGE, id: 'u2', text: 'A different message' });
    expect(el.querySelector('button[aria-label="Copied"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click();
    expect(writeText).toHaveBeenLastCalledWith('A different message');
    el.querySelector<HTMLButtonElement>(selector)!.click();
    expect(onEditMessage).toHaveBeenLastCalledWith({ itemId: 'u2' });
  });
});

describe('inline message editor', () => {
  it('opens with the original text, changes a separate draft, and cancels without submitting', () => {
    const onSubmit = vi.fn();
    const [edit, setEdit] = createSignal<ChatCommands['editingMessage']>();
    const open = () => setEdit({ itemId: MESSAGE.id, text: MESSAGE.text, pending: false, canSubmit: true,
      onChange: (text) => setEdit((current) => ({ ...current!, text })),
      onCancel: () => setEdit(undefined), onSubmit });
    const el = renderCard({ generating: false, commands: {
      canRevertMessage: () => true, onEditMessage: open, get editingMessage() { return edit(); },
    } });
    el.querySelector<HTMLButtonElement>('button[aria-label="Edit message"]')!.click();
    const textarea = el.querySelector('textarea')!;
    expect(textarea.value).toBe(MESSAGE.text);
    expect(document.activeElement).toBe(textarea);
    textarea.value = '修改后的指令';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(edit()?.text).toBe('修改后的指令');
    expect(MESSAGE.text).toBe('把 README 翻译成英文');
    expect(onSubmit).not.toHaveBeenCalled();
    [...el.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click();
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.querySelector('[data-user-card]')).not.toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits only on Send or the explicit shortcut and keeps IME Enter as text input', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const edit = { itemId: MESSAGE.id, text: 'edited', pending: false, canSubmit: true,
      onChange: () => {}, onCancel, onSubmit };
    const el = renderCard({ generating: false, commands: { editingMessage: edit } });
    const textarea = el.querySelector('textarea')!;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, isComposing: true, bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    [...el.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.click();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('never mounts another message\'s edit draft in a recycled row', () => {
    const [message, setMessage] = createSignal(MESSAGE);
    const el = renderCard({ generating: false, message, commands: { editingMessage: {
      itemId: MESSAGE.id, text: 'unsent edit', pending: false, canSubmit: true,
      onChange: () => {}, onCancel: () => {}, onSubmit: () => {},
    } } });
    expect(el.querySelector('textarea')!.value).toBe('unsent edit');
    setMessage({ ...MESSAGE, id: 'other', text: 'other message' });
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.querySelector('[data-user-card]')?.getAttribute('data-user-card')).toBe('other');
  });
});
