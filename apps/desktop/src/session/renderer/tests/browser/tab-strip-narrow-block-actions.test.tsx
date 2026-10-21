/**
 * 一屏三块时一块只有 ~320px(10-10 实测 323):编程模式那条页签条右端有换模型那颗(「咕咕 DeepSeek V4 Pro 极高」约 190px)
 * 加输出 / 分享 / 关闭这一块,一共近 300px —— 任务名那枚页签被挤到 0,整枚躲进「全部页签」,页签条上看不见是哪条任务。
 * 窄了之后换模型那颗只剩厂商图形(同输入框底排档 6),页签至少剩「图标加一个字」(spec session-page「一格最窄」)。
 *
 * 真 Chromium、真 CSS、真页签条(TabStripShell + TabSlot + TabChip);右端那组按真实结构与宽度搭:
 * 换模型那颗的厂商图形 / 名字 / 强度三格与 ComposerModelMenu 的 data-slot 同名;模式按钮(#7167)的图标 / 名字
 * 与 SessionModeMenu 的 test-id、data-slot 同名。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { MessageSquare } from '@/lib/icons';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

function BlockActions() {
  return (
    <div data-tabbar-actions="" style={{ display: 'flex', flexShrink: 0, alignItems: 'center', gap: 4 }}>
      <span data-testid="terminal-model-switch" style={{ display: 'flex', alignItems: 'center' }}>
        <button data-testid="composer-model-trigger" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', height: 28 }}>
          <span aria-hidden="true" style={{ display: 'flex', width: 14, height: 14 }} data-vendor-icon="" />
          <span data-slot="composer-model-trigger-label">咕咕 DeepSeek V4 Pro</span>
          <span data-slot="composer-effort">极高</span>
        </button>
      </span>
      <button style={{ width: 28, height: 28, flexShrink: 0 }} aria-label="输出/来源" />
      <button style={{ width: 28, height: 28, flexShrink: 0 }} aria-label="分享" />
      <button data-testid="session-mode-trigger" style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', height: 32 }}>
        <svg data-mode-icon="" width="16" height="16" />
        <span data-slot="session-mode-label">通用</span>
      </button>
      <button style={{ width: 24, height: 24, flexShrink: 0 }} aria-label="关闭这一块" />
    </div>
  );
}

async function mountBlockStrip(width: number) {
  host = document.createElement('div');
  host.className = 'emlight gugu-skin';
  host.style.width = `${width}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <TabStripShell trailingSlot={<button style={{ width: 28, height: 28 }}>+</button>} actionsSlot={<BlockActions />}>
      <TabSlot>
        <TabChip isActive label="用三句话介绍一下咕咕是做什么的" preSlot={<MessageSquare className="size-3" />} closeLabel="关闭" onClose={() => undefined} data-tabid="chat" />
      </TabSlot>
    </TabStripShell>
  );
  const container = host;
  const bar = () => container.querySelector<HTMLElement>('.session-tab-bar');
  // 画出来以后再等几帧:ResizeObserver 的回调、因它而起的重渲染与重排都落地了再量 —— ❌ 等某个标记出现,
  // 判据要落在「页签露出多少」这个结果上,不是落在实现挂没挂标记上。
  await until('strip rendered', () => container.querySelector('[data-tabid="chat"]') !== null);
  for (let i = 0; i < 4; i += 1) await new Promise(requestAnimationFrame);
  const label = container.querySelector<HTMLElement>('[data-slot="composer-model-trigger-label"]')!;
  const chip = container.querySelector<HTMLElement>('[data-tabid="chat"]')!;
  return { bar: bar()!, label, chip };
}

/** 页签在页签条的可视范围里露出多宽(滚动区是裁剪盒,滚出去的部分不算)。 */
function visibleWidth(chip: HTMLElement): number {
  const scroller = chip.closest<HTMLElement>('.overflow-x-auto')!;
  const s = scroller.getBoundingClientRect();
  const c = chip.getBoundingClientRect();
  return Math.max(0, Math.min(c.right, s.right) - Math.max(c.left, s.left));
}

it('a ~320px block: the model button folds to its vendor icon and the task tab stays on the strip', async () => {
  const { bar, label, chip } = await mountBlockStrip(323);
  // 结果先判:任务名那枚页签露在条上,至少是最窄档(图标加一个字,44px)。
  expect(visibleWidth(chip), 'task tab visible on the strip').toBeGreaterThanOrEqual(44);
  expect(bar.hasAttribute('data-strip-narrow')).toBe(true);
  expect(getComputedStyle(label).display).toBe('none');
  expect(getComputedStyle(bar.querySelector('[data-slot="composer-effort"]')!).display).toBe('none');
  // 厂商图形还在:收起的是名字,❌ 整颗按钮。
  expect(bar.querySelector<HTMLElement>('[data-vendor-icon]')!.getBoundingClientRect().width).toBeGreaterThan(0);
  // 模式按钮同一档让位:名字收起,图标还在(#7167)。
  expect(getComputedStyle(bar.querySelector('[data-slot="session-mode-label"]')!).display).toBe('none');
  expect(bar.querySelector<SVGElement>('[data-mode-icon]')!.getBoundingClientRect().width).toBeGreaterThan(0);
});

it('a two-block screen half (~600px) folds too: the mode button joined the strip, so the task tab keeps its share', async () => {
  // 1280 宽的窗口分两块,一块约 600 出头(去掉左栏):右端多了模式按钮,门槛跟着抬,页签那截不替它让位。
  const { bar, chip } = await mountBlockStrip(590);
  expect(bar.hasAttribute('data-strip-narrow')).toBe(true);
  expect(visibleWidth(chip), 'task tab visible on the strip').toBeGreaterThanOrEqual(44);
});

it('a wide block keeps the model name', async () => {
  const { bar, label, chip } = await mountBlockStrip(900);
  expect(bar.hasAttribute('data-strip-narrow')).toBe(false);
  expect(getComputedStyle(label).display).not.toBe('none');
  expect(getComputedStyle(bar.querySelector('[data-slot="session-mode-label"]')!).display).not.toBe('none');
  expect(visibleWidth(chip)).toBeGreaterThan(100);
});

it('without a vendor icon the model name stays (no empty button)', async () => {
  const { bar, label } = await mountBlockStrip(323);
  bar.querySelector('[data-vendor-icon]')!.remove();
  await new Promise(requestAnimationFrame);
  expect(getComputedStyle(label).display).not.toBe('none');
});
