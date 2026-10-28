import { useScreenBlock } from '@renderer/app/screen-block-context';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize2, Minimize2 } from '@/lib/icons';
import type { TabHost } from '@renderer/features/tabs/core/tab-host';
import type { ResolvedTab, TabViewContext } from '@renderer/features/tabs/core/tab-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { usePaneContext } from '../pane-context';
import { DraggableTab } from './draggable-tab';
import { PairSeparator } from './pair-separator';
import { TabChip } from './tab-chip';
import type { TabCommand } from './tab-commands';
import { TabContextMenu } from './tab-context-menu';

/** Props for GenericTabItem — aligns with TabBarItemProps<any> for convenience. */
export interface GenericTabItemProps {
  tab: ResolvedTab;
  host: TabHost;
  ctx: TabViewContext;
  /** Plain visible text; used as the default tooltip base and rename commit basis. */
  label: string;
  /** Tooltip base when different from label (e.g. full file path); preview hint appended. */
  tooltip?: string;
  /** Leading icon slot (file icon, agent icon, spinner). */
  preSlot?: ReactNode;
  /** Muted text after the label (a same-named tab's distinguishing path, the diff group). */
  hint?: string;
  /** Content shown under the absolutely-positioned close X (e.g. dirty dot, status icon). */
  statusSlot?: ReactNode;
  /** Renders the title in destructive color. */
  hasError?: boolean;
  /** Extra context-menu items placed after the engine commands. */
  kindCommands?: TabCommand[];
  /** Raw editable text prefilled into the rename input (defaults to label). */
  renameValue?: string;
  /** Max character length enforced on the rename input. */
  renameMaxLength?: number;
}

/**
 * Single generic tab chip renderer. Owns:
 * - Drag wrapper, click/keyboard interaction, active styling, pane separator
 * - Context menu wrapping
 * - Preview tooltip/italic formatting
 * - Inline rename (label → input) driven by host.renameRequest
 * - Close button with optional status indicator underneath
 *
 * Each tab kind supplies only its slot config (preSlot, statusSlot, kindCommands)
 * plus label/hint/tooltip/hasError.
 */
export const GenericTabItem = observer(function GenericTabItem({
  tab,
  host,
  ctx,
  label,
  tooltip,
  preSlot,
  hint,
  statusSlot,
  hasError,
  kindCommands,
  renameValue,
  renameMaxLength,
}: GenericTabItemProps) {
  const { translate } = useSessionMessages();
  const { isFocusedPane, pane } = usePaneContext();
  const [isEditing, setIsEditing] = useState(false);
  const committedRef = useRef(false);

  const startRename = useCallback(() => {
    committedRef.current = false;
    window.setTimeout(() => setIsEditing(true), 0);
  }, []);

  const renameRequested = host.renameRequest?.tabId === tab.tabId;
  useEffect(() => {
    if (!renameRequested) return;
    startRename();
    host.clearRenameRequest();
  }, [renameRequested, startRename, host]);

  const commit = useCallback(
    (value: string) => {
      if (committedRef.current) return;
      committedRef.current = true;
      let next = value.trim();
      if (renameMaxLength != null) next = next.slice(0, renameMaxLength);
      if (next && next !== (renameValue ?? label)) host.commitRename(tab.tabId, next);
      setIsEditing(false);
    },
    [host, label, renameMaxLength, renameValue, tab.tabId]
  );

  const handleSelect = () => {
    host.setActiveTab(tab.tabId);
    // Container TabBar onClick will return focus to active content for mouse clicks.
    // Keyboard-initiated selection needs an explicit call since onClick won't fire.
  };

  // 页签全屏:关闭钮前一颗「全屏 / 退出全屏」,双击页签同一件事(瞄一眼的那种双击照旧是留下它)。
  // 盖住的是整个工作区,所以这屏不止一块时每一枚点着的页签都有;只有一块时只给并排着的那一对(全屏才有区别)。
  const place = useScreenBlock();
  const fill = tab.isActive ? host.tabFill(tab.tabId, place.blockId !== null && place.multi) : null;
  const fillLabel = fill ? translate(fill.full ? 'tabs.restorePane' : 'tabs.fillPane') : '';
  const fillButton = fill ? (
    <button
      type="button"
      data-testid="tab-fill"
      aria-pressed={fill.full}
      aria-label={fillLabel}
      title={fillLabel}
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-foreground-muted hover:bg-row-hover hover:text-foreground active:bg-row-press"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        fill.toggle();
      }}
    >
      {fill.full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
    </button>
  ) : null;

  const base = tooltip ?? label;
  const fullTitle = tab.isPreview ? `${base} (preview — double-click to keep)` : base;

  // ⚠️ 嵌套顺序是**几何**的一部分,❌ 别为了「读起来顺」把右键菜单挪回外层:
  // 页签的宽度规矩(平分 / 240 封顶 / 56 下限)写在 <DraggableTab> 内那层 <TabSlot>(.session-tab-slot)上,
  // 而 flex 只认**直接子项**。菜单在外层时,贴条的 flex 子项是菜单那层 trigger(它没有任何
  // flex 设定 = `0 1 auto`,缩不到内容以下),那条宽度规矩整条失效:页签按内容撑开、不肯让位,
  // 把「+」顶出滚动区裁掉(owner:「这个也得修,还挺严重」);同时 .session-tab-slot 之间的
  // 短分隔线是**相邻兄弟**选择器(index.css),被 trigger 隔开后从来没画出来过。
  return (
    <DraggableTab id={tab.tabId} pairRole={tab.pairRole}>
      {/* 并排的一对:两枚中间那根线指上去就是「拆开」(spec session-page「并排」)。 */}
      {tab.pairRole === 'end' ? (
        <PairSeparator label={translate('tabs.separatePair')} onSeparate={() => host.separatePair()} />
      ) : null}
      <TabContextMenu tab={tab} host={host} ctx={ctx} kindCommands={kindCommands}>
        <TabChip
          isActive={tab.isActive}
          // 并排时两枚都亮着,点着的那一边标题深、另一边浅 —— 与「哪一格握着焦点」同一种明暗(spec session-page「并排」)。
          isFocusedPane={isFocusedPane && (tab.isFocused ?? true)}
          pairRole={tab.pairRole}
          label={label}
          hint={hint}
          title={fullTitle}
          isPreview={tab.isPreview}
          hasError={hasError}
          preSlot={preSlot}
          labelSlot={
            isEditing ? (
              <input
                ref={(el) => {
                  el?.focus();
                  el?.select();
                }}
                defaultValue={renameValue ?? label}
                maxLength={renameMaxLength}
                className="h-6 max-w-30 min-w-0 rounded bg-background-1 px-1.5 text-sm text-foreground ring-1 ring-foreground/20 outline-none"
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onBlur={(e) => commit(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') commit(e.currentTarget.value);
                  else if (e.key === 'Escape') {
                    committedRef.current = true;
                    setIsEditing(false);
                  }
                }}
              />
            ) : undefined
          }
          statusSlot={statusSlot}
          actionSlot={fillButton}
          closeLabel={translate('task.closeTab', { label })}
          onClose={() => host.requestCloseTab(tab.tabId)}
          onMouseEnter={() => host.signalActivateIntent(tab.tabId)}
          onClick={handleSelect}
          onDoubleClick={() => (tab.isPreview || !fill ? host.pin(tab.tabId) : fill.toggle())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleSelect();
              // Keyboard selection doesn't bubble as a click, so return focus explicitly.
              pane.focusActiveContent();
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              host.requestCloseTab(tab.tabId);
            }
          }}
          data-tabid={tab.tabId}
        />
        {/* ❌ 这里原本焊了一根通高的 <Separator>：每个页签后面一条到顶到底的竖线，读起来是
            表格而不是页签。Chrome 的分隔线是 16px 短竖线、且自己或邻居被选中/悬浮时消失 ——
            判据在兄弟节点上，只能用 CSS 表达，见 index.css 的 .session-tab-slot。 */}
      </TabContextMenu>
    </DraggableTab>
  );
});

/**
 * Generic drag ghost for any tab kind.
 */
export function GenericTabDragPreview({ preSlot, label }: { preSlot?: ReactNode; label: string }) {
  // @@@C-14 (Refs #6107) 浮起物只画一次边:抬升本身就说明它在纸上面 ⇒ 去 border,留 lift。
  return (
    <div className="flex cursor-grabbing items-center gap-1.5 rounded-md bg-background-secondary-1 px-2 py-1 text-sm opacity-80 shadow-lift">
      {preSlot}
      <span className="max-w-[200px] truncate">{label}</span>
    </div>
  );
}
