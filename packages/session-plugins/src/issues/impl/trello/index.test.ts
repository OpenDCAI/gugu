import type { Logger } from '@gugu/session-shared/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import { provider } from './index';

const logger: Logger = {
  level: 'error',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const issues = provider.behavior.issues;
if (!issues?.getIssue) throw new Error('Trello issues behavior is not registered.');
const getIssue = issues.getIssue;

const CREDENTIALS = { apiKey: 'key', apiToken: 'tok' };

function host(
  credentials: ConnectedIntegrationHostContext['credentials']
): ConnectedIntegrationHostContext {
  return { log: logger, credentials };
}

const CARD = {
  id: 'card-1',
  name: 'Fix login bug',
  desc: 'Steps to reproduce...',
  url: 'https://trello.com/c/aBcD1234/1-fix-login-bug',
  shortLink: 'aBcD1234',
  dateLastActivity: '2026-05-20T10:00:00.000Z',
};

const MEMBER_BOARD = { id: 'member-board', name: 'Sprint Board', closed: false };
const ORG_BOARD = { id: 'org-board', name: 'Workspace Board', closed: false };
const CLOSED_BOARD = { id: 'closed-board', name: 'Old Board', closed: true };
const ORG = { id: 'org-1' };

const fetchMock = vi.fn();

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

/** Route responses by pathname since Trello calls can run concurrently. */
function routeFetch(routes: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = new URL(String(input));
    const body = routes[url.pathname];
    if (body === undefined) throw new Error(`Unexpected request: ${url.pathname}`);
    return jsonResponse(body);
  });
}

function requestedUrls(): URL[] {
  return fetchMock.mock.calls.map((call) => new URL(String(call[0])));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('trello issues plugin', () => {
  describe('board discovery (search scope)', () => {
    it('leaves closed member boards out of the search scope', async () => {
      routeFetch({
        '/1/members/me/boards': [MEMBER_BOARD, CLOSED_BOARD],
        '/1/members/me/organizations': [],
        '/1/search': { cards: [] },
      });

      const result = await issues.searchIssues(host(CREDENTIALS), { searchTerm: 'login', limit: 20 });

      expect(result).toEqual({ success: true, data: [] });
      const urls = requestedUrls();
      const memberBoardsUrl = urls.find((url) => url.pathname.endsWith('/members/me/boards'));
      expect(memberBoardsUrl!.searchParams.get('filter')).toBe('open');
      const searchUrl = urls.find((url) => url.pathname === '/1/search');
      expect(searchUrl!.searchParams.get('idBoards')).toBe('member-board');
    });

    it('scopes the search to the 20 most recently active boards when more are available', async () => {
      const boards = Array.from({ length: 25 }, (_, index) => ({
        id: `board-${index}`,
        name: `Board ${index}`,
        closed: false,
        // Ascending activity: board-24 is the most recent, board-0 through board-4 fall off.
        dateLastActivity: `2026-05-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
      }));
      routeFetch({
        '/1/members/me/boards': boards,
        '/1/members/me/organizations': [],
        '/1/search': { cards: [] },
      });

      await issues.searchIssues(host(CREDENTIALS), { searchTerm: 'login', limit: 20 });

      const searchUrl = requestedUrls().find((url) => url.pathname === '/1/search');
      const scoped = searchUrl!.searchParams.get('idBoards')!.split(',');
      expect(scoped).toHaveLength(20);
      expect(scoped).not.toContain('board-0');
      expect(scoped).toContain('board-24');
    });

    it('surfaces the underlying error message when an API request fails', async () => {
      fetchMock.mockRejectedValue(new Error('Rate limit exceeded'));

      const result = await issues.searchIssues(host(CREDENTIALS), { searchTerm: 'login', limit: 20 });

      expect(result).toEqual({
        success: false,
        error: { type: 'generic', message: 'Rate limit exceeded' },
      });
    });

    it('returns an invalid input error when the host provides no credentials', async () => {
      const result = await issues.searchIssues(host({}), { searchTerm: 'login', limit: 20 });

      expect(result).toEqual({
        success: false,
        error: { type: 'invalid_input', message: 'Trello API key and token cannot be empty.' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('searchIssues', () => {
    it('returns no results for an empty search term without querying Trello', async () => {
      const result = await issues.searchIssues(host(CREDENTIALS), {
        searchTerm: '   ',
        limit: 20,
      });

      expect(result).toEqual({ success: true, data: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('searches cards and scopes the search to discovered boards', async () => {
      routeFetch({
        '/1/members/me/boards': [MEMBER_BOARD],
        '/1/members/me/organizations': [ORG],
        '/1/organizations/org-1/boards': [ORG_BOARD, MEMBER_BOARD],
        '/1/search': { cards: [{ ...CARD, board: { name: 'Sprint Board' } }] },
      });

      const result = await issues.searchIssues(host(CREDENTIALS), {
        searchTerm: 'login',
        limit: 20,
      });

      expect(result).toEqual({
        success: true,
        data: [
          expect.objectContaining({
            identifier: CARD.shortLink,
            title: CARD.name,
            project: 'Sprint Board',
          }),
        ],
      });

      const searchUrl = requestedUrls().find((url) => url.pathname === '/1/search');
      expect(searchUrl).toBeDefined();
      expect(searchUrl!.pathname).toBe('/1/search');
      expect(searchUrl!.searchParams.get('query')).toBe('login');
      expect(searchUrl!.searchParams.get('modelTypes')).toBe('cards');
      expect(searchUrl!.searchParams.get('idBoards')).toBe('member-board,org-board');
    });

    it('returns no search results when no boards are discovered', async () => {
      routeFetch({
        '/1/members/me/boards': [],
        '/1/members/me/organizations': [],
      });

      const result = await issues.searchIssues(host(CREDENTIALS), {
        searchTerm: 'login',
        limit: 20,
      });

      expect(result).toEqual({ success: true, data: [] });
      expect(requestedUrls().some((url) => url.pathname === '/1/search')).toBe(false);
    });
  });

  describe('getIssue', () => {
    it('returns the card with comments and checklists as context', async () => {
      routeFetch({
        [`/1/cards/${CARD.shortLink}`]: {
          ...CARD,
          board: { name: 'Sprint Board' },
          actions: [
            {
              id: 'action-1',
              date: '2026-05-19T09:00:00.000Z',
              data: { text: 'Started investigating the auth flow.' },
              memberCreator: { fullName: 'Jan' },
            },
          ],
          checklists: [
            {
              id: 'checklist-1',
              name: 'Steps',
              checkItems: [
                { name: 'Reproduce locally', state: 'complete', pos: 1 },
                { name: 'Write regression test', state: 'incomplete', pos: 2 },
              ],
            },
          ],
        },
      });

      const result = await getIssue(host(CREDENTIALS), {
        identifier: CARD.shortLink,
      });

      expect(result).toEqual({
        success: true,
        data: expect.objectContaining({
          identifier: CARD.shortLink,
          title: CARD.name,
          project: 'Sprint Board',
          context: expect.stringContaining('Started investigating the auth flow.'),
        }),
      });
      if (result.success) {
        expect(result.data.context).toContain('- [x] Reproduce locally');
        expect(result.data.context).toContain('- [ ] Write regression test');
      }

      const cardUrl = requestedUrls()[0];
      expect(cardUrl.searchParams.get('actions')).toBe('commentCard');
      expect(cardUrl.searchParams.get('checklists')).toBe('all');
    });
  });
});
