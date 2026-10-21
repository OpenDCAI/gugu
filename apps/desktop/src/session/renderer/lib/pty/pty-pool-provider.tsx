import { useEffect, type ReactNode } from 'react';
import { disposeAllPtys } from './pty';

export function TerminalPoolProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    return () => {
      disposeAllPtys();
    };
  }, []);

  return <>{children}</>;
}
