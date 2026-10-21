/**
 * 页签的状态(会话的「运行中」转圈、编辑器脏点、git 图标、App 角标)与关闭钮 × 同坑:× 露面时状态让开,❌ 两个叠成一团。
 * owner 实机圈出:活动页签的 × 常驻,「运行中」只在悬浮时让开 —— 不悬浮时两个叠在一起。
 *
 * 真 Chromium、真 CSS、真组件(TabStripShell + TabSlot + TabChip):判的是计算出来的不透明度。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, it } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { File } from '@/lib/icons';
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

const LABELS = ['running-session', 'notes.md'];

async function mountStrip(active: string): Promise<HTMLElement[]> {
  host = document.createElement('div');
  host.className = 'emlight gugu-skin';
  host.style.width = '900px';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <TabStripShell trailingSlot={<button style={{ width: 28, height: 28 }}>+</button>}>
      {LABELS.map((label) => (
        <TabSlot key={label}>
          <TabChip
            isActive={label === active}
            label={label}
            preSlot={<File className="size-3" />}
            closeLabel={`Close ${label}`}
            statusSlot={<span data-status={label} style={{ display: 'block', width: 8, height: 8 }} />}
            onClose={() => undefined}
            data-tabid={label}
          />
        </TabSlot>
      ))}
    </TabStripShell>
  );
  const container = host;
  const chips = () => [...container.querySelectorAll<HTMLElement>('[data-tabid]')];
  await until(
    'both tabs render in full density',
    () => chips().map((chip) => chip.dataset.tabDensity),
    (densities) => densities.length === LABELS.length && densities.every((density) => density === 'full')
  );
  return chips();
}

/** 元素真正画出来的不透明度 = 它与所有祖先 opacity 的乘积(状态被包了一层,让开的是外层)。 */
function paintedOpacity(el: Element, stop: Element): number {
  let value = 1;
  for (let node: Element | null = el; node && node !== stop.parentElement; node = node.parentElement) {
    value *= Number.parseFloat(getComputedStyle(node).opacity);
  }
  return value;
}

function parts(chip: HTMLElement) {
  return {
    status: chip.querySelector<HTMLElement>('[data-status]')!,
    close: chip.querySelector<HTMLElement>('button[aria-label^="Close"]')!,
  };
}

async function settled(chip: HTMLElement, expected: { status: number; close: number }) {
  const { status, close } = parts(chip);
  await until(
    `${chip.dataset.tabid}: status ${expected.status} / × ${expected.close}`,
    () => ({ status: paintedOpacity(status, chip), close: paintedOpacity(close, chip) }),
    (now) => now.status === expected.status && now.close === expected.close
  );
}

async function pointerAway(chips: HTMLElement[]) {
  const frame = (window.frameElement as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0 };
  const box = chips[0]!.getBoundingClientRect();
  const session = cdp() as unknown as { send: (method: string, params: object) => Promise<unknown> };
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frame.left + box.left + 4, y: frame.top + box.bottom + 80 });
}

it('the active tab shows only the ×, its status yields even when the pointer is elsewhere', async () => {
  const chips = await mountStrip('running-session');
  await pointerAway(chips);
  await settled(chips[0]!, { status: 0, close: 1 });
});

it('an inactive tab at rest shows its status; hovering swaps it for the ×', async () => {
  const chips = await mountStrip('running-session');
  const inactive = chips[1]!;
  await pointerAway(chips);
  await settled(inactive, { status: 1, close: 0 });
  await userEvent.hover(inactive);
  await settled(inactive, { status: 0, close: 1 });
});
