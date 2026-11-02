import type { CommandPaletteQuery, TaskTurnQuery, WorkspaceFileSearchQuery } from '@shared/core/search';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { searchService } from './search-service';

export const searchController = createRPCController({
  commandPalette: (query: CommandPaletteQuery) => searchService.search(query),
  taskTurns: (query: TaskTurnQuery) => {
    if (searchService.taskTurnIndexStatus().state !== 'ready') throw Object.assign(new Error('Task search index is not ready'), { code: 'search_index_not_ready' });
    return searchService.searchTaskTurns(query.query, query.limit);
  },
  taskTurnIndexStatus: () => searchService.taskTurnIndexStatus(),
  searchWorkspaceFiles: (q: WorkspaceFileSearchQuery) =>
    searchService.searchFiles(q.workspaceId, q.query, q.limit),
});
