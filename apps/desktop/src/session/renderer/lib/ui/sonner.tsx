import { Toaster as SonnerToaster } from 'sonner';
import { useTheme } from '@renderer/lib/hooks/useTheme';

export function Toaster() {
  const { effectiveTheme } = useTheme();
  const theme = effectiveTheme === 'emlight' ? 'light' : 'dark';

  return (
    <SonnerToaster
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          // @@@floating-recipe (Refs #6106) — 浮层公式:底色 + 圆角档 + 一层 lift,不叠线。
          // toast 与 dialog 同属 --radius-xl(12px)那一档。
          toast: 'group toast rounded-xl bg-background-quaternary text-foreground shadow-lift',
          description: 'text-foreground-muted',
          actionButton: 'bg-primary-button-background text-primary-button-foreground',
          cancelButton: 'bg-background-2 text-foreground-muted',
          error: 'text-foreground-destructive border-border-destructive/50',
        },
      }}
    />
  );
}
