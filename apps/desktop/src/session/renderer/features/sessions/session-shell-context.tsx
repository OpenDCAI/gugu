import { observer } from 'mobx-react-lite';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { workspacePanelChromeStore } from './stores/workspace-panel-chrome-store';

interface SessionShellContextValue {
  isNewSessionWorkspaceOpen: boolean;
  setNewSessionWorkspaceOpen: (open: boolean) => void;
  /** 草稿面板报自己开了几格;面板空了就收起。 */
  setDraftTabCount: (count: number) => void;
}

const SessionShellContext = createContext<SessionShellContextValue | null>(null);

/**
 * 草稿页(还没建任务)的面板与会话页读同一份 app 级形态:用户在哪儿展开的,到哪儿都是展开的。
 * observer:形态一变(比如在会话页收起了),草稿页跟着变。
 */
export const SessionShellProvider = observer(function SessionShellProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [draftTabCount, setDraftTabCount] = useState(0);
  const [forcedOpen, setForcedOpen] = useState(false);
  const hasContent = draftTabCount > 0;
  const collapsed = workspacePanelChromeStore.collapsed;
  useEffect(() => {
    if (!hasContent) setForcedOpen(false);
  }, [hasContent]);
  const isNewSessionWorkspaceOpen = !collapsed && (hasContent || forcedOpen);
  const value = useMemo(
    () => ({
      isNewSessionWorkspaceOpen,
      setNewSessionWorkspaceOpen: (open: boolean) => {
        workspacePanelChromeStore.setCollapsed(!open);
        setForcedOpen(open && !hasContent);
      },
      setDraftTabCount,
    }),
    [hasContent, isNewSessionWorkspaceOpen]
  );

  return <SessionShellContext.Provider value={value}>{children}</SessionShellContext.Provider>;
});

export function useSessionShellContext(): SessionShellContextValue {
  const context = useContext(SessionShellContext);
  if (!context) throw new Error('useSessionShellContext must be used within SessionShellProvider');
  return context;
}
