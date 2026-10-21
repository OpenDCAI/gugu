import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import { GitHubCliTokenReader } from './github-cli-token-reader';

/** One reader shared by the CLI account import and the API auth service. */
export const githubCliTokenReader = new GitHubCliTokenReader(new LocalExecutionContext());
