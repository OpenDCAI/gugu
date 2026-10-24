// #7199 助理 App 的数据:说明、记忆、资料都是它家里的文件(云上那台,或人自己的一台电脑)。
// owner 10-17:Agent 没有休息这回事 —— 要读它家里的东西、它住的云端宿主正收回着,由系统叫起来(MachineGate 里
// useWakeHomeForRead,每挂一次只叫一次),界面只说「正在连接」;与在聊天里发话、打开它上面的会话同一个动作
// (remoteHostsStore.wakeCloudComputer)。
// 读不到如实说是哪一步,❌ 显示一片空当成「什么都没有」。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { rpc, onMachineEvent } from '@renderer/lib/ipc';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import { watchAssistantMemory } from './assistant-memory-watch';
import { appState } from '@renderer/lib/stores/app-state';
import type { DirectoryEntry } from '@shared/core/fs/fs';
import {
  joinPath,
  parseSkill,
  splitInstructions,
  type InstructionsParts,
  type SkillInfo,
} from './assistant-files';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { homeSessions, homeTarget } from './assistant-home-sessions';
import { isAssistantSession } from './assistant-lineage';
import { listDirectory, openAssistantMachine, readMemoryNotes, readText, type AssistantMachine, type MemoryEntry } from './assistant-machine';

export type { MemoryEntry } from './assistant-machine';
import { TODAY_FILE_NAME, TODAY_REFRESH_MS, TodayReadError, todayReadOf, type TodayRead } from './assistant-today-file';

export type MachineReadiness =
  /** 线连着,可以读。 */
  | 'ready'
  /** 它住的云端宿主收回着:要读就得叫起来(由读的那一块交给系统去叫,❌ 让人按)。 */
  | 'asleep'
  /** 正在叫醒 / 连接中:等一会儿就好。 */
  | 'waiting'
  /** 叫不醒、离线、版本不对:读不了,原因由页上那句说。 */
  | 'unreachable';

/**
 * 它家那台此刻能不能读(只读状态,❌ 叫醒)。observer 里调。
 * 住眼前这台电脑 = 一直能读(App 开着它就在);住另一台电脑 = 那台连得上才能读,关着 / 连不上就如实说读不了(没有「叫醒」这回事)。
 */
export function homeReadiness(home: AssistantHomePlace | null): MachineReadiness {
  if (!home) return 'waiting';
  if (home.kind === 'cloud') return machineReadiness(home.deviceId);
  if (homeTarget(home) === null) return 'ready';
  const state = remoteHostsStore.connectionState(home.deviceId);
  if (state === 'connected') return 'ready';
  if ((state === 'connecting' || state === 'reconnecting' || state === null) && home.online) return 'waiting';
  return 'unreachable';
}

/** 那台云电脑此刻能不能读(只读状态,❌ 叫醒)。observer 里读才跟着变;不是 React hook,录音机在 App 外头也现读。 */
export function machineReadiness(deviceId: string | null): MachineReadiness {
  const state = deviceId ? remoteHostsStore.connectionState(deviceId) : null;
  if (state === 'connected') return 'ready';
  if (state === 'asleep') return 'asleep';
  if (state === 'waking' || state === 'connecting' || state === 'reconnecting' || state === null) return 'waiting';
  return 'unreachable';
}

/** 同 `machineReadiness`(旧名,留给已有的调用方)。 */
export const useMachineReadiness = machineReadiness;

/** 人按了「叫醒它」。 */
/** 叫醒它住的云端宿主;false = 没叫成(原因记在 remoteHostsStore.wakes),或这个宿主叫不了(老宿主,没记原因)。 */
export function wakeAssistantMachine(deviceId: string): Promise<boolean> {
  return remoteHostsStore.wakeCloudComputer(deviceId);
}

export const assistantQueryKey = (deviceId: string, ...parts: unknown[]) => ['assistant', deviceId, ...parts];

/**
 * 助理那条会话跑在哪个目录:会话目录里它自己那一行 → 那个项目的路径。读的是会话目录(列出不挂载),所以是 observer 里调。
 * pending = 目录还不是此刻的读数(刚连上);missing = 此刻的目录里没有它的会话(如实说,❌ 退回主目录去读一片空)。
 */
export type AssistantWorkdir = { state: 'found'; path: string } | { state: 'pending' } | { state: 'missing' };

export function assistantWorkdir(home: AssistantHomePlace, assistantId: string): AssistantWorkdir {
  const { sessions, live } = homeSessions(home);
  const own = sessions.find((session) => isAssistantSession(session, assistantId));
  const path = own ? appState.projects.projects.get(own.projectId)?.data?.path ?? null : null;
  if (path) return { state: 'found', path };
  return live ? { state: 'missing' } : { state: 'pending' };
}

export function useAssistantMachine(home: AssistantHomePlace | null, readiness: MachineReadiness, workdir: string | null) {
  return useQuery({
    queryKey: assistantQueryKey(home?.deviceId ?? '', 'machine', home?.kind, workdir),
    queryFn: () => openAssistantMachine(home!, workdir!),
    enabled: !!home && !!workdir && readiness === 'ready',
    staleTime: Infinity,
    retry: 1,
  });
}

export function useInstructions(machine: AssistantMachine | undefined) {
  return useQuery<InstructionsParts & { raw: string }>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'instructions'),
    queryFn: async () => {
      const raw = (await readText(machine!, machine!.paths.instructions)) ?? '';
      return { ...splitInstructions(raw), raw };
    },
    enabled: !!machine,
  });
}


export function useMemoryNotes(machine: AssistantMachine | undefined) {
  const [watchAttempt, retryWatch] = useState(0);
  const [watchFailure, setWatchFailure] = useState<{ machine: AssistantMachine; error: Error } | null>(null);
  const query = useQuery<{ notes: MemoryEntry[]; index: string | null }>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'memory'),
    queryFn: () => readMemoryNotes(machine!),
    enabled: !!machine,
  });
  useEffect(() => {
    if (!machine) return;
    return watchAssistantMemory(machine,
      receive => onMachineEvent(machine.target ?? null, fileChangesChannel, receive),
      () => { void query.refetch(); },
      error => { setWatchFailure({ machine, error: error instanceof Error ? error : new Error(String(error)) }); });
  }, [machine, query.refetch, watchAttempt]);
  const refetch = useCallback((...args: Parameters<typeof query.refetch>) => {
    setWatchFailure(null);
    retryWatch(value => value + 1);
    return query.refetch(...args);
  }, [query.refetch]);
  const error = watchFailure && watchFailure.machine === machine ? watchFailure.error : query.error;
  return { ...query, refetch, error, isError: !!error };
}

export type SkillEntry = SkillInfo & { path: string; modifiedAt: string | null };

/** 自己做的技能(~/.claude/skills 下每一夹一个)。App 带的、连接应用带的另算,见 assistant-skills-page。 */
export function useOwnSkills(machine: AssistantMachine | undefined) {
  return useQuery<SkillEntry[]>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'skills'),
    queryFn: async () => {
      const m = machine!;
      const dirs = (await listDirectory(m, m.paths.skillsDir)).filter((e) => e.type === 'directory');
      const skills = await Promise.all(
        dirs.map(async (dir) => {
          const text = await readText(m, joinPath(dir.path, 'SKILL.md'));
          return text === null ? null : { ...parseSkill(dir.name, text), path: dir.path, modifiedAt: entryTime(dir) };
        })
      );
      return skills.filter((s): s is SkillEntry => s !== null).sort((a, b) => a.name.localeCompare(b.name));
    },
    enabled: !!machine,
  });
}

export function useDirectory(machine: AssistantMachine | undefined, dir: string | null) {
  return useQuery<DirectoryEntry[]>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'dir', dir),
    queryFn: () => listDirectory(machine!, dir!),
    enabled: !!machine && !!dir,
  });
}

export function useInvalidateAssistant(deviceId: string | null) {
  const client = useQueryClient();
  return (...parts: unknown[]) => client.invalidateQueries({ queryKey: assistantQueryKey(deviceId ?? '', ...parts) });
}

function entryTime(entry: DirectoryEntry): string | null {
  const value = (entry as { modifiedAt?: unknown }).modifiedAt;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return null;
}

/**
 * 「今天」页那一份(today.json,在和它那条私聊的文件夹里;assistant-today-file.ts)。
 * 桌面在主进程读(chat-folder-text.ts),❌ 叫醒云电脑:它睡着也照样看得到。
 * 它早晚改这一份;此刻没有「文件夹变了」的推送到这棵树,每分钟再问一次(与「动态」页刷新信息流同一个节奏)。
 */
export function useTodayFile(chatId: string | null) {
  return useQuery<TodayRead>({
    queryKey: ['assistant', 'today', chatId],
    queryFn: async () => {
      const result = await rpc.extensions.readChatFolderText({ chat: chatId!, name: TODAY_FILE_NAME });
      if (!result.success) throw new TodayReadError(result.kind, result.error);
      return todayReadOf(result.data);
    },
    enabled: !!chatId,
    refetchInterval: TODAY_REFRESH_MS,
    retry: 1,
  });
}
