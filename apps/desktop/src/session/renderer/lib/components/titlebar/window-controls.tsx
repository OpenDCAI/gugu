import { detectHostOs } from '@shared/host-os';
import { Copy, Square, X } from '@/lib/icons'
import { Minus } from '@/lib/icons'
import { type ReactNode, useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { cn } from '@renderer/utils/utils';
import { windowMaximizeChangedChannel } from '@shared/events/appEvents';

const isLinux = detectHostOs() === 'linux';

/**
 * Linux-only top overlay providing a draggable strip and window controls for
 * full-screen views that do not render the {@link Titlebar} (onboarding and the
 * welcome splash). Sits above the welcome screen's `z-50` overlay.
 *
 * ⚠️ 这里只管**会话页自己**那层全屏覆盖。Windows 的窗口按钮由**咕咕壳**画
 * (`src/components/WindowControls.tsx`,经 `hasCustomWindowControls` 判定),
 * 会话页坐在壳里,所以这一层在 Windows 上不必再画一份。
 * (旧注释写「Windows keeps the native frame」—— #822 之后 Windows 是 `frame:false` + 自绘,
 *  那句话是错的,照它去改会得到一个没有窗口按钮的 Windows 窗口。)
 */
export function FramelessTitlebarOverlay() {
  if (!isLinux) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-60 flex h-10 items-center justify-end [-webkit-app-region:drag]">
      <WindowControls />
    </div>
  );
}

/**
 * Custom window controls (minimize / maximize / close) for the frameless Linux
 * window. macOS keeps its native traffic lights; Windows 的那份由咕咕壳画
 * (见上面 {@link FramelessTitlebarOverlay} 的注释)—— 所以这一份只在 Linux 渲染(见 Titlebar)。
 */
export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void rpc.app.isWindowMaximized().then(setIsMaximized);
    return events.on(windowMaximizeChangedChannel, ({ maximized }) => setIsMaximized(maximized));
  }, []);

  return (
    <div className="flex h-full items-center [-webkit-app-region:no-drag]">
      <ControlButton label="Minimize" onClick={() => void rpc.app.minimizeWindow()}>
        <Minus className="h-4 w-4" />
      </ControlButton>
      <ControlButton
        label={isMaximized ? 'Restore' : 'Maximize'}
        onClick={() => void rpc.app.toggleMaximizeWindow()}
      >
        {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
      </ControlButton>
      <ControlButton label="Close" danger onClick={() => void rpc.app.closeWindow()}>
        <X className="h-4 w-4" />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  children,
  label,
  onClick,
  danger,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-10 w-12 items-center justify-center text-foreground-muted transition-colors hover:bg-row-hover active:bg-row-press',
        // @@@chrome-is-ink (Refs #6106) — ❌ 别写回 `bg-red-500` / `text-white`:原生调色板与
        // `#fff` 都不随主题走,而且 design.md 的 color register 只认语义档。
        danger && 'hover:bg-background-destructive hover:text-foreground-destructive'
      )}
    >
      {children}
    </button>
  );
}
