// #6264 在别的机器上新建、选的这家那台机器上还没装:先说清发送后会先在那台机器上装(与本机「去装」不同,
// 不装在这台电脑上);发送之后换成真实进度(阶段 · 已完成 / 总共 · 速度 · 剩余,与本机安装同一行)。
// 新建框(new-session-page.tsx 的 NewSessionComposer)经 useRemoteInstallBeforeCreate 接这一截。
import { useState, type ReactElement } from 'react';
import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import { installProgressLine } from '@renderer/features/settings/agents-page/install-progress-line';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { agentInstallProgressChannel } from '@shared/events/appEvents';

type RemoteInstall = { harness: string; progress: AgentInstallProgress | null };

/**
 * 发送前说「发送后会先在那台机器上装好」;发送后那边在装时换成真实进度,有分母才给比例。
 */
export function remoteInstallNote(
  agent: { id: string; name: string; reading: string } | null,
  deviceLabel: string,
  remoteInstall: RemoteInstall | null,
  translate: ReturnType<typeof useSessionMessages>['translate']
): { text: string; ratio: number | null } | null {
  if (!agent) return null;
  const names = { agent: agent.name, device: deviceLabel };
  if (remoteInstall && remoteInstall.harness === agent.id) {
    const line = installProgressLine(remoteInstall.progress, translate);
    return {
      text: line
        // 槽里是本机拼好的进度行(阶段 · 已完成/总共 · 速度 · 剩余),❌ 那台机器吐的原文。
        ? translate('remoteHost.installingDetail', { ...names, progress: line.text })
        : translate('remoteHost.installing', names),
      ratio: line?.ratio ?? null,
    };
  }
  if (agent.reading === 'not-detected') return { text: translate('remoteHost.installOnCreate', names), ratio: null };
  return null;
}

/**
 * 在那台机器上把这家装好(与资源库里「安装」同一个控制器,装在那台机器上),装的同时把进度交给 `onProgress`。
 */
async function installOnMachine(
  deviceId: string,
  providerId: string,
  onProgress: (progress: AgentInstallProgress | null) => void
): Promise<void> {
  onProgress(null);
  const stop = onMachineEvent(deviceId, agentInstallProgressChannel, (progress) => {
    if (progress.providerId === providerId) onProgress(progress);
  });
  try {
    await rpcOn(deviceId).agents.install(providerId as never);
  } finally {
    stop();
  }
}

/**
 * `beforeCreate`:那台机器上没装所选的家时,建会话前先装(装不上就不建);`note`:那一行说明 / 进度。
 * `machine` 为 null(本机)时两者都缺席。
 */
export function useRemoteInstallBeforeCreate(
  machine: { deviceId: string; label: string } | null,
  providerId: string | null | undefined
): { beforeCreate: (() => Promise<void>) | undefined; note: ReactElement | null } {
  const { translate } = useSessionMessages();
  const { data: agents } = useAgents();
  const agent = agents?.find((candidate) => candidate.id === providerId) ?? null;
  const [remoteInstall, setRemoteInstall] = useState<RemoteInstall | null>(null);
  const beforeCreate =
    machine && agent?.reading === 'not-detected'
      ? () => installOnMachine(machine.deviceId, agent.id, (progress) =>
          setRemoteInstall({ harness: agent.id, progress })
        ).finally(() => setRemoteInstall(null))
      : undefined;
  const note = machine ? remoteInstallNote(agent, machine.label, remoteInstall, translate) : null;
  return {
    beforeCreate,
    note: note ? (
      <div
        aria-live="polite"
        data-testid="remote-install-note"
        className="flex flex-col gap-1 border-t border-border px-4 py-2 text-xs text-[var(--em-foreground-muted)]"
      >
        <span>{note.text}</span>
        {note.ratio !== null ? <progress className="h-1 w-full accent-live" value={note.ratio} max={1} /> : null}
      </div>
    ) : null,
  };
}
