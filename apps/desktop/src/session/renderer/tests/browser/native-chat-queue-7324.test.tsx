import { createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { ChatComposer, MessageProvider, type ComposerQueuedPrompt, type PromptEditorRef } from '@gugu/session-ui/react/components';
import { i18n } from '@/i18n';
import { registerSessionLocaleResources } from '@renderer/localization/locale-store';
import { nativeComposerAppearance } from '@renderer/lib/chat/native-chat-appearance.css';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

const PROMPTS: ComposerQueuedPrompt[] = [
  { id: 'q1', text: '  第一条原文\n保留换行  ', origin: 'typed', sendNowSteers: true },
  { id: 'q2', text: '第二条消息', origin: 'manual', sendNowSteers: false },
];
let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => { root?.unmount(); host?.remove(); root = undefined; host = undefined; });

async function fillEditor(text: string) {
  const input = page.getByTestId('prompt-editor');
  await input.click();
  // 先同步 ProseMirror 的选区,避免聚焦修正覆盖 fill() 只改的 DOM 选区。
  await userEvent.keyboard(navigator.platform.includes('Mac') ? '{Meta>}a{/Meta}' : '{Control>}a{/Control}');
  await input.fill(text);
}

async function mount(prompts = PROMPTS, width = 640, locale = 'zh-CN') {
  registerSessionLocaleResources();
  const t = i18n.getFixedT(locale, 'session');
  const onEdit = vi.fn(); const onDelete = vi.fn(); const onReorder = vi.fn();
  const onSendNow = vi.fn(); const onStop = vi.fn();
  let replace!: (prompts: ComposerQueuedPrompt[]) => void;
  const editor = createRef<PromptEditorRef>();
  function Harness() {
    const [queue, setQueue] = useState(prompts);
    replace = setQueue;
    return <MessageProvider locale={locale} translate={(key, values) => t(key, { ...values, interpolation: { prefix: '{', suffix: '}' } })}>
      <ChatComposer isWorking canSubmit editorApiRef={editor}
        queuedPrompts={queue} onSubmit={() => {}} onSubmitWhileWorking={() => {}} onStop={onStop}
        onEditQueuedPrompt={(id, text) => { onEdit(id, text); setQueue((q) => q.map((p) => p.id === id ? { ...p, text } : p)); }}
        onDeleteQueuedPrompt={(id) => { onDelete(id); setQueue((q) => q.filter((p) => p.id !== id)); }}
        onReorderQueuedPrompts={(ids) => { onReorder(ids); setQueue((q) => ids.map((id) => q.find((p) => p.id === id)!)); }}
        onSendQueuedPromptNow={onSendNow} />
    </MessageProvider>;
  }
  host = document.createElement('div');
  host.className = `gugu-skin emlight ${nativeComposerAppearance}`;
  host.style.width = `${width}px`;
  document.body.append(host);
  root = createRoot(host); root.render(<Harness />);
  await until('the real composer and queue mount', () => host!.querySelector('[data-slot="composer-bar"]') != null && host!.querySelector('[data-slot="composer-queued-prompts"]') != null);
  const row = (id: string) => host!.querySelector<HTMLElement>(`[data-queued-prompt-id="${id}"]`)!;
  return { row, replace, onEdit, onDelete, onReorder, onSendNow, onStop, editor };
}

it('presents a compact queue above a fully rounded composer with separate steer/send actions', async () => {
  await mount();
  const band = host!.querySelector<HTMLElement>('[data-slot="composer-queued-prompts"]')!;
  const sends = [
    page.getByRole('button', { name: '现在插入第 1 条排队消息', exact: true }).query(),
    page.getByRole('button', { name: '立即发送第 2 条排队消息', exact: true }).query(),
  ];
  expect(sends.map((b) => b?.textContent)).toEqual(['现在插入', '立即发送']);
  expect(band.getAttribute('role')).toBe('region');
  expect(band.getAttribute('aria-label')).toBe('排队消息 (2)');
  expect(getComputedStyle(band).borderTopWidth).toBe('0px');
  expect(getComputedStyle(host!.querySelector('[data-slot="composer-bar"]')!).borderTopLeftRadius).toBe('24px');
});

it('edits from the real menu, saving the original message without changing queue order', async () => {
  const h = await mount();
  await page.getByRole('button', { name: '第 1 条排队消息的操作' }).click();
  await page.getByRole('menuitem', { name: '编辑第 1 条提示' }).click();
  const input = page.getByTestId('prompt-editor');
  await until('the queue text reaches the same main editor', () => h.editor.current?.getText() === PROMPTS[0].text);
  expect(host!.querySelector('textarea')).toBeNull();
  expect(host!.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
  expect(h.row('q1').contains(input.query())).toBe(false);
  await fillEditor('  修改后仍排队\n第二行  ');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  expect(h.onEdit).toHaveBeenCalledExactlyOnceWith('q1', '  修改后仍排队\n第二行  ');
  expect([...host!.querySelectorAll<HTMLElement>('[data-queued-prompt-id]')].map((r) => r.dataset.queuedPromptId)).toEqual(['q1', 'q2']);
  expect(h.onSendNow).not.toHaveBeenCalled();
});

it('cancel and IME Enter never commit; blank edits cannot be saved', async () => {
  const h = await mount();
  h.row('q1').querySelector<HTMLButtonElement>('button:not([draggable])')!.click();
  const input = page.getByTestId('prompt-editor');
  await until('main editor switches to queue text', () => h.editor.current?.getText() === PROMPTS[0].text);
  await fillEditor('中文输入中');
  input.query()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  expect(h.onEdit).not.toHaveBeenCalled();
  await fillEditor('  ');
  expect((page.getByRole('button', { name: '保存', exact: true }).query() as HTMLButtonElement).disabled).toBe(true);
  await fillEditor('不保存');
  await userEvent.keyboard('{Escape}');
  expect(h.onEdit).not.toHaveBeenCalled();
  expect(h.row('q1').textContent).toContain('第一条原文');
});

it.each([
  { locale: 'zh-CN', steer: '现在插入第 1 条排队消息', send: '立即发送第 2 条排队消息', steerTitle: '不打断它，agent 下一步就会看到', sendTitle: '会取消当前回合;队列里能与它合并的条目会随它同发' },
  { locale: 'en-US', steer: 'Insert queued message 1 now', send: 'Send now: queued message 2', steerTitle: 'Doesn’t stop the agent; it sees this at its next step', sendTitle: 'Cancels the active turn; queued entries that can merge with this one go in the same message' },
])('triggers each real action by its accessible name and queue position in $locale', async ({ locale, steer, send, steerTitle, sendTitle }) => {
  const h = await mount(PROMPTS, 640, locale);
  const steerButton = page.getByRole('button', { name: steer, exact: true });
  const sendButton = page.getByRole('button', { name: send, exact: true });
  expect(steerButton.query()).not.toBeNull();
  expect(sendButton.query()).not.toBeNull();
  expect(steerButton.query()!.getAttribute('title')).toBe(steerTitle);
  expect(sendButton.query()!.getAttribute('title')).toBe(sendTitle);
  await steerButton.click();
  expect(h.onSendNow).toHaveBeenCalledExactlyOnceWith('q1');
  await sendButton.click();
  expect(h.onSendNow).toHaveBeenNthCalledWith(2, 'q2');
  expect(h.onSendNow).toHaveBeenCalledTimes(2);
  expect(h.onStop).not.toHaveBeenCalled();
});

it('deletes only the selected ID and updates the remaining action position', async () => {
  const h = await mount();
  await page.getByRole('button', { name: '删除排队提示', exact: true }).nth(0).click();
  await until('only selected queue entry is removed', () => h.row('q1') == null);
  expect(h.onDelete).toHaveBeenCalledExactlyOnceWith('q1');
  expect(h.row('q2')).not.toBeNull();
  expect(page.getByRole('button', { name: '立即发送第 1 条排队消息', exact: true }).query()).not.toBeNull();
  expect(page.getByRole('button', { name: '立即发送第 2 条排队消息', exact: true }).query()).toBeNull();
});

it('reorders with the keyboard and actual drag events', async () => {
  const h = await mount();
  const handle = h.row('q1').querySelector<HTMLButtonElement>('[draggable]')!;
  handle.focus(); await userEvent.keyboard('{ArrowDown}');
  expect(h.onReorder).toHaveBeenLastCalledWith(['q2', 'q1']);
  await until('keyboard order rendered', () => host!.querySelector<HTMLElement>('[data-queued-prompt-id]')?.dataset.queuedPromptId === 'q2');
  expect(page.getByRole('button', { name: '立即发送第 1 条排队消息', exact: true }).query()).not.toBeNull();
  expect(page.getByRole('button', { name: '现在插入第 2 条排队消息', exact: true }).query()).not.toBeNull();
  const dataTransfer = new DataTransfer();
  h.row('q1').querySelector('[draggable]')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
  await until('drag is genuinely active', () => h.row('q1').hasAttribute('data-dragging'));
  const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
  h.row('q2').dispatchEvent(over);
  expect(over.defaultPrevented).toBe(true);
  h.row('q2').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
  expect(h.onReorder).toHaveBeenLastCalledWith(['q1', 'q2']);
});

it('drops an editor when its real queued item is removed', async () => {
  const h = await mount();
  h.row('q1').querySelector<HTMLButtonElement>('button:not([draggable])')!.click();
  await until('queue edit mode begins', () => page.getByRole('button', { name: '保存', exact: true }).query() != null);
  h.replace([PROMPTS[1]]);
  await until('removed message exits edit mode', () => page.getByRole('button', { name: '保存', exact: true }).query() == null);
  expect(h.onEdit).not.toHaveBeenCalled();
});

it.each([194, 640])('keeps long queue text clear of actions and bounds many entries at %ipx', async (width) => {
  const prompts = Array.from({ length: 18 }, (_, i) => ({ ...PROMPTS[0], id: `q${i}`, text: '很长的排队消息 '.repeat(60) }));
  const h = await mount(prompts, width);
  const row = h.row('q0');
  const text = row.querySelector<HTMLButtonElement>('button:not([draggable])')!;
  const send = page.getByRole('button', { name: '现在插入第 1 条排队消息', exact: true }).query()!;
  expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(send.getBoundingClientRect().left);
  const list = host!.querySelector<HTMLElement>('[role="list"]')!;
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  expect(list.getBoundingClientRect().height).toBeLessThanOrEqual(innerHeight * .3 + 1);
  expect(list.scrollWidth).toBe(list.clientWidth);
});

it('restores the main draft after either saving or cancelling the queue edit', async () => {
  const h = await mount();
  await until('main editor is ready', () => h.editor.current != null);
  h.editor.current!.setText('原来正在写的草稿\n第二行');
  await page.getByRole('button', { name: '编辑第 1 条提示', exact: true }).click();
  await until('queue edit loaded', () => h.editor.current?.getText() === PROMPTS[0].text);
  await fillEditor('取消的修改');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await until('cancel restores the original draft', () => h.editor.current?.getText() === '原来正在写的草稿\n第二行');
  expect(h.onEdit).not.toHaveBeenCalled();
  await page.getByRole('button', { name: '编辑第 1 条提示', exact: true }).click();
  await until('second edit loaded', () => h.editor.current?.getText() === PROMPTS[0].text);
  await fillEditor('保存后的消息');
  await userEvent.keyboard('{Enter}');
  expect(h.onEdit).toHaveBeenCalledExactlyOnceWith('q1', '保存后的消息');
  await until('save restores the original draft', () => h.editor.current?.getText() === '原来正在写的草稿\n第二行');
});

it('keeps an asynchronous runtime edit in the main editor until acknowledgement, including a failed save', async () => {
  registerSessionLocaleResources();
  const t = i18n.getFixedT('zh-CN', 'session');
  const editor = createRef<PromptEditorRef>();
  const submit = vi.fn(); const finish = vi.fn();
  let acknowledge!: (success: boolean) => void;
  function Controlled() {
    const [edit, setEdit] = useState<{ id: string; text: string; originalDraftText: string; pending: boolean } | null>(null);
    acknowledge = (success) => setEdit((e) => success ? null : e ? { ...e, pending: false } : null);
    return <MessageProvider locale="zh-CN" translate={(key, values) => t(key, { ...values, interpolation: { prefix: '{', suffix: '}' } })}>
      <ChatComposer isWorking editorApiRef={editor} onSubmit={submit} onSubmitWhileWorking={submit}
        queuedPrompts={PROMPTS} queuedPromptEdit={edit} onEditQueuedPrompt={() => {}}
        onDeleteQueuedPrompt={() => {}} onReorderQueuedPrompts={() => {}} onSendQueuedPromptNow={() => {}}
        onBeginEditQueuedPrompt={(id) => setEdit({ id, text: PROMPTS[0].text, originalDraftText: '原草稿', pending: false })}
        onChangeQueuedPromptEdit={(text) => setEdit((e) => e ? { ...e, text } : null)}
        onFinishQueuedPromptEdit={(text) => { finish(text); setEdit((e) => e ? { ...e, pending: true } : null); }} />
    </MessageProvider>;
  }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); root.render(<Controlled />);
  await until('controlled composer ready', () => editor.current != null);
  editor.current!.setText('原草稿');
  await page.getByRole('button', { name: '编辑第 1 条提示', exact: true }).click();
  await until('controlled queued text loaded', () => editor.current?.getText() === PROMPTS[0].text);
  await fillEditor('未确认的修改');
  await userEvent.keyboard('{Enter}');
  expect(finish).toHaveBeenCalledExactlyOnceWith('未确认的修改');
  expect(editor.current!.getText()).toBe('未确认的修改');
  expect(submit).not.toHaveBeenCalled();
  acknowledge(false);
  await until('failed save is editable again', () => page.getByTestId('prompt-editor').query()?.getAttribute('contenteditable') === 'true');
  expect(editor.current!.getText()).toBe('未确认的修改');
  acknowledge(true);
  await until('acknowledged save restores original draft', () => editor.current?.getText() === '原草稿');
});

it('keeps a not-yet-connected queue entry read-only without restoring an inline editor', async () => {
  const h = await mount([{ ...PROMPTS[0], locked: true }, PROMPTS[1]]);
  expect(h.row('q1').querySelector('button')).toBeNull();
  expect(h.row('q1').textContent).toContain('第一条原文');
  expect(h.row('q1').querySelector('[draggable="true"]')).toBeNull();
  expect(host!.querySelector('textarea')).toBeNull();
  expect(h.onEdit).not.toHaveBeenCalled();
});

it('reorders real queue ids around a locked startup display entry', async () => {
  const h = await mount([PROMPTS[0], { id: 'startup', text: 'waiting for runtime identity', origin: 'manual', locked: true }, PROMPTS[1]]);
  const handle = h.row('q1').querySelector<HTMLButtonElement>('[draggable]')!;
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(h.onReorder).toHaveBeenLastCalledWith(['q2', 'q1']);
  expect(h.row('startup').querySelector('button')).toBeNull();
});
