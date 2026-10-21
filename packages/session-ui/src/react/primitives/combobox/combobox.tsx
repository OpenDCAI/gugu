import { Combobox as ComboboxPrimitive } from '@base-ui/react';
import { Button } from '@session-ui/react/primitives/button';
import { InputGroup } from '@session-ui/react/primitives/input-group';
import { useUiPortalContainer } from '@session-ui/react/lib/portal-container';
import { ScrollContainer } from '@session-ui/react/primitives/scroll-container';
import { cx } from '@session-ui/styles/utilities/cx';
import { CheckIcon, XIcon } from '../../../icons'
import * as React from 'react';
import type { FixedDataSlotProps } from '../fixed-data-slot';
import * as styles from './combobox.css';

const ComboboxRoot = ComboboxPrimitive.Root;

function ComboboxValue({ ...props }: FixedDataSlotProps<ComboboxPrimitive.Value.Props>) {
  return <ComboboxPrimitive.Value data-slot="combobox-value" {...props} />;
}

function ComboboxTrigger({
  className,
  children,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Trigger.Props>) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cx(styles.comboboxTrigger, className)}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Trigger>
  );
}

function ComboboxClear({ className, ...props }: FixedDataSlotProps<ComboboxPrimitive.Clear.Props>) {
  return (
    <ComboboxPrimitive.Clear
      data-slot="combobox-clear"
      render={<InputGroup.Button />}
      className={cx(className)}
      {...props}
    >
      <XIcon style={{ pointerEvents: 'none' }} />
    </ComboboxPrimitive.Clear>
  );
}

function ComboboxInput({
  className,
  children,
  disabled = false,
  showTrigger = true,
  showClear = false,
  leftAddon,
  rightAddon,
  inputRef,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Input.Props> & {
  showTrigger?: boolean;
  showClear?: boolean;
  leftAddon?: React.ReactNode;
  rightAddon?: React.ReactNode;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <InputGroup.Root
      variant="embedded"
      className={typeof className === 'string' ? className : undefined}
    >
      {leftAddon && <InputGroup.Addon align="inline-start">{leftAddon}</InputGroup.Addon>}
      <ComboboxPrimitive.Input
        render={<InputGroup.Input ref={inputRef} disabled={disabled} />}
        {...props}
      />
      <InputGroup.Addon align="inline-end">
        {rightAddon}
        {showTrigger && (
          // @ts-expect-error -- this composed trigger intentionally specializes Button's slot.
          <InputGroup.Button
            render={<ComboboxTrigger />}
            data-slot="input-group-button"
            className={styles.triggerButtonHideIfClear}
            disabled={disabled}
          />
        )}
        {showClear && <ComboboxClear disabled={disabled} />}
      </InputGroup.Addon>
      {children}
    </InputGroup.Root>
  );
}

function ComboboxContent({
  className,
  side = 'bottom',
  sideOffset = 6,
  align = 'start',
  alignOffset = 0,
  anchor,
  collisionAvoidance,
  positionerStyle,
  finalFocus = false,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Popup.Props> &
  Pick<
    ComboboxPrimitive.Positioner.Props,
    'side' | 'align' | 'sideOffset' | 'alignOffset' | 'anchor' | 'collisionAvoidance'
  > & {
    positionerStyle?: React.CSSProperties;
  }) {
  const portalContainer = useUiPortalContainer();
  return (
    <ComboboxPrimitive.Portal container={portalContainer}>
      <ComboboxPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className={styles.positioner}
        style={positionerStyle}
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          data-chips={!!anchor}
          finalFocus={finalFocus}
          className={cx('surface-elevated', styles.comboboxContent, className)}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxList({
  className,
  children,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.List.Props>) {
  return (
    <ScrollContainer
      maxHeight="min(18rem, calc(var(--available-height) - 2.25rem))"
      padding={2}
      className={styles.comboboxListScroller}
      viewportClassName={styles.comboboxListViewport}
    >
      <ComboboxPrimitive.List
        data-slot="combobox-list"
        className={cx(styles.comboboxList, className)}
        {...props}
      >
        {children}
      </ComboboxPrimitive.List>
    </ScrollContainer>
  );
}

function ComboboxItem({
  className,
  children,
  showCheck = true,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Item.Props> & { showCheck?: boolean }) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cx(styles.comboboxItem, className)}
      {...props}
    >
      {children}
      <ComboboxPrimitive.ItemIndicator render={<span className={styles.comboboxItemIndicator} />}>
        {showCheck && (
          <CheckIcon style={{ pointerEvents: 'none' }} absoluteStrokeWidth strokeWidth={3} />
        )}
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

function ComboboxGroup({ className, ...props }: FixedDataSlotProps<ComboboxPrimitive.Group.Props>) {
  return (
    <ComboboxPrimitive.Group data-slot="combobox-group" className={cx(className)} {...props} />
  );
}

function ComboboxLabel({
  className,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.GroupLabel.Props>) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cx(styles.comboboxLabel, className)}
      {...props}
    />
  );
}

function ComboboxCollection({
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Collection.Props>) {
  return <ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />;
}

function ComboboxEmpty({ className, ...props }: FixedDataSlotProps<ComboboxPrimitive.Empty.Props>) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cx(styles.comboboxEmpty, className)}
      {...props}
    />
  );
}

function ComboboxSeparator({
  className,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Separator.Props>) {
  return (
    <ComboboxPrimitive.Separator
      data-slot="combobox-separator"
      className={cx(styles.comboboxSeparator, className)}
      {...props}
    />
  );
}

function ComboboxChips({
  className,
  ...props
}: FixedDataSlotProps<
  React.ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> & ComboboxPrimitive.Chips.Props
>) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cx(styles.comboboxChips, className)}
      {...props}
    />
  );
}

function ComboboxChip({
  className,
  children,
  showRemove = true,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Chip.Props> & {
  showRemove?: boolean;
}) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cx(styles.comboboxChip, className)}
      {...props}
    >
      {children}
      {showRemove && (
        <ComboboxPrimitive.ChipRemove
          render={<Button variant="ghost" size="sm" icon />}
          className={styles.comboboxChipRemove}
          data-slot="combobox-chip-remove"
        >
          <XIcon style={{ pointerEvents: 'none' }} />
        </ComboboxPrimitive.ChipRemove>
      )}
    </ComboboxPrimitive.Chip>
  );
}

function ComboboxChipsInput({
  className,
  ...props
}: FixedDataSlotProps<ComboboxPrimitive.Input.Props>) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-chip-input"
      className={cx(styles.comboboxChipsInput, className)}
      {...props}
    />
  );
}

export function useComboboxAnchor() {
  return React.useRef<HTMLDivElement | null>(null);
}

export const Combobox = {
  Root: ComboboxRoot,
  Value: ComboboxValue,
  Trigger: ComboboxTrigger,
  Input: ComboboxInput,
  Content: ComboboxContent,
  List: ComboboxList,
  Item: ComboboxItem,
  Group: ComboboxGroup,
  Label: ComboboxLabel,
  Collection: ComboboxCollection,
  Empty: ComboboxEmpty,
  Separator: ComboboxSeparator,
  Chips: ComboboxChips,
  Chip: ComboboxChip,
  ChipsInput: ComboboxChipsInput,
};
