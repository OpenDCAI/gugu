import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, type CSSProperties, type DragEvent } from 'react';
import { useGroupRef } from 'react-resizable-panels';
import { X } from '@/lib/icons';
import { ExtensionMark } from '@renderer/features/extensions/extension-mark';
import { ExtensionSharedSlot } from '@renderer/features/extensions/extension-shared-slot';
import { extensionSurfaceStore, extensionTabTitle } from '@renderer/features/extensions/extension-surface-store';
import { installedExtensionsStore } from '@renderer/features/extensions/installed-extensions-store';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import type { PaneLayoutNode } from '@renderer/features/tabs/pane-layout-tree';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@renderer/lib/ui/context-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@renderer/lib/ui/resizable';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import {
  blockDropPreview,
  closeScreenBlock,
  dropOnScreen,
  focusScreenBlock,
  openInWindow,
  resolveBlockDrop,
  setBlockDropPreview,
  takeAppOffScreen,
  blockMinExtent,
  type MentionDrop,
} from './screen-layout-actions';
import { ChatPartSlot, ChatSlot } from '@renderer/lib/chat-slot';
import { ChatTabMenuItems, chatTabHasActions } from '@renderer/features/chats/chat-tab-menu-items';
import { ChatPanes, ChatTabChip } from '@renderer/features/chats/chat-tabs/chat-panes';
import { openPanelItem } from '@renderer/features/chats/chat-tabs/chat-layouts';
import { requestTopicSplit } from '@/lib/topicSplitRequest';
import { ComposerVerbDock } from '@renderer/features/sessions/task-dispatch-composer';
import { ProjectBlock } from './project-block';
import { SampleProjectBlock } from '@renderer/features/sample-project/sample-project-block';
import { screenLayout, type ScreenBlockContent } from './screen-layout';
import { clearDraggedScreenContent, getDraggedScreenContent, hasDraggedScreenContent, setDraggedScreenContent } from '@renderer/lib/drag-screen-content';

/**
 * 这一屏的骨架(spec session-page「一屏几块」):几块怎么分、分界在哪,每块一个占位。
 *
 * 会话页不在这里面:它们一直活在 Workspace 里同一个位置(@@@retained-session-pages),只是用 CSS 锚点
 * 贴到自己那块的占位上 —— 挪块、换块、拖分界都只改位置,页面不重建,终端、网页、App 都不重载。
 * App 自己占的那块画在占位里:它的页本来就住在根层(extension-view-layer),这里只是一个落点。
 */
export const ScreenFrame = observer(function ScreenFrame() {
  const layout = screenLayout.layout;
  if (!layout) return null;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 bg-background-tertiary" data-screen-frame="">
      <BlockTree node={layout} />
    </div>
  );
});

/** 一块的占位贴到哪个锚点名上:会话页按这个名字找到自己那块。 */
export const blockAnchorName = (blockId: string) => `--${blockId}`;

/** 一个会话页贴到它那块上:四条边对齐那块的四条边(CSS 锚点定位,跟着分界逐帧走,不用量)。 */
export const anchoredToBlock = (blockId: string): CSSProperties =>
  ({
    position: 'absolute',
    positionAnchor: blockAnchorName(blockId),
    top: 'anchor(top)',
    bottom: 'anchor(bottom)',
    left: 'anchor(left)',
    right: 'anchor(right)',
  }) as CSSProperties;

/** 一块(或一刀下的几块)最少多宽 / 多高:每块按它里面的格子算(blockMinExtent),顺着排的加起来,横着叠的取最大。 */
function blockTreeMin(node: PaneLayoutNode, axis: 'width' | 'height'): number {
  if (node.type === 'pane') return blockMinExtent(node.paneId, axis);
  const inner = node.children.map((child) => blockTreeMin(child, axis));
  const along = (node.orientation === 'horizontal') === (axis === 'width');
  return along ? inner.reduce((sum, value) => sum + value, 0) + (inner.length - 1) : Math.max(...inner);
}

const childPanelId = (node: PaneLayoutNode) => (node.type === 'pane' ? `block-panel-${node.paneId}` : `block-cut-${node.id}`);

const BlockTree = observer(function BlockTree({ node }: { node: PaneLayoutNode }) {
  if (node.type === 'pane') return <BlockSlot blockId={node.paneId} />;
  return <BlockCut node={node} />;
});

/** 块与块之间一根线(和格与格之间同一种)。拖它改份额,双击 = 等分。 */
const BlockCut = observer(function BlockCut({ node }: { node: Extract<PaneLayoutNode, { type: 'split' }> }) {
  const groupRef = useGroupRef();
  const ids = node.children.map(childPanelId);
  const idsKey = ids.join(',');
  const sizesKey = node.sizes.join(',');

  useEffect(() => {
    const handle = groupRef.current;
    if (!handle) return;
    const wanted = Object.fromEntries(ids.map((id, index) => [id, node.sizes[index] ?? 0]));
    try {
      const current = handle.getLayout();
      if (ids.every((id) => Math.abs((current[id] ?? -1) - wanted[id]) < 0.5)) return;
      handle.setLayout(wanted);
    } catch {
      // Not laid out yet (first paint): its defaultSize already says the same.
    }
    // ids / sizes are read through their keys: a new array every render must not re-run this.
  }, [idsKey, sizesKey, groupRef]);

  // 这一刀下面换了一块(比如占一块的 App 被收走,旁边那一列塌成一块):这组整个重挂,按 node.sizes 重新摆。
  // 不重挂时新挂上的那块进不了库里的布局,只拿到 1% 宽(2026-10-09 实测挤成 19px);库文档给的做法就是按
  // 这组有哪几块换 key(react-resizable-panels v4「Conditional panels」)。块里的东西不怕重挂:会话页是贴上来的,
  // App 的页在共用槽里挪来挪去,都不跟着重建。
  return (
    <ResizablePanelGroup
      key={idsKey}
      orientation={node.orientation}
      groupRef={groupRef}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) screenLayout.setSplitSizes(node.id, ids.map((id) => layout[id] ?? 0));
      }}
    >
      {node.children.map((child, index) => (
        <Fragment key={childPanelId(child)}>
          {index > 0 && (
            // 块与块之间就是一根线,和一条会话里格与格之间、会话列表右边那根同一种(1px border 色),❌ 另起一道粗缝
            // (owner 10-09:先是「怎么会没有任何分割线」—— 透明缝在这层皮里和白底同色;改成 6px 灰带又是
            // 「这么粗的线,你是想干啥?不能统一吗」)。
            // 会话页是贴在块上的另一层,压在这根线两边:线自己抬到那层上面,左右那几 px 的抓手才抓得到(会话列表那根也是这么浮着的)。
            <ResizableHandle className="z-30" onDoubleClick={() => screenLayout.equalizeSplit(node.id)} />
          )}
          <ResizablePanel id={childPanelId(child)} defaultSize={`${node.sizes[index] ?? 0}%`} minSize={`${blockTreeMin(child, node.orientation === 'horizontal' ? 'width' : 'height')}px`}>
            <BlockTree node={child} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
});

/** 一块的占位。会话块是空的(会话页贴在它上面);App 块、项目块在这里画它那条页签条和它的页。 */
const BlockSlot = observer(function BlockSlot({ blockId }: { blockId: string }) {
  const block = screenLayout.blocks.get(blockId);
  return (
    <div
      className="relative flex h-full w-full min-h-0 min-w-0 flex-1 flex-col bg-background"
      style={{ anchorName: blockAnchorName(blockId) } as CSSProperties}
      data-screen-block={blockId}
      onPointerDownCapture={() => focusScreenBlock(blockId)}
    >
      {block?.kind === 'app' ? <AppBlock blockId={blockId} tabKind={block.tabKind} /> : null}
      {block?.kind === 'project' ? (
        <ProjectBlock
          blockId={blockId}
          projectId={block.projectId}
          blockActions={screenLayout.order.length > 1 ? <CloseBlockButton blockId={blockId} /> : null}
        />
      ) : null}
      {block?.kind === 'sample-project' ? (
        <SampleProjectBlock blockId={blockId} blockActions={screenLayout.order.length > 1 ? <CloseBlockButton blockId={blockId} /> : null} />
      ) : null}
      {block?.kind === 'chat' ? <ChatBlock blockId={blockId} chatId={block.chatId} /> : null}
      {block?.kind === 'chat-app' ? <ChatAppBlock blockId={blockId} content={block} /> : null}
    </div>
  );
});

/**
 * 对话块(gugu-dev#181:对话也是一块,⌘ 点拼到右边):和项目块同一条页签条,第一枚是这个对话(头像 + 名字,关不掉);
 * 对话由壳画进格子,头像和名字、右端那排图标(搜索、群文件夹、成员、历史)也由壳画进页签条留的几格。
 * 公告、设置、在本群打开 App 在这枚页签的右键菜单里(右端没有 ⋯)。
 * 屏上不止一块时右端一枚「关闭这一块」。
 */
const ChatBlock = observer(function ChatBlock({ blockId, chatId }: { blockId: string; chatId: string }) {
  const { translate } = useSessionMessages();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const corners = screenLayout.corners(blockId);
  const focused = screenLayout.focusedBlockId === blockId;
  return (
    <ChatPanes
      chatId={chatId}
      blockId={blockId}
      reserveShellRestoreLane={corners.topLeft && !isLeftOpen}
      actionsSlot={
        <TabBarActionRow atWindowEdge={corners.topRight}>
          <ChatPartSlot chatId={chatId} part="actions" className="flex items-center" />
          {screenLayout.order.length > 1 ? <CloseBlockButton blockId={blockId} /> : null}
        </TabBarActionRow>
      }
      chip={({ tab, host }) => (
        <ChatTabChip
          tab={tab}
          host={host}
          focused={focused}
          data-chat-block-tab={chatId}
          label={translate('sidebar.chats')}
          labelSlot={<ChatPartSlot chatId={chatId} part="title" className="flex min-w-0 flex-1" />}
          menu={chatTabHasActions(chatId) ? <ChatTabMenuItems chatId={chatId} /> : null}
        />
      )}
      body={
        <>
          <ChatSlot chatId={chatId} className="flex min-h-0 min-w-0 flex-1 flex-col" />
          {/* 对话的输入框选了「新任务 / 定时任务」:那个框收起,这里换上对应的框(结果回这个对话)。 */}
          <ComposerVerbDock chatId={chatId} />
        </>
      }
    />
  );
});

/**
 * App 自己占一块:顶上一条页签条,只有它一枚(名字 + 图标 + ×),下面就是它的页。⋮⋮ 按住 = 这一块挪走;
 * × = 收起它(App 照常启用,点左栏它的图标整页打开);屏上不止一块时右端一枚「关闭这一块」。
 */
const AppBlock = observer(function AppBlock({ blockId, tabKind }: { blockId: string; tabKind: string }) {
  const { translate } = useSessionMessages();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const contribution = installedExtensionsStore.allTabContributions.find((entry) => entry.kind === tabKind);
  const { label, tooltip } = extensionTabTitle(extensionSurfaceStore.said(null, `screen:${blockId}`), installedExtensionsStore.tabTitle(tabKind) ?? tabKind);
  const corners = screenLayout.corners(blockId);
  const multi = screenLayout.order.length > 1;
  const focused = screenLayout.focusedBlockId === blockId;
  const takeAway = () => takeAppOffScreen(tabKind);
  return (
    <>
      <TabStripShell
        reserveShellRestoreLane={corners.topLeft && !isLeftOpen}
        leadingSlot={
          <ContextMenu>
            <ContextMenuTrigger className="flex h-full items-center">
              <BlockGrip
                label={translate('screen.gripApp')}
                onDragStart={(event) => setDraggedScreenContent(event.dataTransfer, { kind: 'app', tabKind, title: label }, event.currentTarget.closest<HTMLElement>('.session-tab-bar'))}
                onDragEnd={(event) => {
                  if (droppedOutsideWindow(event)) openInWindow({ kind: 'app', tabKind }, { screenX: event.screenX, screenY: event.screenY });
                }}
              />
            </ContextMenuTrigger>
            <ContextMenuContent finalFocus={false}>
              <ContextMenuItem onClick={() => openInWindow({ kind: 'app', tabKind })}>{translate('screen.openInWindow')}</ContextMenuItem>
              {multi ? (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => closeScreenBlock(blockId)}>{translate('screen.closeBlock')}</ContextMenuItem>
                </>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        }
        actionsSlot={
          <TabBarActionRow atWindowEdge={corners.topRight}>
            {multi ? <CloseBlockButton blockId={blockId} /> : null}
          </TabBarActionRow>
        }
      >
        <TabSlot data-app-block-tab={tabKind}>
          <TabChip
            isActive
            isFocusedPane={focused}
            label={label}
            title={tooltip}
            preSlot={<ExtensionMark iconDataUrl={contribution?.iconDataUrl} />}
            closeLabel={translate('task.closeTab', { label })}
            onClose={takeAway}
          />
        </TabSlot>
      </TabStripShell>
      <div className="min-h-0 flex-1">
        <ExtensionSharedSlot tabKind={tabKind} tabId={`screen:${blockId}`} />
      </div>
    </>
  );
});

/**
 * 一个对话里的一张 App 页单独占一块(从那个对话的页签条上拖到一块的边上、页签右键「单独一块」):和 App 那一块一样摆,
 * 页仍是那个对话的那张(context 里还是那个群,一辈子不换群,摩擦单 F48)。× = 放回那个对话的页签条。
 */
const ChatAppBlock = observer(function ChatAppBlock({ blockId, content }: { blockId: string; content: Extract<ScreenBlockContent, { kind: 'chat-app' }> }) {
  const { translate } = useSessionMessages();
  const { isLeftOpen } = useWorkspaceLayoutContext();
  const { chatId, tabKind, itemId, title } = content;
  const contribution = installedExtensionsStore.allTabContributions.find((entry) => entry.kind === tabKind);
  const slot = `screen:${blockId}`;
  const { label, tooltip } = extensionTabTitle(extensionSurfaceStore.said(null, slot), itemId ? title : (installedExtensionsStore.tabTitle(tabKind) ?? title));
  const corners = screenLayout.corners(blockId);
  const multi = screenLayout.order.length > 1;
  const putBack = () => {
    closeScreenBlock(blockId);
    openPanelItem(chatId, { kind: tabKind, title, ...(itemId ? { itemId, fileName: title } : {}) });
  };
  return (
    <>
      <TabStripShell
        reserveShellRestoreLane={corners.topLeft && !isLeftOpen}
        leadingSlot={
          <BlockGrip
            label={translate('screen.gripApp')}
            onDragStart={(event) => setDraggedScreenContent(event.dataTransfer, content, event.currentTarget.closest<HTMLElement>('.session-tab-bar'))}
          />
        }
        actionsSlot={
          <TabBarActionRow atWindowEdge={corners.topRight}>
            {multi ? <CloseBlockButton blockId={blockId} /> : null}
          </TabBarActionRow>
        }
      >
        <TabSlot data-chat-app-block-tab={tabKind}>
          <TabChip
            isActive
            isFocusedPane={screenLayout.focusedBlockId === blockId}
            label={label}
            title={tooltip}
            preSlot={<ExtensionMark iconDataUrl={contribution?.iconDataUrl} />}
            closeLabel={translate('task.closeTab', { label })}
            onClose={putBack}
          />
        </TabSlot>
      </TabStripShell>
      <div className="min-h-0 flex-1">
        <ExtensionSharedSlot tabKind={tabKind} tabId={slot} chatId={chatId} {...(itemId ? { itemId } : {})} />
      </div>
    </>
  );
});

/**
 * 每块页签条最左的 ⋮⋮(照 Zen 分屏块的拖柄):平时只留位置,指着页签条才淡淡显出来,指着它时整块描一圈 ——
 * 告诉你抓的是整块。按住拖 = 整块走;右键菜单由调用点给。
 */
export function BlockGrip({
  label,
  onDragStart,
  onDragEnd,
  onContextMenu,
}: {
  label: string;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  /** 松手之后(落点已经接过了)。拖到窗口外 = 单独成窗,由调用点判。 */
  onDragEnd?: (event: DragEvent<HTMLElement>) => void;
  onContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <span
      role="button"
      tabIndex={-1}
      draggable
      aria-label={label}
      title={label}
      data-block-grip=""
      className="screen-block-grip"
      // ❌ 别 stopPropagation:React 19 会把原生 dragstart 停在根容器上,document 上开拖拽遮罩的那条(shieldNativeDrags)
      // 就听不到 —— 拖着 ⋮⋮ 经过网页(HTML 预览、浏览器页签、App 的页),指针一进去宿主就收不到移动。上面也没有别人接 dragstart。
      onDragStart={onDragStart}
      onDragEnd={(event) => {
        onDragEnd?.(event);
        clearDraggedScreenContent();
        setBlockDropPreview(null);
      }}
      onContextMenu={onContextMenu}
    >
      <span className="screen-block-grip-dots" aria-hidden="true" />
    </span>
  );
}

/**
 * 原生拖拽松手在窗口外:没有任何落点接(dropEffect 是 none),指针又在这扇窗的框外 —— 拖到窗口外 = 单独成窗。
 * 按屏幕坐标和这扇窗的框比(落在咕咕的另一扇窗上也算外面,那扇窗的落点会先接走,这里就不是 none)。
 */
export function droppedOutsideWindow(event: DragEvent<HTMLElement>): boolean {
  if (event.dataTransfer.dropEffect !== 'none') return false;
  const view = event.currentTarget.ownerDocument.defaultView ?? window;
  const { screenX, screenY } = event;
  return (
    screenX < view.screenX ||
    screenY < view.screenY ||
    screenX > view.screenX + view.outerWidth ||
    screenY > view.screenY + view.outerHeight
  );
}

/** 一整个会话被拖起来(⋮⋮):载荷与左边一行同一种,落在输入框上照样是一枚 @,落在一块的边上 = 这块挪过去。 */
export function startSessionBlockDrag(
  event: DragEvent<HTMLElement>,
  session: { projectId: string; sessionId: string; title: string }
): void {
  setDraggedScreenContent(event.dataTransfer, { kind: 'session', ...session }, event.currentTarget.closest<HTMLElement>('.session-tab-bar'));
}

/** 屏上不止一块时,每块页签条右端那枚:从这屏拿走(左边列表里还在)。 */
export function CloseBlockButton({ blockId }: { blockId: string }) {
  const { translate } = useSessionMessages();
  const label = translate('screen.closeBlock');
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-close-block=""
      className="flex size-6 items-center justify-center rounded-md text-foreground-muted hover:bg-row-hover hover:text-foreground"
      onClick={() => closeScreenBlock(blockId)}
    >
      <X className="size-3.5" />
    </button>
  );
}

/** 拖到一块边上时画出来的那一半:松手前就看得到新的一块会落在哪。 */
export const BlockDropPreviewLayer = observer(function BlockDropPreviewLayer() {
  const drop = blockDropPreview.get();
  if (!drop) return null;
  if ('mention' in drop) return <MentionDropPreview blockId={drop.blockId} sessionId={drop.mention.sessionId} />;
  if ('paneId' in drop) return <PaneDropPreview blockId={drop.blockId} paneId={drop.paneId} strip={drop.strip} />;
  const anchor = blockAnchorName(drop.blockId);
  const half: Record<string, string> =
    drop.edge === 'left'
      ? { left: 'anchor(left)', right: 'anchor(center)', top: 'anchor(top)', bottom: 'anchor(bottom)' }
      : drop.edge === 'right'
        ? { left: 'anchor(center)', right: 'anchor(right)', top: 'anchor(top)', bottom: 'anchor(bottom)' }
        : drop.edge === 'top'
          ? { left: 'anchor(left)', right: 'anchor(right)', top: 'anchor(top)', bottom: 'anchor(center)' }
          : { left: 'anchor(left)', right: 'anchor(right)', top: 'anchor(center)', bottom: 'anchor(bottom)' };
  return (
    <div
      className={cn('pointer-events-none z-40 rounded-[var(--radius-control)] border border-foreground/20 bg-foreground/10')}
      style={{ position: 'absolute', positionAnchor: anchor, ...half } as CSSProperties}
      data-block-drop-preview={drop.edge}
    />
  );
});

/**
 * App 落进一条会话的某一格:整格罩一层(同格子里拖页签进来时那一层);落在页签条上 = 一根竖线标出插到哪
 * (同一条会话里拖页签时那根,见 draggable-tab.tsx 的 DropIndicator)。
 */
function PaneDropPreview({ blockId, paneId, strip }: { blockId: string; paneId: string; strip?: { before: string | null } }) {
  const cell = document.querySelector<HTMLElement>(`[data-screen-page="${CSS.escape(blockId)}"] [data-pane-cell="${CSS.escape(paneId)}"]`);
  const rect = cell?.getBoundingClientRect();
  if (!cell || !rect) return null;
  if (strip) {
    const slots = [...cell.querySelectorAll<HTMLElement>('.session-tab-bar .session-tab-slot')];
    const before = strip.before ? cell.querySelector<HTMLElement>(`[data-tabid="${CSS.escape(strip.before)}"]`)?.closest<HTMLElement>('.session-tab-slot') : null;
    const ref = before ?? slots.at(-1);
    const box = ref?.getBoundingClientRect();
    if (!box) return null;
    return (
      <div
        className="pointer-events-none fixed z-40 w-0.5 bg-foreground"
        style={{ left: (before ? box.left : box.right) - 1, top: box.top + 4, height: box.height - 8 }}
        data-pane-drop-preview={paneId}
        data-pane-drop-before={strip.before ?? 'end'}
      />
    );
  }
  return (
    <div
      className="pointer-events-none fixed z-40 rounded-[var(--radius-control)] border border-foreground/20 bg-foreground/10"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      data-pane-drop-preview={paneId}
    />
  );
}

/**
 * 插 @ 的落点:罩住那枚 @ 会落进去的地方 —— 聊天是输入框,终端就是终端本身(同分块落点那一层)。
 * 指针在聊天记录上也罩输入框:松手的结果是输入框里多一枚 @,画的就是结果。
 */
function MentionDropPreview({ blockId, sessionId }: { blockId: string; sessionId: string }) {
  const surface = document.querySelector<HTMLElement>(
    `[data-screen-page="${CSS.escape(blockId)}"] [data-session-chat-surface][data-session-chat-session-id="${CSS.escape(sessionId)}"]`
  );
  const target = surface?.querySelector<HTMLElement>('[data-slot="composer-bar"]') ?? surface;
  const rect = target?.getBoundingClientRect();
  if (!target || !rect) return null;
  return (
    <div
      className="pointer-events-none fixed z-40 border border-foreground/20 bg-foreground/10"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, borderRadius: getComputedStyle(target).borderRadius }}
      data-mention-drop-preview={sessionId}
    />
  );
}

/**
 * 原生拖放(左边一行、⋮⋮)落在这屏上:一块的边归分块(这里在捕获阶段收走);会话落在另一条会话的正中或输入框上 = 插 @
 * (聊天区、输入框、终端自己收,这里只把落点画出来);App 落在会话中间归那一格。
 */
export function screenDropHandlers(enabled: boolean) {
  const inComposer = (target: EventTarget | null) => target instanceof Element && target.closest('[data-slot="composer-bar"]') !== null;
  /** 指针下是另一条会话的输入面(聊天区 / 终端,`data-session-chat-surface`):松手由它自己插 @。 */
  const mentionAt = (event: DragEvent<HTMLElement>): MentionDrop | null => {
    const dragged = getDraggedScreenContent(event.dataTransfer);
    const surface = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-session-chat-surface]') : null;
    const blockId = surface?.closest('[data-screen-page]')?.getAttribute('data-screen-page');
    const sessionId = surface?.dataset.sessionChatSessionId;
    if (dragged?.kind !== 'session' || !blockId || !sessionId || sessionId === dragged.sessionId) return null;
    return { blockId, mention: { sessionId } };
  };
  const resolve = (event: DragEvent<HTMLElement>) => {
    const content = getDraggedScreenContent(event.dataTransfer);
    if (!content || (content.kind !== 'app' && inComposer(event.target))) return null;
    const drop = resolveBlockDrop(event.clientX, event.clientY, content);
    return drop ? { drop, content } : null;
  };
  return {
    onDragOverCapture: (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasDraggedScreenContent(event.dataTransfer)) return;
      const hit = resolve(event);
      setBlockDropPreview(hit?.drop ?? mentionAt(event));
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
    },
    onDropCapture: (event: DragEvent<HTMLElement>) => {
      if (!enabled || !hasDraggedScreenContent(event.dataTransfer)) return;
      const hit = resolve(event);
      setBlockDropPreview(null);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      dropOnScreen(hit.drop, hit.content);
      if (hit.content.kind === 'chat' && hit.content.topic) requestTopicSplit({ ...hit.content.topic, sourceChatId: hit.content.chatId, focusComposer: true });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBlockDropPreview(null);
    },
  };
}
