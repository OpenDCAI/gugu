import { normalizeSessionName } from '@renderer/utils/sessionNames';
import type { LinkedIssue } from '@shared/core/linked-issue';

export function getIssueSessionName(
  issue: LinkedIssue | null | undefined,
  options?: { preserveCapitalization?: boolean }
): string | null {
  if (!issue) {
    return null;
  }

  const branchName = issue.branchName?.trim();
  if (!branchName) {
    return null;
  }

  const normalized = normalizeSessionName(branchName.replace(/\//g, '-'), options);
  return normalized || null;
}
