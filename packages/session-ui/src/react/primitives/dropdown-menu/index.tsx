import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { useUiPortalContainer } from '@session-ui/react/lib/portal-container';
import { cx } from '@session-ui/styles/utilities/cx';
import { CheckIcon, ChevronRightIcon } from '../../../icons'
import * as React from 'react';
import type { FixedDataSlotProps } from '../fixed-data-slot';
import * as styles from './dropdown-menu.css';

function DropdownMenuRoot({ ...props }: FixedDataSlotProps<MenuPrimitive.Root.Props>) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: FixedDataSlotProps<MenuPrimitive.Portal.Props>) {
  const portalContainer = useUiPortalContainer();
  return (
    <MenuPrimitive.Portal
      data-slot="dropdown-menu-portal"
      container={portalContainer}
      {...props}
    />
  );
}

function DropdownMenuTrigger({ ...props }: FixedDataSlotProps<MenuPrimitive.Trigger.Props>) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  align = 'start',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  width = 'anchor',
  className,
  ...props
}: FixedDataSlotProps<MenuPrimitive.Popup.Props> &
  Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'> & {
    /**
     * `anchor`(默认)= 面板与触发器同宽,下拉框式;`content` = 宽度由内容决定。
     * 触发器窄而行内有「标签 + 当前值」两栏时用后者,否则那两栏会被挤到折行,见
     * `contentAutoWidth` 抬头。
     */
    width?: 'anchor' | 'content';
  }) {
  const portalContainer = useUiPortalContainer();
  return (
    <MenuPrimitive.Portal container={portalContainer}>
      <MenuPrimitive.Positioner
        className={styles.positioner}
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cx(
            'surface-elevated',
            styles.menuContent,
            width === 'content' && styles.contentAutoWidth,
            className
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({ ...props }: FixedDataSlotProps<MenuPrimitive.Group.Props>) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: FixedDataSlotProps<MenuPrimitive.GroupLabel.Props> & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cx(styles.menuLabel, className)}
      {...props}
    />
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: FixedDataSlotProps<MenuPrimitive.Item.Props> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cx(styles.menuItem, className)}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: FixedDataSlotProps<MenuPrimitive.SubmenuRoot.Props>) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: FixedDataSlotProps<MenuPrimitive.SubmenuTrigger.Props> & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cx(styles.menuSubTrigger, className)}
      {...props}
    >
      {children}
      <ChevronRightIcon style={{ marginLeft: 'auto' }} />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = 'start',
  alignOffset = -3,
  side = 'right',
  sideOffset = 0,
  className,
  ...props
}: FixedDataSlotProps<React.ComponentProps<typeof DropdownMenuContent>>) {
  return (
    // @ts-expect-error -- submenu content intentionally specializes the shared content shell's slot.
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cx(styles.subContentOverride, className)}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  ...props
}: FixedDataSlotProps<MenuPrimitive.CheckboxItem.Props> & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cx(styles.menuCheckboxItem, className)}
      checked={checked}
      {...props}
    >
      <span className={styles.menuItemIndicator} data-slot="dropdown-menu-checkbox-item-indicator">
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon strokeWidth={3} absoluteStrokeWidth />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: FixedDataSlotProps<MenuPrimitive.RadioGroup.Props>) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  closeOnClick = true,
  ...props
}: FixedDataSlotProps<MenuPrimitive.RadioItem.Props> & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cx(styles.menuRadioItem, className)}
      closeOnClick={closeOnClick}
      {...props}
    >
      <span className={styles.menuItemIndicator} data-slot="dropdown-menu-radio-item-indicator">
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon strokeWidth={3} absoluteStrokeWidth />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: FixedDataSlotProps<MenuPrimitive.Separator.Props>) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cx(styles.menuSeparator, className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({
  className,
  ...props
}: FixedDataSlotProps<React.ComponentProps<'span'>>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cx(styles.menuShortcut, className)}
      {...props}
    />
  );
}

export const DropdownMenu = {
  Root: DropdownMenuRoot,
  Portal: DropdownMenuPortal,
  Trigger: DropdownMenuTrigger,
  Content: DropdownMenuContent,
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Item: DropdownMenuItem,
  CheckboxItem: DropdownMenuCheckboxItem,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};
