import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { githubCliTokenReader } from '../services/github-cli-token-reader-instance';
import { githubIdentityClient } from '../services/github-identity-client';
import { GitHubCliAccountImportService } from './github-cli-account-import';

export const githubCliAccountImportService = new GitHubCliAccountImportService(
  providerAccountRegistry,
  githubCliTokenReader,
  githubIdentityClient
);
