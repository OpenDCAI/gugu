import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { workspaceRegistry } from './stores/workspace-registry';
import { useWorkspaceId } from './session-view-context';

export function isProtectedMacDirectory(platform: string, home: string, cwd: string): boolean {
  if (platform !== 'darwin' || !home.startsWith('/') || cwd.split('/').includes('..')) return false;
  return ['Documents', 'Desktop', 'Downloads'].some((folder) => {
    const root = `${home.replace(/\/$/, '')}/${folder}`;
    return cwd === root || cwd.startsWith(`${root}/`);
  });
}

/** 仅在本机受保护目录的启动加载态挂载;系统不提供 Documents 授权等待信号。 */
export const SessionPermissionHint = observer(function SessionPermissionHint({ projectId }: { projectId: string }) {
  const { translate } = useSessionMessages();
  const workspaceId = useWorkspaceId();
  const cwd = workspaceRegistry.get(projectId, workspaceId)?.path;
  const local = machineRegistry.machineOf(projectId) === null;
  const { data: host } = useQuery({
    queryKey: ['system-permission-hint-host'],
    queryFn: () => Promise.all([rpc.app.getPlatform(), rpc.app.getHomeDirectory()]),
    enabled: local && !!cwd,
    staleTime: Infinity,
  });
  const [shownFor, setShownFor] = useState<string | null>(null);
  const eligible = local && cwd && host && isProtectedMacDirectory(host[0], host[1], cwd);
  useEffect(() => {
    if (!eligible || !cwd) return;
    const timer = setTimeout(() => setShownFor(cwd), 10_000);
    return () => clearTimeout(timer);
  }, [eligible, cwd]);
  return eligible && shownFor === cwd
    ? <p role="status" className="text-center text-sm text-foreground-muted">{translate('chat.systemPermissionHint')}</p>
    : null;
});
