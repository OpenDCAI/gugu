/**
 * ComboboxPopup
 *
 * A reusable floating listbox anchored to a caret position (or any DOMRect).
 * Designed for TipTap suggestion menus but usable wherever a lightweight
 * anchor-positioned popup list is needed.
 *
 * Keyboard navigation is externally driven: the host TipTap extension forwards
 * key events to the imperative `onKeyDown` handle. ArrowUp / ArrowDown move the
 * highlight, Enter / Tab confirm, Escape returns false so the caller can dismiss.
 *
 * Visual language mirrors ComboboxContent / ComboboxItem from combobox.tsx:
 * surface-elevated, ring-1, shadow, rounded-md, text-sm items with bg-surface-hover
 * on highlight and text-foreground-muted descriptions.
 */

import { useUiPortalContainerOrBody } from '@session-ui/react/lib/portal-container';
import { cx } from '@session-ui/styles/utilities/cx';
import { XIcon } from '../../../icons'
import * as React from 'react';
import { createPortal } from 'react-dom';
import * as styles from './combobox-popup.css';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ComboboxPopupItem {
  id: string;
  /** Optional icon node rendered before the label (e.g. a devicon <i> or lucide svg). */
  icon?: React.ReactNode;
  /** Optional initial-letter avatar used by assistant-ui style mention rows. */
  avatarLabel?: string;
  /**
   * 用**字重**而不是图标来区分这一条。
   *
   * owner 2026-09-07:会话同伴那几条原来落到一个通用的 `@` 字形上,视觉上不协调 ——
   * 而正确的图标(那条会话的 harness 标)今天拿不到:`LocalSessionPeer` 里没有 provider。
   * ⇒ ❌ 不留一个占位图标(它既不表意也不好看),改用字重把这一类挑出来。
   */
  strong?: boolean;
  /** Primary display text. */
  label: string;
  /** Secondary muted text shown on the right. */
  description?: string;
  /** Render this item's label and description as stacked rows. */
  stacked?: boolean;
  /** Use the muted monospace role treatment for this item's description. */
  descriptionMono?: boolean;
  /** Optional visual grouping label rendered as a non-selectable header. */
  section?: string;
  /** 一行说明(例如「还没读到那台机器」):照样画出来,点不了、方向键跳过、回车不选。 */
  disabled?: boolean;
}

/** 从 `from` 起按 `step` 走到下一条能选的(环绕);一条能选的都没有就原地不动。 */
function nextEnabled(items: readonly ComboboxPopupItem[], from: number, step: 1 | -1): number {
  for (let k = 1; k <= items.length; k++) {
    const i = (from + step * k + items.length * k) % items.length;
    if (!items[i]?.disabled) return i;
  }
  return from;
}

export interface ComboboxPopupHandle {
  onKeyDown(event: KeyboardEvent): boolean;
}

interface ComboboxPopupProps {
  items: ComboboxPopupItem[];
  /** Caret-position anchor. Popup renders nothing when null or empty. */
  anchorRect: DOMRect | null;
  onSelect(item: ComboboxPopupItem): void;
  /** Text shown when items is empty but anchorRect is set. Omit to hide popup when empty. */
  emptyLabel?: string;
  /** Optional header node rendered above the item list. */
  header?: React.ReactNode;
  /** Render label and description as two stacked rows instead of a single row. */
  stacked?: boolean;
  /**
   * 这个弹层在**调用方的词汇表**里叫什么（#4981 A4）。
   *
   * 根节点得到 `data-slot={slot}`，每一条得到 `data-slot={`${slot}-item`}`，
   * 选中的那条另带 `data-active`（对齐上游 `elements-composer` 的
   * `composer-menu` / `composer-menu-item` / `data-active`）。
   *
   * ⚠️ 为什么是一个**属性**而不是在这里写死 `composer-menu`：
   * 这是 `primitives/` 下的通用弹层，眼下两个调用点都在 composer（@提及 / 斜杠命令），
   * 但把 composer 的名字焊进原语，下一个非 composer 的用法就会顶着一个说谎的名字。
   * ❌ 也不是「调用点传 data-slot 覆盖 primitive 自己的」那种写法（那会静默顶掉，
   * 见 chat-composer/index.tsx 顶部的实测）——这里 primitive 自己没有别的 slot 要守，
   * 名字本来就该由用它的那一面给。
   */
  slot?: string;
  /**
   * 列表换了(同一个查询重查回来、而不是用户又打了字)时,按 id 留住原来高亮的那一条;它不在了才回第一条。
   * 缺省 = 内容一变就回第一条(打字过滤时该这样)。
   */
  keepActiveOnChange?: boolean;
  /**
   * 这个 listbox 的 DOM id。**给出它,就是要把弹层接进调用方那个输入框的 ARIA 合同**
   * (`aria-controls` 指这里,`aria-activedescendant` 指这里的某一条)。
   *
   * 缺省时弹层自己 `useId()` 造一个 —— 那种情况下 id 只是内部用来编号选项的,没人引用它。
   * ⚠️ 之所以要让调用方给,而不是弹层造完往外报:调用方那一侧要在**同一次渲染**里
   *    既写 `aria-controls` 又决定弹层渲不渲染。id 从弹层报上来的话,`aria-controls`
   *    必然晚一拍 —— 菜单已经在屏幕上了,输入框还没指向它。
   */
  id?: string;
  /**
   * 当前**键盘活动项**的 DOM id 变了就报一次(没有活动项 = `null`)。
   *
   * 调用方拿它填输入框的 `aria-activedescendant`。⚠️ 这条回调必须是稳定的引用或被调用方
   * 用 ref 兜住:它在 `selectedIndex` / `items` 变化的 effect 里调,回调本身进依赖会自激。
   */
  onActiveOptionChange?: (optionId: string | null) => void;
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const ComboboxPopup = React.forwardRef<ComboboxPopupHandle, ComboboxPopupProps>(
  function ComboboxPopup(
    {
      items,
      anchorRect,
      onSelect,
      emptyLabel,
      header,
      stacked = false,
      slot,
      keepActiveOnChange = false,
      id,
      onActiveOptionChange,
      className,
    },
    ref
  ) {
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    // 稳定 id —— composer 那一侧要用它接 `aria-controls` / `aria-activedescendant`
    // (上游 trigger-popover 的可访问性契约:WAI-ARIA editable combobox)。
    // 调用方给了就用它的,好让输入框那一侧能先于弹层写出 `aria-controls`。
    const fallbackId = React.useId();
    const listboxId = id ?? fallbackId;
    const listRef = React.useRef<HTMLUListElement>(null);
    const portalContainer = useUiPortalContainerOrBody();

    /**
     * 列表**内容**变了才把高亮拨回第一条。
     *
     * ⚠️ 依赖的是**内容签名**,❌ 不是 `items` 这个数组的身份 —— 这一条是 bug 修复,不是洁癖:
     * 调用方每次渲染都会现 `map` 出一个新数组(`prompt-editor.tsx` 的 `commandPopupItems`),
     * 数组身份因此每渲染一变。从前这不出事,是因为**高亮是弹层的内部 state,父层不会跟着重渲染**。
     * 而 #4981 那一刀把「当前活动项」报给了父层去填 `aria-activedescendant` ⇒ 每按一次方向键
     * 父层就重渲染一次 ⇒ 新数组 ⇒ 这个 effect 触发 ⇒ **高亮被拨回 0**。
     * 症状:`/` 与 @ 菜单里**方向键彻底不动**(2026-09-06 真机读数:45 条候选,按 ↓ 之后
     * `aria-activedescendant` 仍是 `-opt-0`)。
     *
     * 按内容签名比,父层怎么重渲染都不影响它;而真正换了一批候选项时它照旧归零。
     */
    const itemsSignature = JSON.stringify(items.map((item) => item.id));
    // 归位到第一条能选的(说明行不当高亮)。
    const firstEnabled = Math.max(0, items.findIndex((item) => !item.disabled));
    // 高亮的那一条是谁(按 id):重查回来的列表里它还在,就留在它上面。
    const activeIdRef = React.useRef<string | null>(null);
    const keepActiveRef = React.useRef(keepActiveOnChange);
    keepActiveRef.current = keepActiveOnChange;
    React.useEffect(() => {
      const kept = keepActiveRef.current
        ? items.findIndex((item) => item.id === activeIdRef.current && !item.disabled)
        : -1;
      setSelectedIndex(kept >= 0 ? kept : firstEnabled);
      // oxlint-disable-next-line react/exhaustive-deps -- 只在内容签名变时归位,items 本身每次渲染都是新数组
    }, [itemsSignature, firstEnabled]);
    React.useEffect(() => {
      activeIdRef.current = items[selectedIndex]?.id ?? null;
      // oxlint-disable-next-line react/exhaustive-deps -- 记下「此刻高亮的是谁」,只跟着高亮变
    }, [selectedIndex, itemsSignature]);

    // 把当前活动项的 id 报给调用方,填它输入框的 `aria-activedescendant`。
    // ⚠️ 回调走 ref:它进依赖数组的话,调用方每次重渲染换一个新函数就会把这个 effect 打成自激。
    const activeChangeRef = React.useRef(onActiveOptionChange);
    activeChangeRef.current = onActiveOptionChange;
    const hasItems = items.length > 0;
    React.useEffect(() => {
      activeChangeRef.current?.(hasItems ? `${listboxId}-opt-${selectedIndex}` : null);
    }, [hasItems, listboxId, selectedIndex]);
    // 卸载时把它清掉 —— 否则输入框会一直指着一个已经不在 DOM 里的 id,
    // 读屏器读到的是一条**幽灵选项**(比没有更糟)。
    React.useEffect(
      () => () => {
        activeChangeRef.current?.(null);
      },
      []
    );

    // Scroll the highlighted item into view.
    React.useEffect(() => {
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-popup-item-index="${selectedIndex}"]`
      );
      el?.scrollIntoView({ block: 'nearest' });
    }, [selectedIndex]);

    React.useImperativeHandle(ref, () => ({
      onKeyDown(event: KeyboardEvent): boolean {
        // 上游 trigger-popover 的键盘契约:上下**环绕**。原来是夹到两端,
        // 于是最后一条再按 ↓ 没有任何反应 —— 看起来像卡住了。
        if (event.key === 'ArrowDown') {
          setSelectedIndex((i) => (items.length === 0 ? 0 : nextEnabled(items, i, 1)));
          return true;
        }
        if (event.key === 'ArrowUp') {
          setSelectedIndex((i) => (items.length === 0 ? 0 : nextEnabled(items, i, -1)));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          const item = items[selectedIndex];
          // 没有能选的(全是说明行)⇒ 把键还给编辑器:回车照常发送,❌ 吞掉。
          if (!item || item.disabled) return false;
          onSelect(item);
          return true;
        }
        if (event.key === 'Escape') {
          return false;
        }
        return false;
      },
    }));

    // Nothing to render.
    if (!anchorRect) return null;
    if (items.length === 0 && !emptyLabel) return null;

    // Position above or below the caret depending on available space.
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    const openAbove = spaceBelow < 200 && spaceAbove > spaceBelow;

    const style: React.CSSProperties = openAbove
      ? {
          position: 'fixed',
          left: anchorRect.left,
          bottom: window.innerHeight - anchorRect.top + 4,
        }
      : {
          position: 'fixed',
          left: anchorRect.left,
          top: anchorRect.bottom + 4,
        };

    const popup = (
      <div
        role="listbox"
        id={listboxId}
        data-slot={slot}
        // 上游 `composer-slash-commands` / `composer-mentions` 的解剖里,菜单根带 `data-open`。
        // 这里只有开着才渲染,所以它恒为 true —— 但仍然要写出来:样式与判据按属性选,
        // 不该去猜「这个节点存在就是开着」。
        data-open="true"
        style={style}
        className={cx('surface-elevated', styles.popupRoot, className)}
      >
        {header && <div className={styles.popupHeader}>{header}</div>}
        <ul ref={listRef} className={styles.popupList}>
          {items.length === 0 && emptyLabel ? (
            <li className={cx(styles.popupItem, styles.popupItemDefault)}>{emptyLabel}</li>
          ) : (
            items.map((item, index) => {
              const showSection = item.section && item.section !== items[index - 1]?.section;
              const itemStacked = stacked || item.stacked;
              const descriptionClass = item.descriptionMono
                ? styles.popupItemDescriptionMono
                : item.avatarLabel
                  ? styles.popupItemRole
                  : styles.popupItemDescription;
              return (
                <React.Fragment key={item.id}>
                  {showSection && (
                    <li className={styles.popupSectionHeader} role="presentation">
                      {item.section}
                    </li>
                  )}
                  <li
                    role="option"
                    id={`${listboxId}-opt-${index}`}
                    aria-selected={index === selectedIndex}
                    aria-disabled={item.disabled || undefined}
                    data-slot={slot ? `${slot}-item` : undefined}
                    // 上游用 `data-active` 标高亮那一条；`aria-selected` 说给读屏器，
                    // `data-active` 说给样式与判据，两者不互相替代。
                    data-active={index === selectedIndex || undefined}
                    // 上游 mentions 解剖:键盘走位时高亮那条另带 `data-highlighted`。
                    // 与 `data-active` 同源但分工不同 —— 前者是「键盘停在这」,后者是「当前选中」;
                    // 本仓两者同时成立,仍然两个都写,好让抄上游样式的选择器直接命中。
                    data-highlighted={index === selectedIndex || undefined}
                    data-popup-item-index={index}
                    onMouseDown={(e) => {
                      // Prevent editor blur before select fires.
                      e.preventDefault();
                      if (!item.disabled) onSelect(item);
                    }}
                    onMouseEnter={() => {
                      if (!item.disabled) setSelectedIndex(index);
                    }}
                    className={cx(
                      styles.popupItem,
                      itemStacked && styles.popupItemStacked,
                      item.disabled
                        ? styles.popupItemDefault
                        : index === selectedIndex ? styles.popupItemHighlighted : styles.popupItemHover
                    )}
                  >
                    {item.avatarLabel ? (
                      <span className={styles.popupItemAvatar} aria-hidden="true">
                        {item.avatarLabel}
                      </span>
                    ) : item.icon ? (
                      <span className={styles.popupItemIcon}>{item.icon}</span>
                    ) : null}
                    {itemStacked ? (
                      <span className={styles.popupItemTextStack}>
                        <span
                          className={cx(styles.popupItemLabel, item.strong && styles.popupItemLabelStrong)}
                        >
                          {item.label}
                        </span>
                        {item.description && (
                          <span className={descriptionClass}>
                            {item.description}
                          </span>
                        )}
                      </span>
                    ) : (
                      <>
                        <span
                        className={cx(styles.popupItemLabel, item.strong && styles.popupItemLabelStrong)}
                      >
                        {item.label}
                        </span>
                        {item.description && (
                          <span className={descriptionClass}>
                            {item.description}
                          </span>
                        )}
                      </>
                    )}
                    {/* 上游:高亮那一行右侧给一个 ↵ 提示,告诉用户回车就是选它。
                        `aria-hidden` —— 读屏器已经从 `aria-selected` 知道这一条被选中了。 */}
                    {index === selectedIndex && !item.disabled && (
                      <span aria-hidden className={styles.popupItemEnterHint}>
                        ↵
                      </span>
                    )}
                  </li>
                </React.Fragment>
              );
            })
          )}
        </ul>
      </div>
    );

    return createPortal(popup, portalContainer);
  }
);

// ── Helper: dismiss button ────────────────────────────────────────────────────

/** Small icon-only dismiss button used inside ComboboxPopup headers. */
export function ComboboxPopupDismiss({
  onClick,
  className,
}: {
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onClick?.();
      }}
      className={cx(styles.popupDismiss, className)}
      aria-label="Dismiss"
    >
      <XIcon style={{ width: '0.75rem', height: '0.75rem' }} />
    </button>
  );
}
