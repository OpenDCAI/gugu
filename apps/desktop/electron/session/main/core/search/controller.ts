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
  tasks: () => accountMessageSearch.tasks(),
  coverage: () => accountMessageSearch.coverage(),
  // The renderer feeds authorized chat reads; task projections have one main-process source.
  write: (ops: SearchIndexOp[]) => {
    if (ops.some(op => !['rows', 'remove', 'chats', 'clearChat', 'coverage'].includes(op.kind))) {
      throw new Error('Task search writes belong to the stored-turn feed');
    }
    return accountMessageSearch.write(ops);
  },
});
