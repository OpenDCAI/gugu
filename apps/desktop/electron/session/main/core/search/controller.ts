import type { CommandPaletteQuery, WorkspaceFileSearchQuery } from '@shared/core/search';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { searchService } from './search-service';
import { accountMessageSearch } from './account-message-search';
import type { SearchIndexOp, SearchQuery } from '@gugu/core/shared/search/types';
import type { MessageSearchRequest } from '@shared/core/message-search';

export const searchController = createRPCController({
  commandPalette: (query: CommandPaletteQuery) => searchService.search(query),
  searchWorkspaceFiles: (q: WorkspaceFileSearchQuery) =>
    searchService.searchFiles(q.workspaceId, q.query, q.limit),
  global: (request: MessageSearchRequest) => accountMessageSearch.global(request),
  dateAnchor: (query: SearchQuery) => accountMessageSearch.dateAnchor(query),
  coverage: () => accountMessageSearch.coverage(),
  // The only write. Its one renderer caller is apps/desktop/src/lib/searchIndexFeed.ts.
  apply: (ops: SearchIndexOp[]) => accountMessageSearch.apply(ops),
});
