import { defineEvent } from '@shared/lib/ipc/events';

export type ProvisionStep =
  | 'resolving-worktree'
  | 'initialising-workspace'
  | 'running-provision-script'
  | 'connecting'
  | 'setting-up-workspace'
  | 'starting-sessions';

export const sessionProvisionProgressChannel = defineEvent<{
  sessionId: string;
  projectId: string;
  step: ProvisionStep;
  message: string;
}>('session:provision-progress');

export type LifecycleScriptType = 'setup' | 'run' | 'teardown';
export type LifecycleScriptOrigin = 'auto-setup' | 'auto-run' | 'manual' | 'workspace-destroy';

export type LifecycleScriptStatusEvent = {
  projectId: string;
  workspaceId: string;
  type: LifecycleScriptType;
  origin: LifecycleScriptOrigin;
} & (
  | { status: 'running' }
  | { status: 'succeeded'; exitCode?: number }
  | {
      status: 'failed';
      message: string;
      surfaceFailure: boolean;
      exitCode?: number;
      signal?: string | number;
    }
  | { status: 'stopped'; message?: string }
);

export const lifecycleScriptStatusChannel = defineEvent<LifecycleScriptStatusEvent>(
  'session:lifecycle-script-status'
);

export const sessionProvisionedChannel = defineEvent<{
  sessionId: string;
  projectId: string;
  path: string;
  workspaceId: string;
}>('session:provisioned');

/**
 * spec idle-reclaim:这条会话的进程被闲置回收停掉了。渲染层把它挂起成「没准备」,界面(视图模型、页签、
 * 滚动位置)原样留着,下次显示时照常 provision、按原会话续上(#6950)。
 */
export const sessionReclaimedChannel = defineEvent<{
  projectId: string;
  sessionId: string;
}>('session:session-reclaimed');
