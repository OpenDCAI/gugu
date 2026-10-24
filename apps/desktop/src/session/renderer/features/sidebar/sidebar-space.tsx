import type { ReactNode } from 'react';
import { SIDEBAR_HEADER_CONTROLS_PX } from '@/lib/window-chrome';

/**
 * Search shares the 40px header with layout and collapse on every desktop platform.
 * ShellSidebarToggle owns the two fixed controls, so they stay reachable when the list slides away.
 */
export function SidebarSpace({ children }: { children?: ReactNode }) {
  return (
    <div
      className="flex h-10 w-full shrink-0 items-center pr-3 [-webkit-app-region:drag]"
      style={{ paddingLeft: SIDEBAR_HEADER_CONTROLS_PX }}
      data-sidebar-space=""
    >
      {children}
    </div>
  );
}
