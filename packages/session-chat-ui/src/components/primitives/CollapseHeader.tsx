/** @jsxImportSource solid-js */
/**
 * CollapseHeader — shared collapsible-row header primitive.
 *
 * Renders the row's label line, and — only when the row answers `collapsible`
 * with true — the whole disclosure apparatus:
 *   - `data-collapse-id` for the ChatRoot click-delegation handler
 *   - `role="button"` + `aria-expanded` reflecting the current expanded state
 *   - the pointer cursor and hover response
 *   - a rotating `›` chevron (90° when expanded)
 *
 * `collapsible` is REQUIRED, and that is the point. Whether a row hides
 * something is a geometry question only the row can answer — the primitive
 * cannot compute it — but it can refuse to be used without an answer. Five
 * consumers (execute / plan / thinking / file-op / tool-group) share this
 * header; a defaulted prop would let the sixth inherit a promise it never made.
 * A disclosure control that reveals nothing is a promise the row cannot keep,
 * which is the same rule tool rows and subagent headers already follow.
 *
 * The `children` slot holds the row label content (text, badge, etc.).
 */

import type { JSX } from 'solid-js';
import { Show } from 'solid-js';
import { IconError, IconShieldAlert } from './icons';
import {
  chevron,
  chevronExpanded,
  collapseHeader,
  collapseHeaderLabel,
  collapsibleRow,
  collapseStatusError,
  collapseStatusPermission,
} from './collapse-header.css';
import { ShimmerText } from './ShimmerText';
import { useChatTranslator } from '@session-chat/localization';

export type CollapseHeaderProps = {
  /** The item id wired to data-collapse-id for ChatRoot delegation. */
  id: string;
  /**
   * Whether expanding this row would show anything the collapsed row does not.
   *
   * Answered from the row's own geometry — "is the expanded body taller than the
   * one collapse already gives" — and read from the *collapsed* baseline, not
   * the current state, so the answer does not flip as the reader toggles the row.
   * False means the row renders no chevron, no toggle wiring and no pointer:
   * it looks and behaves exactly like a row that was never collapsible.
   */
  collapsible: boolean;
  /** Whether the section is currently expanded. */
  expanded: boolean;
  /**
   * When true, applies `text-shimmer` to the label (streaming / running state).
   */
  active?: boolean;
  /** When true, renders the error icon pinned to the far right. */
  error?: boolean;
  /** Native tooltip shown when hovering the error icon. */
  errorTitle?: string;
  /** When true, renders the awaiting-permission icon pinned to the far right. */
  awaitingPermission?: boolean;
  /** Explicit pixel height for the header row. */
  height: number;
  /** Wrapped summaries use off-screen line breaks and an explicitly measured height. */
  wrap?: boolean;
  labelSize?: number;
  labelLineHeight?: number;
  children: JSX.Element;
  /**
   * A short reading that sits beside the label and must not share its fate.
   *
   * The label slot is one flex item holding free-form text, so a long label
   * wraps inside it — and the row is a fixed `height` with the row root
   * clipping, so whatever sat at the end of that text is pushed out of view.
   * Measured at 320px with a header-filling summary: the label took two lines
   * and a trailing mark landed flush against the clip edge, one pixel from
   * disappearing. A separate flex item cannot be moved by the label's wrapping,
   * which is what makes this a slot rather than more children.
   */
  trailing?: JSX.Element;
};

export function CollapseHeader(props: CollapseHeaderProps) {
  const translate = useChatTranslator();
  return (
    <div
      class={collapseHeader}
      classList={{ [collapsibleRow]: props.collapsible }}
      style={{ height: `${props.height}px`, width: props.wrap ? '100%' : undefined }}
      // The header's identity, which does not depend on whether it is a toggle.
      // `data-collapse-id` cannot carry it: that attribute *is* the toggle wiring
      // and is absent on rows with nothing to reveal, so anything addressing the
      // header through it disappears exactly when the row stops being collapsible.
      // Same `data-slot` vocabulary the tool row already uses for its parts.
      data-slot="collapse-header"
      // Written as three separate attributes rather than one conditional spread:
      // each keeps its own reactive binding this way, and `aria-expanded` has to
      // track every toggle — a spread evaluated once would freeze it at whatever
      // the row mounted as. (The same shape tool.tsx uses, for the same reason.)
      role={props.collapsible ? 'button' : undefined}
      aria-expanded={props.collapsible ? (props.expanded ? 'true' : 'false') : undefined}
      data-collapse-id={props.collapsible ? props.id : undefined}
    >
      <ShimmerText multiline={props.wrap} class={collapseHeaderLabel} active={!!props.active} style={props.wrap ? { 'white-space': 'pre-wrap', overflow: 'visible', 'overflow-wrap': 'normal', 'font-size': `${props.labelSize ?? 12}px`, 'line-height': `${props.labelLineHeight ?? 18}px`, flex: '1 1 auto' } : undefined}>
        {props.children}
      </ShimmerText>
      {props.trailing}
      <Show when={props.collapsible}>
        <span class={chevron} classList={{ [chevronExpanded]: props.expanded }} aria-hidden="true">
          ›
        </span>
      </Show>
      <Show
        when={props.awaitingPermission}
        fallback={
          <Show when={props.error}>
            <span
              class={collapseStatusError}
              title={props.errorTitle ?? translate('transcript.failed')}
              aria-label={translate('transcript.error')}
            >
              <IconError />
            </span>
          </Show>
        }
      >
        <span
          class={collapseStatusPermission}
          title={translate('transcript.awaitingPermission')}
          aria-label={translate('transcript.awaitingPermission')}
        >
          <IconShieldAlert />
        </span>
      </Show>
    </div>
  );
}
