import { useEffect, useSyncExternalStore } from 'react';
import type { SupportedLocale } from '@/i18n/locale';
import { readSampleProjectShown, subscribeSampleProject } from '@/lib/sampleProject';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { log } from '@renderer/utils/logger';
import { enUSSampleProject } from './content/en-US';
import type { SampleProjectContent } from './content/types';
import { zhCNSampleProject } from './content/zh-CN';

const CONTENT: Record<SupportedLocale, SampleProjectContent> = { 'zh-CN': zhCNSampleProject, 'en-US': enUSSampleProject };

/** 示例项目跟着界面语言换一份(它是预先写好的内容,❌ 存在账号上)。 */
export function sampleProjectContent(locale: SupportedLocale): SampleProjectContent {
  return CONTENT[locale];
}

// 这个账号看不看得到示例项目:账号上那一个键(lib/sampleProject)。侧栏那一行和那一块读同一份,一个账号只读一次;
// 走完首次引导那一刻(主界面早已挂在引导下面)写上键,这里跟着重读。
// 读不到 ≠ 没有:那一行先不出现,屏上留着的那一块也不收(收了就存进布局、下次也没了),过一会儿再读。
type Reading = { userId: string; shown: boolean | null };
let reading: Reading | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
const RETRY_MS = [5_000, 30_000, 120_000, 300_000];
const listeners = new Set<() => void>();

function publish(next: Reading): void {
  reading = next;
  for (const listener of listeners) listener();
}

function load(userId: string, attempt = 0): void {
  if (retry) clearTimeout(retry);
  retry = null;
  publish({ userId, shown: null });
  readSampleProjectShown(userId).then(
    (shown) => { if (reading?.userId === userId) publish({ userId, shown }); },
    (error: unknown) => {
      log.error('[sample-project] reading the account key failed', { error: String(error), attempt });
      if (reading?.userId !== userId) return;
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      retry = setTimeout(() => { if (reading?.userId === userId) load(userId, attempt + 1); }, wait);
    },
  );
}

subscribeSampleProject((userId) => { if (reading?.userId === userId) load(userId); });

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export type SampleProjectOwner = { id: string; name: string; avatarUrl: string | null };

/**
 * `shown` = 键在、没删;`settled` = 这个账号的键读完了(读完是 hidden 的,屏上留着的那一块收掉)。
 * 主人(对话里「你」那一方)用他自己的名字和头像,壳经 assistant-shell 那条桥交过来(这棵树里没有登录态)。
 */
export function useSampleProject(): { shown: boolean; settled: boolean; owner: SampleProjectOwner | null } {
  const shell = useAssistantShell();
  const userId = shell?.ownerId ?? null;
  useEffect(() => {
    if (userId && reading?.userId !== userId) load(userId);
  }, [userId]);
  const current = useSyncExternalStore(subscribe, () => reading);
  const mine = !!userId && current?.userId === userId;
  return {
    shown: mine && current.shown === true,
    settled: mine && current.shown !== null,
    owner: userId ? { id: userId, name: shell?.ownerName ?? '', avatarUrl: shell?.ownerAvatar ?? null } : null,
  };
}
