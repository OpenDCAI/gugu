import { createContext, useContext } from 'react';
import type { WorkspaceConfigState } from '@renderer/features/sessions/create-session-modal/use-workspace-config';
import type { InitialSessionState } from '@renderer/features/sessions/session-config/initial-session-section';
import type { LinkedIssue } from '@shared/core/linked-issue';

export type SessionStateContextValue = {
  workspaceConfig: WorkspaceConfigState;
  initialSession: InitialSessionState;
  projectId?: string;
  isUnborn: boolean;
  hasPR: boolean;
  linkedIssue?: LinkedIssue;
  includeIssueContextByDefault: boolean;
};

const SessionStateContext = createContext<SessionStateContextValue | null>(null);

export function SessionStateProvider({
  children,
  ...value
}: SessionStateContextValue & { children: React.ReactNode }) {
  return <SessionStateContext.Provider value={value}>{children}</SessionStateContext.Provider>;
}

export function useSessionState(): SessionStateContextValue {
  const ctx = useContext(SessionStateContext);
  if (!ctx) {
    throw new Error('useSessionState must be used inside a SessionStateProvider');
  }
  return ctx;
}
