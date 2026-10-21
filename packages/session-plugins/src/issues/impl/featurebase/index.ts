import { err, ok } from '@gugu/session-shared';
import { toIntegrationError } from '../../../integrations/helpers/error';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import {
  createFeaturebaseClient,
  readFeaturebaseCredentials,
} from '../../../integrations/impl/featurebase/client';
import { clampIssueLimit, normalizeSearchTerm } from '../../helpers/provider-inputs';
import { defineIssuesPlugin, registerIssuesPluginBehavior } from '../../plugin';
import type { IssueListResult, IssueSearchOpts } from '../../types';
import { toIssueData } from './mapper';

export async function searchIssues(
  host: ConnectedIntegrationHostContext,
  opts: IssueSearchOpts
): Promise<IssueListResult> {
  const term = normalizeSearchTerm(opts.searchTerm);
  if (!term) return ok([]);

  const parsedCredentials = readFeaturebaseCredentials(host.credentials);
  if (!parsedCredentials.success) return err(parsedCredentials.error);

  const client = await createFeaturebaseClient(parsedCredentials.data);

  try {
    const result = await client.feedback.posts.list({
      limit: clampIssueLimit(opts.limit, 20, 100),
      sortBy: 'recent',
      sortOrder: 'desc',
      q: term,
    });
    return ok(result.data.map(toIssueData));
  } catch (error) {
    host.log.warn('Featurebase searchIssues failed', { error });
    return err(toIntegrationError(error, 'Featurebase', 'Unable to search Featurebase posts.'));
  }
}

const plugin = defineIssuesPlugin({ integrationId: 'featurebase' }, { issues: {} }, {});

export const provider = registerIssuesPluginBehavior(plugin, {
  issues: { searchIssues },
});
