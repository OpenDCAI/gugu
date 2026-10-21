import { CheckCircle } from '@/lib/icons'
import { LoadingIndicator } from '@/lib/loading/LoadingIndicator';
import { isValidGitIdentity } from '@gugu/session-core/session-record/contract';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { toast } from 'sonner';
import { workspaceBackend } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import {
  useSessionViewContext,
  useWorkspace,
  useWorkspaceId,
  useWorkspaceSurface,
} from '@renderer/features/sessions/session-view-context';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Input } from '@renderer/lib/ui/input';
import { SplitButton, type SplitButtonAction } from '@renderer/lib/ui/split-button';
import { Textarea } from '@renderer/lib/ui/textarea';
import { formatPushErrorDetail } from '../../../utils';
import { vcsFailureText } from '../../../vcs-failure';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type CommitPhase =
  | 'idle'
  | 'committing'
  | 'commit-only-done'
  | 'committed'
  | 'pushing'
  | 'pushed'
  | 'opening-pr';

interface CommitCardProps {
  autoStage?: boolean;
}

export const CommitCard = observer(function CommitCard({ autoStage = false }: CommitCardProps) {
  const { translate } = useSessionMessages();
  const { projectId, sessionId } = useSessionViewContext();
  const workspaceId = useWorkspaceId();
  const sessionView = useWorkspaceSurface();
  const workspace = useWorkspace();
  const git = workspace.gitWorktree;
  const diffView = sessionView.diffView;
  const changesView = diffView?.changesView ?? null;
  const hasPRs = changesView?.expandedSections.pullRequests ?? false;
  const [commitMessage, setCommitMessage] = useState('');
  const [description, setDescription] = useState('');
  const [phase, setPhase] = useState<CommitPhase>('idle');
  const fullMessage = description ? `${commitMessage}\n\n${description}` : commitMessage;
  const isInFlight = phase !== 'idle';
  // 会话所在那台机器上的 git 还不知道署谁的名字:就地问一次(用户多半不熟 git config,所以直接在这里填、
  // 写进那台机器),填完接着把刚才那次提交做完。这台电脑上的署名由用户自己的 git 配置管,没有这一格。
  const backend = workspaceBackend(projectId);
  const [identity, setIdentity] = useState<IdentityDraft | null>(null);

  const showCreatePrModal = useShowModal('createPrModal');
  const repositoryUrl = workspace.gitRepository?.pullRequestRepositoryUrl ?? null;

  if (!diffView || !changesView) return null;

  const branchName = workspace.gitWorktree.branchName;
  const hasOpenPr = sessionView.prStore?.pullRequests.some((p) => p.status === 'open') ?? false;
  const canCreatePr = Boolean(repositoryUrl) && Boolean(branchName) && !hasOpenPr;

  const stageAllIfNeeded = async (): Promise<boolean> => {
    if (!autoStage) return true;
    changesView.suppressNextAutoExpand('staged');
    const result = await git.stageAllFiles();
    if (!result.success) {
      toast.error(vcsFailureText('stage', result.error, translate, 'changes.stageFailed'));
      setPhase('idle');
      return false;
    }
    return true;
  };

  /** 提交被拒是因为那台机器上的 git 没有署名:把填署名那一格摆出来(默认填这台电脑上 git 的署名),返回 true。 */
  const askIdentityIfNeeded = (error: unknown, push: boolean): boolean => {
    if ((error as { code?: string }).code !== 'identity_unknown' || !backend.setGitIdentity) return false;
    setIdentity({ push, name: '', email: '', error: null });
    void rpc.gitRepository.localIdentity().then(
      (local) => setIdentity((current) => (current && !current.name && !current.email ? { ...current, ...local } : current)),
      () => undefined
    );
    return true;
  };

  const saveIdentity = async () => {
    if (!identity || !backend.setGitIdentity) return;
    const value = { name: identity.name.trim(), email: identity.email.trim() };
    if (!isValidGitIdentity(value)) {
      setIdentity({ ...identity, error: translate('changes.identity.invalid') });
      return;
    }
    setPhase('committing');
    const saved = await backend.setGitIdentity(workspaceId, value);
    if (!saved.ok) {
      setPhase('idle');
      setIdentity({ ...identity, error: saved.message });
      return;
    }
    setIdentity(null);
    await (identity.push ? doCommitAndPush() : doCommit());
  };

  const doCommit = async () => {
    setPhase('committing');
    if (!(await stageAllIfNeeded())) return;
    const result = await git.commit(fullMessage);
    if (!result.success) {
      setPhase('idle');
      if (askIdentityIfNeeded(result.error, false)) return;
      toast.error(vcsFailureText('commit', result.error, translate, 'changes.commitFailed'));
      return;
    }
    setCommitMessage('');
    setDescription('');
    if (!autoStage) {
      changesView.setExpanded({ unstaged: true, staged: false, pullRequests: hasPRs });
    }
    setPhase('commit-only-done');
    setTimeout(() => setPhase('idle'), 3000);
  };

  const doCommitAndPush = async () => {
    setPhase('committing');
    if (!(await stageAllIfNeeded())) return;
    const commitResult = await git.commit(fullMessage);
    if (!commitResult.success) {
      setPhase('idle');
      if (askIdentityIfNeeded(commitResult.error, true)) return;
      toast.error(
        vcsFailureText('commit', commitResult.error, translate, 'changes.commitFailed')
      );
      return;
    }
    setCommitMessage('');
    setDescription('');
    if (!autoStage) {
      changesView.setExpanded({ unstaged: true, staged: false, pullRequests: hasPRs });
    }
    setPhase('committed');
    await new Promise((r) => setTimeout(r, 1000));
    setPhase('pushing');
    const pushResult = await git.push();
    if (!pushResult.success) {
      toast.error(
        translate('changes.pushFailed', { detail: formatPushErrorDetail(pushResult.error, translate) })
      );
      setPhase('idle');
      return;
    }
    setPhase('pushed');
    setTimeout(() => setPhase('idle'), 3000);
  };

  const doCommitAndCreatePr = async () => {
    setPhase('committing');
    if (!(await stageAllIfNeeded())) return;
    const commitResult = await git.commit(fullMessage);
    if (!commitResult.success) {
      toast.error(
        vcsFailureText('commit', commitResult.error, translate, 'changes.commitFailed')
      );
      setPhase('idle');
      return;
    }
    setCommitMessage('');
    setDescription('');
    if (!autoStage) {
      changesView.setExpanded({ unstaged: true, staged: false, pullRequests: hasPRs });
    }
    setPhase('opening-pr');
    await new Promise((r) => setTimeout(r, 500));
    setPhase('idle');
    showCreatePrModal({
      projectId,
      sessionId,
      repositoryUrl: repositoryUrl ?? '',
      branchName: branchName ?? '',
      draft: false,
      workspaceId,
      onSuccess: () => {},
    });
  };

  const actions: SplitButtonAction[] = [
    { value: 'commit', label: 'Commit', action: () => void doCommit() },
    { value: 'commit-push', label: 'Commit & Push', action: () => void doCommitAndPush() },
    ...(canCreatePr
      ? [
          {
            value: 'commit-pr',
            label: 'Commit & Create PR',
            action: () => void doCommitAndCreatePr(),
          },
        ]
      : []),
  ];

  const effectiveAction =
    diffView.effectiveCommitAction === 'commit-pr' && !canCreatePr
      ? 'commit-push'
      : diffView.effectiveCommitAction;

  return (
    // 密度面板,不画框 —— 与 action-card.tsx 同一次去 border(design.md:prefer a change of
    // density over a box;2026-09-22)。
    <div className="mx-2 mb-2 flex shrink-0 flex-col items-center justify-between gap-2 rounded-lg bg-background-1 p-2">
      {identity && (
        <GitIdentityForm
          draft={identity}
          device={backend.machine.kind === 'remote' ? backend.machine.label() : ''}
          busy={isInFlight}
          onChange={setIdentity}
          onCancel={() => setIdentity(null)}
          onSave={() => void saveIdentity()}
        />
      )}
      <Input
        placeholder={translate('changes.commitMessagePlaceholder')}
        autoFocus
        className="w-full bg-background"
        value={commitMessage}
        onChange={(e) => setCommitMessage(e.target.value)}
        disabled={isInFlight}
      />
      <Textarea
        placeholder={translate('changes.commitDescriptionPlaceholder')}
        className="w-full bg-background"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={isInFlight}
      />
      {phase === 'idle' && !identity && (
        <SplitButton
          actions={actions}
          size="sm"
          className="w-full"
          disabled={!commitMessage.trim()}
          defaultValue={effectiveAction}
          onValueChange={(value) =>
            diffView.setCommitAction(value as 'commit' | 'commit-push' | 'commit-pr')
          }
        />
      )}
      {phase === 'committing' && (
        <StatusRow icon={<LoadingIndicator size="inline" />} label={translate('changes.committing')} />
      )}
      {phase === 'opening-pr' && (
        <StatusRow icon={<LoadingIndicator size="inline" />} label={translate('changes.openingPr')} />
      )}
      {(phase === 'commit-only-done' || phase === 'committed') && (
        <StatusRow
          icon={<CheckCircle className="size-4 text-foreground-success" />}
          label={translate('changes.committed')}
        />
      )}
      {phase === 'pushing' && (
        <StatusRow icon={<LoadingIndicator size="inline" />} label={translate('changes.pushing')} />
      )}
      {phase === 'pushed' && (
        <StatusRow
          icon={<CheckCircle className="size-4 text-foreground-success" />}
          label={translate('changes.pushed')}
        />
      )}
    </div>
  );
});

type IdentityDraft = { push: boolean; name: string; email: string; error: string | null };

function GitIdentityForm({
  draft,
  device,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: IdentityDraft;
  device: string;
  busy: boolean;
  onChange: (draft: IdentityDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex w-full flex-col gap-2" data-testid="git-identity">
      <div className="flex flex-col gap-1">
        <span className="text-sm text-foreground">{translate('remoteWorkspace.identity.title', { device })}</span>
        <span className="text-xs text-foreground-muted">{translate('remoteWorkspace.identity.hint', { device })}</span>
      </div>
      <Input
        aria-label={translate('changes.identity.name')}
        placeholder={translate('changes.identity.name')}
        className="w-full bg-background"
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value, error: null })}
        disabled={busy}
        autoFocus
      />
      <Input
        aria-label={translate('changes.identity.email')}
        placeholder={translate('changes.identity.email')}
        className="w-full bg-background"
        type="email"
        value={draft.email}
        onChange={(e) => onChange({ ...draft, email: e.target.value, error: null })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSave();
        }}
        disabled={busy}
      />
      {draft.error && <span className="text-xs text-foreground-destructive">{draft.error}</span>}
      {!busy && (
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="xs" variant="ghost" onClick={onCancel}>
            {translate('changes.identity.cancel')}
          </Button>
          <Button size="xs" onClick={onSave}>
            {translate(draft.push ? 'changes.identity.saveAndPush' : 'changes.identity.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusRow({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex w-full items-center justify-center gap-2 py-1 text-sm text-foreground-muted">
      {icon}
      <span>{label}</span>
    </div>
  );
}
