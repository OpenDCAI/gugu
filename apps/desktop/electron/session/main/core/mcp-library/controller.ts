import { createRPCController } from '@shared/lib/ipc/rpc';
import type { LibraryMcpCheck, LibraryMcpHarnessServer, LibraryMcpServer } from '@shared/mcp-library';
import { mcpLibraryService } from './service';

/** 资源库 → MCP 的读写。别的机器经 `rpcOn(机器).mcpLibrary.*` 问到它自己的这一个控制器。 */
export const mcpLibraryController = createRPCController({
  list: (): Promise<LibraryMcpServer[]> => mcpLibraryService.list(),
  add: (servers: LibraryMcpServer[]): Promise<void> => mcpLibraryService.add(servers),
  update: (server: LibraryMcpServer): Promise<void> => mcpLibraryService.update(server),
  remove: (name: string): Promise<void> => mcpLibraryService.remove(name),
  setEnabledByDefault: (name: string, enabledByDefault: boolean): Promise<void> =>
    mcpLibraryService.setEnabledByDefault(name, enabledByDefault),
  check: (name: string): Promise<LibraryMcpCheck> => mcpLibraryService.check(name),
  harnessServers: (providerIds: string[]): Promise<LibraryMcpHarnessServer[]> =>
    mcpLibraryService.harnessServers(providerIds),
  checkHarnessServer: (providerId: string, name: string): Promise<LibraryMcpCheck> =>
    mcpLibraryService.checkHarnessServer(providerId, name),
});
