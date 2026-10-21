import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { setLocalePreference } from '@/i18n';
import { SidePanelSplit } from '@renderer/lib/layout/side-panel-split';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';

// 右侧面板的分隔:一条**通高**的 1px 线 + 一条**通高**的拖拽命中带。会话页、新建会话页、
// 项目首页用的都是这一个 SidePanelSplit。
//
// owner 2026-09-25 报新建会话页:「一个没有分界线的悬空把手」—— 那一页当时另有一套分栏,
// 把手被缩成 40px 高、垂直居中的一截(#6303),分隔线也就只剩那一截。判据因此咬**渲染后的
// 真几何**:线和命中带都从分栏区顶端到底端,上下两头按下去都抓得住。

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const HOST_WIDTH = 1000;
const HOST_HEIGHT = 500;

beforeEach(async () => {
  await page.viewport(1200, 700);
  document.body.style.margin = '0';
  container = document.createElement('div');
  container.className = 'gugu-skin';
  container.style.width = `${HOST_WIDTH}px`;
  container.style.height = `${HOST_HEIGHT}px`;
  document.body.appendChild(container);
  localStorage.clear();
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

/** 会话页的调用方式:分隔条的名字由调用方用会话页文案表给(session-main-column 同此)。 */
function SessionPageSplit({ workspaceHidden }: { workspaceHidden: boolean }) {
  const { translate } = useSessionMessages();
  return (
    <SidePanelSplit
      form={workspaceHidden ? 'closed' : 'side'}
      resizeLabel={translate('task.resizeWorkspacePanel')}
      chatColumn={<div data-testid="composer" className="h-full" />}
      workspacePanel={<div data-testid="workspace" className="h-full" />}
    />
  );
}

function renderSplit(workspaceHidden: boolean) {
  root!.render(
    <SessionLocalizationProvider>
      <SessionPageSplit workspaceHidden={workspaceHidden} />
    </SessionLocalizationProvider>
  );
}

const handle = () => container!.querySelector<HTMLElement>('[data-panel-resize-handle]');
const dividerLine = () =>
  container!.querySelector<HTMLElement>('[data-testid="session-workspace-panel"] > [aria-hidden="true"]');
const workspaceWidth = () =>
  container!.querySelector('[data-testid="session-workspace-panel"]')?.getBoundingClientRect().width ?? 0;

/** 展开是弹簧动画:先等面板有宽度,再等它连续几帧不动才读几何。 */
async function settled() {
  await until('workspace panel has width', () => workspaceWidth() > 0);
  await untilStable('workspace panel stops moving', workspaceWidth);
}

describe('右侧面板分隔线', () => {
  it('展开时分隔线与拖拽命中带都通高,上下两头都抓得住', async () => {
    renderSplit(false);
    await settled();

    const host = container!.getBoundingClientRect();
    const line = dividerLine()!.getBoundingClientRect();
    expect(line.width).toBe(1);
    expect(line.top).toBe(host.top);
    expect(line.height).toBe(HOST_HEIGHT);
    expect(getComputedStyle(dividerLine()!).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');

    const strip = handle()!.getBoundingClientRect();
    expect(strip.top).toBe(host.top);
    expect(strip.height).toBe(HOST_HEIGHT);
    expect(getComputedStyle(handle()!).cursor).toBe('col-resize');
    // 命中带骑在线上:线的横坐标落在命中带里。
    expect(line.left).toBeGreaterThanOrEqual(strip.left);
    expect(line.right).toBeLessThanOrEqual(strip.right);

    const x = line.left + line.width / 2;
    for (const y of [host.top + 4, host.top + HOST_HEIGHT / 2, host.bottom - 4]) {
      expect(document.elementFromPoint(x, y)).toBe(handle());
    }
  });

  // 英文界面读屏念中文 —— 分隔条的无障碍名曾经写死「调整工作区面板宽度」(mac1 实测,#6473 后续)。
  it('分隔条的无障碍名跟着界面语言走', async () => {
    setLocalePreference('en-US');
    renderSplit(false);
    await until('handle mounted', () => handle() != null);
    await until('english label', () => handle()!.getAttribute('aria-label') === 'Resize Files panel');

    setLocalePreference('zh-CN');
    await until('chinese label', () => handle()!.getAttribute('aria-label') === '调整工作区面板宽度');
  });

  it('收起时既不画线也不留把手', async () => {
    renderSplit(true);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(handle()).toBeNull();
    expect(workspaceWidth()).toBe(0);
    const host = container!.getBoundingClientRect();
    const atRightEdge = document.elementFromPoint(host.right - 2, host.top + HOST_HEIGHT / 2);
    expect(atRightEdge?.closest('[role="separator"]')).toBeNull();
  });
});
