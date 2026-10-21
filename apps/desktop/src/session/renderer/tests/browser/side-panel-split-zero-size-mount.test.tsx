import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePanelRef } from 'react-resizable-panels';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { SidePanelSplit } from '@renderer/lib/layout/side-panel-split';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

// 会话页分栏在**零尺寸下挂载**之后的收敛 —— owner 报的原样:「点击 task tab 里的右侧边栏展开再折叠,
// 中间那个消息气泡列表的位置就和原先不一样了;原先是靠左的,操作完之后是居中的」。
//
// 常驻会话页实例在用户待在别的咕咕 tab 时是 0×0(MainLayout「隐藏槽 = 零 rect」)。分栏组若在那个
// 窗口里注册,react-resizable-panels 把布局记成「待定」,首次量到真实尺寸时按各面板声明的 defaultSize
// 重新推导 —— 挂载时那次 collapse() 被丢掉。于是工作区面板占着 33% 却什么都不画(收起态不渲染空面板、
// 分隔线也不画),聊天栏只剩 67%,而消息列是在聊天栏里居中的 —— 看上去就是整体偏左。手动展开再收起
// (此时组已量过真实尺寸)才回到 100%,也就是 owner 描述的「操作完之后是居中的」。
//
// SidePanelSplit(原 SessionSplit)后来不再用 react-resizable-panels(宽度改由 motion value 持有,见 panel-motion.ts),
// 但**零尺寸挂载**这条路径还在:新实现靠「量到 0 就不当真」躲开它。这份判据因此照旧有效,
// 而且它咬的是产品行为(显示出来之后聊天栏必须占满),不是某一个库的写法。
//
// 判据咬**渲染后的真几何**(getBoundingClientRect),不是 class 串。最后一条是阳性对照:用
// react-resizable-panels 原样搭一遍,只去掉「等组量出宽度再下命令」那道闸 —— 它必须在这里变红,
// 否则前面几条可能只是恒真。

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const HOST_WIDTH = 1000;

beforeEach(async () => {
  await page.viewport(1200, 700);
  container = document.createElement('div');
  // 挂在 `.gugu-skin` 里,和会话页真身同一份级联。
  container.className = 'gugu-skin';
  container.style.width = `${HOST_WIDTH}px`;
  container.style.height = '500px';
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

const widthOf = (testId: string) => () => {
  const node = container!.querySelector(`[data-testid="${testId}"]`);
  return node ? node.getBoundingClientRect().width : null;
};
const chatWidth = widthOf('session-chat-panel');
const workspaceWidth = widthOf('session-workspace-panel');
/** 分隔条现在是**脱离文档流**的(绝对定位骑在面板边界上),所以两栏分的是整条宽度。
 *  它仍必须真的画出来 —— 拖不动的分栏等于没有分栏。 */
const handleRect = () => {
  const node = container!.querySelector('[data-panel-resize-handle]') as HTMLElement | null;
  return node ? node.getBoundingClientRect() : null;
};

/**
 * 等版面**停下来**再读数,而不是等它到达某个值 —— 后者会让轮询自己把断言做了。
 * 停 = 连续 {@link STABLE_FRAMES} 个渲染帧读到同一对宽度(分栏组注册前有一段短暂的 50/50,
 * 单次相等挡不住它;展开/收起是弹簧动画,每帧都在动)。
 * @@@frame-quiescence - 按**帧**数稳定,不按毫秒:同一帧里读两次必然相同,按轮询次数算会把
 * 动画半途当成停下;而机器越忙帧越慢,按帧算只会更保守,不会因为负载误判(#4357)。
 */
const STABLE_FRAMES = 5;
async function settled() {
  let frames = 0;
  let counting = true;
  const tick = () => {
    frames += 1;
    if (counting) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  let previous = '';
  let previousFrame = -1;
  let stableFrames = 0;
  try {
    await until('split layout stops moving', () => {
      if (frames === previousFrame) return false;
      previousFrame = frames;
      const current = `${chatWidth()}/${workspaceWidth()}`;
      if (current.includes('null')) {
        stableFrames = 0;
        previous = '';
        return false;
      }
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      return stableFrames >= STABLE_FRAMES;
    });
  } finally {
    counting = false;
  }
}

/** 视图模型那一侧:会话页默认工作区面板收起,顶栏那枚按钮翻转它。 */
function Host({ split }: { split: (workspaceHidden: boolean) => ReactNode }) {
  const [workspaceHidden, setWorkspaceHidden] = useState(true);
  // 分隔条的无障碍名走会话页文案表,会话页里 SidePanelSplit 始终活在这层 provider 下面。
  return (
    <SessionLocalizationProvider>
      <button
        type="button"
        data-testid="toggle-workspace"
        onClick={() => setWorkspaceHidden((hidden) => !hidden)}
      />
      <div style={{ height: '460px' }}>{split(workspaceHidden)}</div>
    </SessionLocalizationProvider>
  );
}

const realSplit = (workspaceHidden: boolean) => (
  <SidePanelSplit
    form={workspaceHidden ? 'closed' : 'side'}
    resizeLabel="Resize"
    chatColumn={null}
    workspacePanel={null}
  />
);

/**
 * 阳性对照 —— 用 react-resizable-panels 按当年的写法搭一遍(两栏声明、分隔条、onResize 回报),
 * 只去掉「等组量出宽度再下命令」那道闸(`groupMeasured`)。它存在的唯一理由是证明上面的断言不是
 * 恒真:一旦转绿,说明上面已经判不了假。
 */
function UngatedSessionSplit({
  workspaceHidden,
  chatHidden = false,
}: {
  workspaceHidden: boolean;
  chatHidden?: boolean;
}) {
  const chatPanelRef = usePanelRef();
  const workspacePanelRef = usePanelRef();
  const reported = useRef(false);

  useEffect(() => {
    if (workspaceHidden) {
      workspacePanelRef.current?.collapse();
      chatPanelRef.current?.expand();
      return;
    }
    if (chatHidden) {
      chatPanelRef.current?.collapse();
      workspacePanelRef.current?.expand();
      return;
    }
    chatPanelRef.current?.expand();
    workspacePanelRef.current?.expand();
  }, [chatHidden, chatPanelRef, workspaceHidden, workspacePanelRef]);

  const syncChatColumnCollapsed = () => {
    reported.current = chatPanelRef.current?.isCollapsed() ?? false;
  };

  return (
    <div className="flex h-full min-w-0">
      <ResizablePanelGroup orientation="horizontal" id="ungated-chat-workspace" className="flex-1">
        <ResizablePanel
          id="ungated-chat"
          panelRef={chatPanelRef}
          defaultSize="67%"
          minSize="240px"
          collapsible
          collapsedSize="0px"
          onResize={syncChatColumnCollapsed}
        >
          <div data-testid="session-chat-panel" className="flex h-full min-h-0 min-w-0 flex-col" />
        </ResizablePanel>
        <ResizableHandle className={workspaceHidden || chatHidden ? 'hidden' : undefined} />
        <ResizablePanel
          id="ungated-workspace"
          panelRef={workspacePanelRef}
          defaultSize="33%"
          minSize="30%"
          collapsible
          collapsedSize="0px"
        >
          <div
            data-testid="session-workspace-panel"
            className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

/** 在**隐藏**的宿主里挂载(= 用户待在别的咕咕 tab),再显示出来。 */
async function mountWhileHidden(split: (workspaceHidden: boolean) => ReactNode) {
  container!.style.display = 'none';
  root!.render(<Host split={split} />);
  await until('chat panel mounted', () => chatWidth() != null);
  container!.style.display = '';
  await settled();
}

function toggleWorkspace() {
  (container!.querySelector('[data-testid="toggle-workspace"]') as HTMLElement).click();
}

describe('会话页分栏', () => {
  it('在隐藏宿主里挂载,显示出来后聊天栏占满可用宽度', async () => {
    await mountWhileHidden(realSplit);

    // 收起的那一栏必须真的是零宽:否则它占着一块什么都不画的版面,聊天栏被挤窄,
    // 里面居中的消息列就整体偏左 —— 这正是 owner 看到的那一眼。
    expect(workspaceWidth()).toBe(0);
    expect(chatWidth()).toBe(HOST_WIDTH);
  });

  it('展开仍拿到设计的 33%,再收起回到占满', async () => {
    // 这道闸不能是「把面板焊死在零宽」——展开/收起这条正常回路要原样留着。
    await mountWhileHidden(realSplit);

    toggleWorkspace();
    await settled();
    // 分隔条要画出来(可抓),但它不占流内宽度,所以两栏加起来正好是整条。
    expect(handleRect()!.width).toBeGreaterThan(0);
    expect(workspaceWidth()! + chatWidth()!).toBeCloseTo(HOST_WIDTH, 0);
    expect(workspaceWidth()).toBeCloseTo(HOST_WIDTH * 0.33, 0);
    expect(chatWidth()).toBeCloseTo(HOST_WIDTH * 0.67, 0);

    toggleWorkspace();
    await settled();
    expect(workspaceWidth()).toBe(0);
    expect(chatWidth()).toBe(HOST_WIDTH);
  });

  it('在可见宿主里挂载时同样占满(这条路径本来就是对的,不许被这道闸改坏)', async () => {
    root!.render(<Host split={realSplit} />);
    await settled();

    expect(workspaceWidth()).toBe(0);
    expect(chatWidth()).toBe(HOST_WIDTH);
  });

  it('阳性对照:去掉那道闸后,同样的挂载路径确实把聊天栏挤成 67%', async () => {
    await mountWhileHidden((workspaceHidden) => (
      <UngatedSessionSplit workspaceHidden={workspaceHidden} />
    ));

    // 这条一旦转绿,说明上面那三条已经判不了假。
    expect(chatWidth()).toBeCloseTo(HOST_WIDTH * 0.67, 0);
    expect(workspaceWidth()).toBeCloseTo(HOST_WIDTH * 0.33, 0);
  });
});
