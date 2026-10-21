/**
 * #6264 窄页签:~500px 的工作区分栏里三枚页签,标题要读得出(「文件」「端口」「notes.md」),❌ 「打.」「端.」。
 * 照 Chrome / VS Code:窄了之后非活动页签的关闭钮不占位(悬浮才浮出来),活动页签留着;再窄只剩图标。
 *
 * 真 Chromium、真 CSS、真组件(TabStripShell + TabSlot + TabChip):要判的是布局算出来的宽度,
 * 只有真引擎给得出。右侧那组按钮按真实几何占位(两枚 28px 钮 + 预留),与会话页同形。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { FileText, Cable, File } from '@/lib/icons';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { tabDensity } from '@renderer/features/tabs/tab-bar/tab-density';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  delete document.documentElement.dataset.theme;
  document.documentElement.classList.remove('dark');
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

const ICONS = { 文件: <FileText className="size-3" />, 端口: <Cable className="size-3" />, 'notes.md': <File className="size-3" /> };

async function mountStrip(width: number, labels: string[], active: string, theme: 'light' | 'dark' = 'light', withStatus = false) {
  host = document.createElement('div');
  // 会话页的主题作用域(与真 app 同一组类名):页签条、页签底色、悬浮叠色都从这里取。
  host.className = `${theme === 'dark' ? 'emdark' : 'emlight'} gugu-skin`;
  host.style.width = `${width}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <TabStripShell
      trailingSlot={<button style={{ width: 28, height: 28 }}>+</button>}
      actionsSlot={<div style={{ width: 120, flexShrink: 0 }} />}
    >
      {labels.map((label) => (
        <TabSlot key={label}>
          <TabChip
            isActive={label === active}
            label={label}
            preSlot={ICONS[label as keyof typeof ICONS] ?? <File className="size-3" />}
            closeLabel={`Close ${label}`}
            // An App tab's badge / an editor's dirty dot: the status the close button sits on.
            statusSlot={withStatus ? <span data-status={label} /> : undefined}
            onClose={() => undefined}
            data-tabid={label}
          />
        </TabSlot>
      ))}
    </TabStripShell>
  );
  // ResizeObserver 回调 + 重新渲染都落地 = 每枚页签的档位与它此刻的宽度对上(页签根节点就是被观测的那个,自身无内边距)。
  const container = host;
  const chips = () => [...container.querySelectorAll<HTMLElement>('[data-tabid]')];
  await until(
    'every tab density matches its measured width',
    () => chips().map((chip) => [chip.dataset.tabDensity, tabDensity(Math.round(chip.getBoundingClientRect().width), true)]),
    (pairs) => pairs.length === labels.length && pairs.every(([rendered, measured]) => rendered === measured)
  );
  return chips();
}

function titleOf(chip: HTMLElement): HTMLElement | null {
  return chip.querySelector<HTMLElement>('span.truncate');
}

it('three tabs in a ~500px pane keep their titles readable', async () => {
  const chips = await mountStrip(500, ['文件', '端口', 'notes.md'], 'notes.md');
  for (const chip of chips) {
    const title = titleOf(chip);
    expect(title, chip.dataset.tabid).not.toBeNull();
    // 标题没被截断:内容宽度不超过可视宽度。
    expect(title!.scrollWidth, `${chip.dataset.tabid} is cut`).toBeLessThanOrEqual(title!.clientWidth + 1);
  }
  // 非活动页签的关闭钮不占位(浮起来),活动页签的关闭钮照旧在行内。
  const inactive = chips.find((chip) => chip.dataset.tabid === '文件')!;
  expect(inactive.dataset.tabDensity).toBe('compact');
  expect(inactive.querySelector('[data-tab-close-floating]')).not.toBeNull();
  const active = chips.find((chip) => chip.dataset.tabid === 'notes.md')!;
  expect(active.querySelector('[data-tab-close-floating]')).toBeNull();
});

it('a wide pane keeps the full layout', async () => {
  const chips = await mountStrip(1000, ['文件', '端口', 'notes.md'], 'notes.md');
  expect(chips.every((chip) => chip.dataset.tabDensity === 'full')).toBe(true);
});

it('many tabs go icon-only with the full name in the tooltip, then the strip scrolls', async () => {
  const labels = Array.from({ length: 14 }, (_, i) => `file-${i}.ts`);
  const chips = await mountStrip(600, labels, 'file-0.ts');
  const inactive = chips[3]!;
  expect(inactive.dataset.tabDensity).toBe('icon');
  expect(titleOf(inactive)).toBeNull();
  expect(inactive.getAttribute('title')).toBe('file-3.ts');
});

// 摩擦单 F98 (L6, twice): on an icon-only tab the × floated over the middle on hover, so a click meant to switch to it
// closed it. As in Chrome, an inactive icon-only tab has no ×; the active one keeps it (middle click and the menu close
// either).
it.each([false, true])('an inactive icon-only tab has no close button to hit; the active one keeps it (status: %s)', async (withStatus) => {
  const labels = Array.from({ length: 14 }, (_, i) => `file-${i}.ts`);
  const chips = await mountStrip(600, labels, 'file-0.ts', 'light', withStatus);
  const inactive = chips[3]!;
  expect(inactive.dataset.tabDensity).toBe('icon');
  expect(inactive.querySelector('[aria-label="Close file-3.ts"]')).toBeNull();
  // The App tab's case (it always has a badge slot): the status is still drawn, just no × on it.
  if (withStatus) expect(inactive.querySelector('[data-status="file-3.ts"]')).not.toBeNull();
  const active = chips[0]!;
  expect(active.querySelector('[aria-label="Close file-0.ts"]')).not.toBeNull();
});

/** 截这一枚页签的图,读回像素(PNG → canvas)。 */
async function pixelsOf(el: HTMLElement): Promise<{ at: (x: number, y: number) => [number, number, number]; scale: number }> {
  const shot = (await page.screenshot({ element: el, save: false, base64: true } as never)) as unknown;
  const base64 = typeof shot === 'string' ? shot : (shot as { base64: string }).base64;
  const img = new Image();
  img.src = `data:image/png;base64,${base64}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const scale = img.width / el.getBoundingClientRect().width;
  return {
    scale,
    at: (x, y) => {
      const d = ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data;
      return [d[0]!, d[1]!, d[2]!];
    },
  };
}

const close = (a: [number, number, number], b: [number, number, number]) => a.every((v, i) => Math.abs(v - b[i]!) <= 3);

/** 按住鼠标(真 :active)—— 经 CDP 在测试 iframe 的偏移上按下,松开由调用方负责。 */
async function holdMouse(el: HTMLElement): Promise<() => Promise<void>> {
  const frame = (window.frameElement as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const box = el.getBoundingClientRect();
  const x = frame.left + box.left + 4;
  const y = frame.top + box.top + box.height / 2;
  const session = cdp() as unknown as { send: (method: string, params: object) => Promise<unknown> };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  return async () => {
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
}

/** 把指针挪到页签条下面:上一个测试文件可能把它停在某枚页签上,那枚页签就带着悬浮色。 */
async function movePointerBelow(el: HTMLElement) {
  const frame = (window.frameElement as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const box = el.getBoundingClientRect();
  const session = cdp() as unknown as { send: (method: string, params: object) => Promise<unknown> };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frame.left + box.left + 4, y: frame.top + box.bottom + 40 });
}

/**
 * 等悬浮 / 按下(或它们撤掉)真落到样式上、过渡放完再截图。
 * 两帧:伪类状态变了之后要经过一次样式重算,过渡才被创建,getAnimations 才看得见它们。
 */
async function settle(el: HTMLElement, selector: string) {
  await until(`${selector} lands on the tab`, () => el.matches(selector));
  for (let i = 0; i < 2; i += 1) await new Promise(requestAnimationFrame);
  const transitions = el.getAnimations({ subtree: true }).filter((animation) => animation instanceof CSSTransition);
  await Promise.all(transitions.map((transition) => transition.finished));
}

// 接缝:关闭钮浮起来时 ❌ 垫任何底 —— 钮下透出的必须是页签此刻的真实底色(悬浮、按下,明暗两套)。
for (const theme of ['light', 'dark'] as const) {
  for (const state of ['hovered', 'pressed'] as const) {
    it(`the floating close button sits on the tab's own background, no seam (${theme}, ${state})`, async () => {
      document.documentElement.dataset.theme = theme;
      if (theme === 'dark') document.documentElement.classList.add('dark');
      const chips = await mountStrip(500, ['a-very-long-file-name.ts', '端口', 'notes.md'], 'notes.md', theme);
      const chip = chips[0]!;
      expect(chip.dataset.tabDensity).toBe('compact');
      // 对照:静止的非活动页签透出的就是贴条底色 —— 先确认它真是静止的,❌ 带着上一个文件留下的悬浮色。
      await movePointerBelow(chips[1]!);
      await settle(chips[1]!, ':not(:hover)');
      const strip = (await pixelsOf(chips[1]!)).at(2, chips[1]!.getBoundingClientRect().height / 2);
      await userEvent.hover(chip);
      const release = state === 'pressed' ? await holdMouse(chip) : null;
      try {
        await settle(chip, state === 'pressed' ? ':active' : ':hover');
        const button = chip.querySelector<HTMLElement>('[data-tab-close-floating]')!;
        expect(Number.parseFloat(getComputedStyle(button).opacity)).toBe(1);
        const chipBox = chip.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        const px = await pixelsOf(chip);
        // 页签此刻的底色:左边内边距里一点(那里什么都没画)。
        const background = px.at(2, chipBox.height / 2);
        // 悬浮/按下的底色必须 ≠ 贴条底色,否则这条测试分不出「垫了一块贴条色」。
        expect(close(background, strip), `${theme}/${state}: tab face must differ from the strip`).toBe(false);
        // 关闭钮外框的左、上、下三条边(× 画在正中,不碰边):全是页签底色 —— 没有垫底的圆,也没有标题笔画漏出来。
        const left = box.left - chipBox.left + 1;
        const top = box.top - chipBox.top + 1;
        const bottom = box.bottom - chipBox.top - 2;
        for (let y = top; y <= bottom; y += 1) {
          expect(close(px.at(left, y), background), `${theme}/${state} seam at (${left},${y})`).toBe(true);
        }
        for (let x = left; x < box.right - chipBox.left - 1; x += 1) {
          expect(close(px.at(x, top), background), `${theme}/${state} seam at (${x},${top})`).toBe(true);
          expect(close(px.at(x, bottom), background), `${theme}/${state} seam at (${x},${bottom})`).toBe(true);
        }
        // 标题淡出:钮左边紧挨着的一列也没有字。
        expect(close(px.at(left - 2, chipBox.height / 2), background), `${theme}/${state} title shows under the button`).toBe(true);
      } finally {
        await release?.();
      }
    });
  }
}
