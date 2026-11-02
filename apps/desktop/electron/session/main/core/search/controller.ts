import type { CommandPaletteQuery, TaskTurnQuery, WorkspaceFileSearchQuery } from '@shared/core/search';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { searchService } from './search-service';

export const searchController = createRPCController({
  commandPalette: (query: CommandPaletteQuery) => searchService.search(query),
  taskTurns: (query: TaskTurnQuery) => searchService.searchTaskTurns(query.query, query.limit),
  searchWorkspaceFiles: (q: WorkspaceFileSearchQuery) =>
    searchService.searchFiles(q.workspaceId, q.query, q.limit),
});
