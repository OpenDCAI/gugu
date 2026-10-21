import { useParams, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';

export function useIsActiveSession(sessionId: string): boolean {
  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('session');
  return currentView === 'session' && params.sessionId === sessionId;
}
