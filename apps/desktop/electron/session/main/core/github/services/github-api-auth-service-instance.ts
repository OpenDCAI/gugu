import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { GitHubApiAuthService } from './github-api-auth-service';
import { githubCliTokenReader } from './github-cli-token-reader-instance';

export const githubApiAuthService = new GitHubApiAuthService(
  providerAccountRegistry,
  githubCliTokenReader
);
