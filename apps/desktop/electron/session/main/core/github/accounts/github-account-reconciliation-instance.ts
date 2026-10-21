import { log } from '@main/lib/logger';
import { GitHubAccountReconciliationService } from './github-account-reconciliation';
import { githubCliAccountImportService } from './github-cli-account-import-instance';

export const githubAccountReconciliationService = new GitHubAccountReconciliationService({
  cliImporter: githubCliAccountImportService,
  logger: log,
});
