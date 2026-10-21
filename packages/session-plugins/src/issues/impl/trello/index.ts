import { err, ok } from '@gugu/session-shared';
import { toIntegrationError } from '../../../integrations/helpers/error';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import {
  createTrelloClient,
  readTrelloCredentials,
} from '../../../integrations/impl/trello/client';
import { clampIssueLimit, normalizeSearchTerm } from '../../helpers/provider-inputs';
import { sortByUpdatedAtDesc } from '../../helpers/sort-by-updated-at-desc';
import { defineIssuesPlugin, registerIssuesPluginBehavior } from '../../plugin';
import type {
  IssueGetOpts,
  IssueGetResult,
  IssueListResult,
  IssueSearchOpts,
} from '../../types';
import { resolveTrelloBoards } from './board-resolver';
import { formatTrelloContext } from './context';
import { toIssueData } from './mapper';

const TRELLO_CARD_FIELDS = 'name,desc,url,shortLink,dateLastActivity';

export async function searchIssues(
  host: ConnectedIntegrationHostContext,
  opts: IssueSearchOpts
): Promise<IssueListResult> {
  const term = normalizeSearchTerm(opts.searchTerm);
  if (!term) return ok([]);

  const parsedCredentials = readTrelloCredentials(host.credentials);
  if (!parsedCredentials.success) return err(parsedCredentials.error);

  const client = await createTrelloClient(parsedCredentials.data);
  const sanitizedLimit = clampIssueLimit(opts.limit, 20, 200);

  try {
    const boards = await resolveTrelloBoards(client);
    if (!boards.length) return ok([]);

    const result = await client.search.search({
      query: term,
      idBoards: boards.map((board) => board.id).join(','),
      modelTypes: 'cards',
      cardFields: TRELLO_CARD_FIELDS,
      cardsLimit: sanitizedLimit,
      cardBoard: true,
      boardFields: ['name'],
      partial: true,
    });
    const issues = sortByUpdatedAtDesc((result.cards ?? []).map((card) => toIssueData(card)));
    return ok(issues);
  } catch (error) {
    host.log.warn('Trello searchIssues failed', { error });
    return err(toIntegrationError(error, 'Trello', 'Unable to search Trello cards.'));
  }
}

export async function getIssue(
  host: ConnectedIntegrationHostContext,
  opts: IssueGetOpts
): Promise<IssueGetResult> {
  const parsedCredentials = readTrelloCredentials(host.credentials);
  if (!parsedCredentials.success) return err(parsedCredentials.error);

  const client = await createTrelloClient(parsedCredentials.data);

  try {
    const card = await client.cards.getCard({
      id: opts.identifier,
      fields: TRELLO_CARD_FIELDS,
      board: true,
      boardFields: ['name'],
      actions: 'commentCard',
      checklists: 'all',
    });
    return ok({ ...toIssueData(card), context: formatTrelloContext(card) });
  } catch (error) {
    host.log.warn('Trello getIssue failed', { error });
    return err(toIntegrationError(error, 'Trello', 'Unable to fetch Trello card context.'));
  }
}

const plugin = defineIssuesPlugin({ integrationId: 'trello' }, { issues: {} }, {});

export const provider = registerIssuesPluginBehavior(plugin, {
  issues: { searchIssues, getIssue },
});
