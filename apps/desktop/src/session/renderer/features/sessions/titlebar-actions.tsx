import type { ReactNode } from 'react';
import {
  readRendererPlatform,
  TITLEBAR_ACTION_EDGE_GAP_PX,
  TITLEBAR_ACTION_SLOT_GAP_PX,
  TITLEBAR_ACTION_SLOT_WIDTH_PX,
  titlebarActionsRight,
  WINDOW_CONTROL_BAR_HEIGHT_PX,
} from '@/lib/window-chrome';

/** Shared geometry for actions in a task's tab strip. Reserve window controls only at the window edge. */
export function TabBarActionRow({
  children,
  atWindowEdge,
}: {
  children?: ReactNode;
  atWindowEdge: boolean;
}) {
  return (
    <div
      className="flex shrink-0 items-center"
      // Inline geometry also works outside the skin, whose reset overrides utility-layer spacing.
      style={{
        height: `${TITLEBAR_ACTION_SLOT_WIDTH_PX}px`,
        marginBlock: `${(WINDOW_CONTROL_BAR_HEIGHT_PX - TITLEBAR_ACTION_SLOT_WIDTH_PX) / 2}px`,
        alignSelf: 'flex-start',
        paddingInlineStart: `${TITLEBAR_ACTION_SLOT_GAP_PX * 2}px`,
        paddingInlineEnd: `${atWindowEdge ? titlebarActionsRight(readRendererPlatform()) : TITLEBAR_ACTION_EDGE_GAP_PX}px`,
        gap: `${TITLEBAR_ACTION_SLOT_GAP_PX}px`,
      }}
      data-tabbar-actions=""
      data-tabbar-actions-edge={atWindowEdge ? '' : undefined}
    >
      {children}
    </div>
  );
}
