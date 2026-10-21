import type { GitBranchRef } from '@gugu/session-core/git';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSessionSettings } from '@renderer/features/sessions/hooks/useSessionSettings';
import { rpc } from '@renderer/lib/ipc';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { getIssueSessionName } from './issue-session-name';
import { useSessionName } from './use-session-name';
import { useWorkspaceConfig } from './use-workspace-config';

export type LinkedType = 'issue' | 'pr' | null;

export type CreateSessionState = ReturnType<typeof useCreateSessionState>;

export function useCreateSessionState(
  projectId: string | undefined,
  defaultBranch: GitBranchRef | undefined,
  isUnborn: boolean,
  currentBranch: string | null,
  repositoryWorkspaceId: string | null | undefined,
  initialPR?: PullRequest,
  initialLinkedType: LinkedType = null,
  opts?: {
    /**
     * Callers that render no task-name input (新建任务 整页 composer) must always get a
     * generated name. `autoGenerateName` defaults to false and only means "pre-fill the
     * modal's name field" — with no field to fill, honouring it leaves effectiveSessionName
     * permanently '' → isValid false → 发送键永远置灰、回车无反应 (owner: 对话都没法对话).
     */
    requireGeneratedName?: boolean;
    /**
     * 会话直接跑在项目目录里,不替它另开 worktree(owner: session 就是 task,不用在外面多套
     * 一层;各家 agent 自己会开 worktree,gugu 再 fork 一层是重复劳动)。
     * 走 repo-root 预设 = git kind 'none' + 项目自己的 repository-instance,于是分支冲突、
     * 空仓库无法建分支这些创建前置校验全部不存在 —— 创建这个动作不再可能失败。
     */
    runInProjectDir?: boolean;
  }
) {
  const { autoGenerateName: autoGenerateNameSetting } = useSessionSettings();
  const autoGenerateName = autoGenerateNameSetting || opts?.requireGeneratedName === true;

  const [linkedType, setLinkedTypeRaw] = useState<LinkedType>(initialPR ? 'pr' : initialLinkedType);
  const [linkedIssue, setLinkedIssueRaw] = useState<LinkedIssue | null>(null);
  const [linkedPR, setLinkedPRRaw] = useState<PullRequest | null>(initialPR ?? null);
  const [prevProjectId, setPrevProjectId] = useState(projectId);

  // Reset linked state when project changes.
  if (projectId !== prevProjectId) {
    setPrevProjectId(projectId);
    setLinkedTypeRaw(null);
    setLinkedIssueRaw(null);
    setLinkedPRRaw(null);
  }

  // Stable random key for the "plain task" name generation — one per modal session.
  const randomKey = useMemo(() => crypto.randomUUID(), []);

  // Random name query — used when no issue/PR is selected yet.
  const hasLinkedEntity =
    (linkedType === 'issue' && linkedIssue !== null) || (linkedType === 'pr' && linkedPR !== null);
  const { data: randomName, isPending: isRandomPending } = useQuery({
    queryKey: ['generateSessionName', 'random', randomKey],
    queryFn: () => rpc.sessionCreate.generateSessionName({}),
    enabled: autoGenerateName && !hasLinkedEntity,
    refetchOnWindowFocus: false,
  });

  // Issue-derived name (Linear can derive directly from branchName; others need AI)
  const directIssueSessionName = getIssueSessionName(linkedIssue);
  const shouldGenerateFromIssue =
    autoGenerateName &&
    linkedType === 'issue' &&
    linkedIssue !== null &&
    directIssueSessionName === null;
  const { data: issueGeneratedName, isPending: isIssuePending } = useQuery({
    queryKey: ['generateSessionName', linkedIssue?.title ?? null, linkedIssue?.description ?? null],
    queryFn: () =>
      rpc.sessionCreate.generateSessionName({
        title: linkedIssue!.title,
        description: linkedIssue!.description,
      }),
    enabled: shouldGenerateFromIssue,
    refetchOnWindowFocus: false,
  });

  // PR-derived name
  const shouldGenerateFromPR = autoGenerateName && linkedType === 'pr' && linkedPR !== null;
  const { data: prGeneratedName, isPending: isPRPending } = useQuery({
    queryKey: ['generateSessionName', linkedPR?.title ?? null, linkedPR?.description ?? null],
    queryFn: () =>
      rpc.sessionCreate.generateSessionName({
        title: linkedPR!.title,
        description: linkedPR!.description ?? undefined,
      }),
    enabled: shouldGenerateFromPR,
    refetchOnWindowFocus: false,
  });

  // Pick the effective generated name and pending state based on linked type + selection.
  const generatedName = (() => {
    if (linkedType === 'issue' && linkedIssue !== null) {
      return directIssueSessionName ?? (shouldGenerateFromIssue ? issueGeneratedName : undefined);
    }
    if (linkedType === 'pr' && linkedPR !== null) {
      return shouldGenerateFromPR ? prGeneratedName : undefined;
    }
    // No entity selected yet — fall back to random placeholder name.
    return autoGenerateName ? randomName : undefined;
  })();

  const isPending = (() => {
    if (linkedType === 'issue' && linkedIssue !== null)
      return shouldGenerateFromIssue && isIssuePending;
    if (linkedType === 'pr' && linkedPR !== null) return shouldGenerateFromPR && isPRPending;
    return autoGenerateName && isRandomPending;
  })();

  const sessionName = useSessionName({
    generatedName,
    isPending,
    resetKey: projectId,
  });

  const workspaceConfig = useWorkspaceConfig({ repositoryWorkspaceId });

  // Switching linked type clears the selection for the previous type.
  const setLinkedType = (type: LinkedType) => {
    setLinkedTypeRaw(type);
  };

  const setLinkedIssue = (issue: LinkedIssue | null) => {
    setLinkedIssueRaw(issue);
  };

  const setLinkedPR = (pr: PullRequest | null) => {
    setLinkedPRRaw(pr);
  };

  // Issue/PR selection is optional enrichment — not required for creation.
  const isValid =
    sessionName.effectiveSessionName.trim().length > 0 && !sessionName.isPending && workspaceConfig.isValid;

  return {
    linkedType,
    setLinkedType,
    linkedIssue,
    setLinkedIssue,
    linkedPR,
    setLinkedPR,
    sessionName,
    workspaceConfig,
    isValid,
  };
}
