import { describe, expect, it } from 'vitest';
import { pullRequestErrorMessage } from './pull-requests';

describe('pullRequestErrorMessage', () => {
  it.each([
    {
      type: 'github_not_found_or_no_access',
      host: 'github.com',
      message: 'acme/repo on github.com was not found, or the selected GitHub account does not have access.',
    },
    { type: 'github_account_disabled', message: 'GitHub API is disabled for this project.' },
  ] as const)('shows the message a GitHub account failure carries ($type)', (error) => {
    expect(pullRequestErrorMessage(error)).toBe(error.message);
  });
});
