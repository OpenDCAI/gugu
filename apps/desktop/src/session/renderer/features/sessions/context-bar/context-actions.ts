import { buildIssueContextText } from '@shared/core/issues/issue-context';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type { PromptLibraryPrompt } from '@shared/prompt-library';

export { buildIssueContextText } from '@shared/core/issues/issue-context';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ContextActionKind = 'linked-issue' | 'prompt';

export interface IssueContextAction {
  id: string;
  kind: 'linked-issue';
  provider: LinkedIssue['provider'];
  issue: LinkedIssue;
}

export interface PromptContextAction {
  id: string;
  kind: 'prompt';
  prompt: PromptLibraryPrompt;
}

export type ContextAction = IssueContextAction | PromptContextAction;

// ─── Text building ───────────────────────────────────────────────────────────

export function buildContextActionText(action: ContextAction): string {
  switch (action.kind) {
    case 'linked-issue':
      return buildIssueContextText(action.issue);
    case 'prompt':
      return action.prompt.prompt;
  }
}

// ─── Builders ────────────────────────────────────────────────────────────────

export function buildLinkedIssueContextAction(issue?: LinkedIssue): IssueContextAction | null {
  if (!issue) return null;
  return {
    id: `linked-issue:${issue.provider}:${issue.identifier}`,
    kind: 'linked-issue',
    provider: issue.provider,
    issue,
  };
}

export function buildPromptLibraryContextActions(
  prompts: PromptLibraryPrompt[]
): PromptContextAction[] {
  return prompts
    .filter((p) => p.prompt.trim().length > 0)
    .map((p) => ({
      id: `prompt:${p.id}`,
      kind: 'prompt' as const,
      prompt: p,
    }));
}

export function buildSessionContextActions(
  issue: LinkedIssue | undefined,
  prompts: PromptLibraryPrompt[]
): ContextAction[] {
  return [
    buildLinkedIssueContextAction(issue),
    ...buildPromptLibraryContextActions(prompts),
  ].filter((a): a is ContextAction => a !== null);
}
