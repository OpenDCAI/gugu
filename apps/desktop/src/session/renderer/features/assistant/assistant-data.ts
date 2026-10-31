import { isAssistantPanelReadRetryable, retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel';
import { useEffect, useMemo } from 'react';
import { assistantPanelAccountId } from '@/lib/assistantPanelBridge';
import { ASSISTANT_PANEL_CHANGED, useCloudAssistantFiles } from '@/components/assistant/assistant-panel-files';
import { rpc } from '@renderer/lib/ipc';
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
import { homeSessions } from './assistant-home-sessions';
import { isAssistantSession } from './assistant-lineage';
import { listDirectory, readMemoryNotes, readText, type AssistantMachine, type MemoryEntry } from './assistant-machine';

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

export const assistantQueryKey = (deviceId: string, ...parts: unknown[]) => ['assistant', assistantPanelAccountId() ?? '', deviceId, ...parts];

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

export function useAssistantMachine(assistantId: string | null, chatId: string | null, home: AssistantHomePlace | null, chatReadFailed = false) {
  const data = useCloudAssistantFiles(assistantId,chatId,home?.deviceId ?? null);
  const client = useQueryClient();
  useEffect(() => {
    const changed = () => { void client.invalidateQueries({ queryKey: ['assistant'] }); };
    window.addEventListener(ASSISTANT_PANEL_CHANGED,changed);
    return () => window.removeEventListener(ASSISTANT_PANEL_CHANGED,changed);
  },[client]);
  const isLoading = !!assistantId && !!home?.deviceId && !chatId && !chatReadFailed;
  const error = useMemo(() => data || isLoading ? null : new AssistantPanelError(home?.deviceId ? 'missing-identity' : 'missing-home','PANEL_IDENTITY_UNAVAILABLE'),[data,home?.deviceId,isLoading]);
  return { data,isLoading,error,refetch: () => data?.panel?.invalidate() };
}

export function useInstructions(machine: AssistantMachine | undefined) {
  return useQuery<InstructionsParts & { raw: string; revision?: string }>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'instructions'),
    queryFn: async () => {
      const raw = (await readText(machine!, machine!.paths.instructions)) ?? '';
      return { ...splitInstructions(raw), raw, revision: machine?.panel?.revision(machine.paths.instructions) };
    },
    enabled: !!machine,
    retry: retryAssistantPanelRead,
    refetchOnWindowFocus: query => isAssistantPanelReadRetryable(query.state.error),
  });
}


export function useMemoryNotes(machine: AssistantMachine | undefined) {
  return useQuery<{ notes: MemoryEntry[]; index: string | null }>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'memory'),
    queryFn: () => readMemoryNotes(machine!),
    enabled: !!machine,
    retry: retryAssistantPanelRead,
    refetchOnWindowFocus: query => isAssistantPanelReadRetryable(query.state.error),
  });
}

export type SkillEntry = SkillInfo & { path: string; modifiedAt: string | null };

/** 自己做的技能(~/.claude/skills 下每一夹一个)。App 带的、连接应用带的另算,见 assistant-skills-page。 */
export function useOwnSkills(machine: AssistantMachine | undefined) {
  return useQuery<SkillEntry[]>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'skills'),
    queryFn: async () => {
      const m = machine!;
      if (m.panel) return (await m.panel.collection('skills')).map(row => ({ dir: row.resource_key,name: String(row.data.name ?? row.resource_key),
        description: String(row.data.description ?? ''),body: '',path: joinPath(m.paths.skillsDir,row.resource_key),modifiedAt: String(row.data.modifiedAt ?? row.updated_at) }))
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
    retry: retryAssistantPanelRead,
    refetchOnWindowFocus: query => isAssistantPanelReadRetryable(query.state.error),
  });
}

export function useDirectory(machine: AssistantMachine | undefined, dir: string | null) {
  return useQuery<DirectoryEntry[]>({
    queryKey: assistantQueryKey(machine?.deviceId ?? '', 'dir', dir),
    queryFn: () => listDirectory(machine!, dir!),
    enabled: !!machine && !!dir,
    retry: retryAssistantPanelRead,
    refetchOnWindowFocus: query => isAssistantPanelReadRetryable(query.state.error),
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
