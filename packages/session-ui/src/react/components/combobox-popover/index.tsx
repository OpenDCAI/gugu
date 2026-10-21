import { type ComboboxRootChangeEventDetails } from '@base-ui/react/combobox';
import { cx } from '@session-ui/styles/utilities/cx';
import { ChevronDown } from '../../../icons'
import * as React from 'react';
import { Combobox } from '@session-ui/react/primitives/combobox/combobox';
import {
  HoverCard,
  isEventInsideInteractiveLayer,
  useHoverCard,
} from '@session-ui/react/primitives/hover-card';
import * as styles from './combobox-popover.css';

export interface ComboboxPopoverProps<T> {
  items: T[];
  value: string | null | undefined;
  onValueChange: (value: string) => void;
  /** Extract a stable unique key from an item. */
  itemToKey: (item: T) => string;
  /** Extract the primary display label from an item. */
  itemToLabel: (item: T) => string;
  /**
   * Custom filter predicate. Defaults to a case-insensitive label substring
   * match so items with no matching substring are hidden.
   */
  filter?: (item: T, query: string) => boolean;
  /**
   * Render the trigger button content.
   * Receives the currently selected item (or `null` when nothing is selected).
   */
  renderTrigger: (selected: T | null) => React.ReactNode;
  /** Optional title/label for the trigger button. */
  triggerTitle?: (selected: T | null) => string | undefined;
  /**
   * Render the content of each list row.
   * Receives the item; the row wrapper (hover/selected states) is provided by
   * the primitive.
   */
  renderItem: (item: T) => React.ReactNode;
  /**
   * When provided a detail hover card is shown beside the list on row hover.
   * Receives the currently hovered item.
   */
  renderItemDetail?: (item: T) => React.ReactNode;
  /** Placeholder text inside the search input. */
  searchPlaceholder?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
  /** Side for the detail hover card relative to the list popup. Defaults to 'right'. */
  detailSide?: 'top' | 'bottom' | 'left' | 'right';
  /** Align for the detail hover card. Defaults to 'start'. */
  detailAlign?: 'start' | 'center' | 'end';
  /**
   * Optional footer rendered inside the popup but OUTSIDE the filtered item
   * collection. A separator is inserted automatically above the footer.
   * Use this for action rows (e.g. "Open settings", "Manage providers") that
   * should remain visible regardless of what the user types in the search box.
   */
  renderFooter?: () => React.ReactNode;
  /**
   * Visual appearance of the trigger button.
   * - `control` (default): ghost button — matches dropdowns and toolbar triggers.
   * - `input`: matches Input/Textarea — border, surfaceInput background, focus ring.
   *   Use in form contexts via ComboboxSelectField.
   */
  appearance?: 'control' | 'input';
  /**
   * 不画触发器右端那枚下拉箭头。
   *
   * ⚠️ 只给 composer 底排那一处用(见 chat-composer/index.tsx 的权限选择器):那一排
   * owner 定了三枚箭头一并撤,而这里是其中一枚的来源。其余 8 个消费方(设置页、表单里的
   * ComboboxSelectField 等)照旧要箭头 —— 那些地方箭头是「这是个可展开控件」的唯一提示,
   * 底排则靠药丸底色和 hover 已经说清了。所以是**逐处退出**,❌ 不改默认值。
   */
  hideChevron?: boolean;
  /**
   * 传给每一行 `Combobox.Item` 的类名。
   *
   * ⚠️ 行的内距/圆角挂在 Item **自己**身上(原语给的默认是 6/32/6/8)。`renderItem` 渲染的是
   * Item **里面**那层,在那儿写内距会与原语的叠成双份 —— 所以要换行的几何,只能从这里传。
   * composer 的三个面板靠它共用同一族行(见 chat-composer.css.ts 的 @@@composer-panel-row)。
   */
  itemClassName?: string;
  /** 搜索框左侧的前缀(composer 三个面板都放一枚放大镜,对齐 assistant-ui 的 CommandInput)。 */
  searchLeftAddon?: React.ReactNode;
}

export function ComboboxPopover<T>({
  items,
  value,
  onValueChange,
  itemToKey,
  itemToLabel,
  filter,
  renderTrigger,
  triggerTitle,
  renderItem,
  renderItemDetail,
  renderFooter,
  searchPlaceholder = 'Search…',
  disabled = false,
  className,
  contentClassName,
  contentStyle,
  detailSide = 'right',
  detailAlign = 'start',
  appearance = 'control',
  hideChevron = false,
  itemClassName,
  searchLeftAddon,
}: ComboboxPopoverProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);
  const hoverCard = useHoverCard();

  const selectedItem = value != null ? (items.find((i) => itemToKey(i) === value) ?? null) : null;
  const triggerTitleValue = triggerTitle?.(selectedItem);

  const activeDetailItem =
    renderItemDetail && hoverCard.activeKey != null
      ? (items.find((i) => itemToKey(i) === hoverCard.activeKey) ?? null)
      : null;

  const defaultFilter = React.useCallback(
    (item: T, query: string) => itemToLabel(item).toLowerCase().includes(query.toLowerCase()),
    [itemToLabel]
  );

  function handleOpenChange(next: boolean, eventDetails: ComboboxRootChangeEventDetails) {
    if (disabled) return;
    // Interactions inside the hover card OR inside any other nested interactive
    // layer (e.g. a footer submenu rendered in its own portal) must not close
    // the combobox list — cancel the dismissal.
    // isEventInsideInteractiveLayer already recognises [data-slot="dropdown-menu-content"]
    // so effort-submenu interactions are caught here.
    if (!next && isEventInsideInteractiveLayer(eventDetails.event, anchorEl)) {
      eventDetails.cancel();
      return;
    }
    if (!next) hoverCard.close();
    setOpen(next);
  }

  function handleValueChange(item: T | null) {
    if (!item || disabled) return;
    hoverCard.close();
    onValueChange(itemToKey(item));
    setOpen(false);
  }

  return (
    <Combobox.Root
      items={items}
      value={selectedItem ?? null}
      onValueChange={handleValueChange}
      open={open}
      onOpenChange={disabled ? undefined : handleOpenChange}
      isItemEqualToValue={(a: T, b: T) => itemToKey(a) === itemToKey(b)}
      filter={filter ?? defaultFilter}
      autoHighlight
    >
      <Combobox.Trigger
        disabled={disabled}
        title={triggerTitleValue}
        aria-label={triggerTitleValue}
        className={
          appearance === 'input'
            ? cx(...styles.triggerInput, className)
            : cx(styles.trigger, className)
        }
      >
        <span className={styles.triggerLabel}>{renderTrigger(selectedItem)}</span>
        {hideChevron ? null : <ChevronDown className={styles.triggerChevron} />}
      </Combobox.Trigger>

      <Combobox.Content
        ref={setAnchorEl}
        className={cx(styles.contentMinWidth, contentClassName)}
        style={contentStyle}
      >
        <Combobox.Input showTrigger={false} placeholder={searchPlaceholder}
          leftAddon={searchLeftAddon}
        />
        <Combobox.List>
          {(item: T) => {
            const key = itemToKey(item);
            return (
              <Combobox.Item
                key={key}
                value={item}
                className={itemClassName}
                {...(renderItemDetail ? hoverCard.getRowHoverProps(key) : {})}
              >
                {renderItem(item)}
              </Combobox.Item>
            );
          }}
        </Combobox.List>
        {renderFooter && (
          <>
            <Combobox.Separator />
            {renderFooter()}
          </>
        )}
      </Combobox.Content>

      {renderItemDetail && activeDetailItem && (
        <HoverCard
          anchor={anchorEl}
          ownPopup={anchorEl ?? undefined}
          controller={hoverCard}
          side={detailSide}
          align={detailAlign}
        >
          {renderItemDetail(activeDetailItem)}
        </HoverCard>
      )}
    </Combobox.Root>
  );
}
