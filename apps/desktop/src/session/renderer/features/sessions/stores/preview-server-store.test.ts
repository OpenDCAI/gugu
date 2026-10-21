import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewServer, PreviewServerEvent } from '@shared/core/preview-servers/types';
import { previewServerUrl } from '@shared/core/preview-servers/types';

const handlers: Array<(event: PreviewServerEvent) => void> = [];

function emitPreviewServerEvent(event: PreviewServerEvent): void {
  for (const handler of handlers) handler(event);
}

const rpcMocks = vi.hoisted(() => ({
  listForWorkspace: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn((_channel, handler: (event: PreviewServerEvent) => void) => {
      handlers.push(handler);
      return () => {};
    }),
  },
  rpc: {
    previewServers: rpcMocks,
  },
}));

const { PreviewServerStore } = await import('./preview-server-store');

function directServer(overrides: Partial<PreviewServer> = {}): PreviewServer {
  return {
    kind: 'direct',
    id: 'direct-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    source: { kind: 'terminal-output', terminalId: 'terminal-1' },
    protocol: 'http:',
    host: 'localhost',
    port: 5173,
    urlPath: '/',
    ...overrides,
  } as PreviewServer;
}

describe('PreviewServerStore', () => {
  beforeEach(() => {
    handlers.length = 0;
    rpcMocks.listForWorkspace.mockReset();
  });

  it('loads preview servers for a workspace and exposes addressable URLs', async () => {
    const vite = directServer({ id: 'vite', port: 5173 });
    const next = directServer({ id: 'next', port: 3000 });
    rpcMocks.listForWorkspace.mockResolvedValueOnce([vite, next]);

    const store = new PreviewServerStore({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    await store.serversResource.load();

    expect(rpcMocks.listForWorkspace).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    expect(store.servers.map((server) => server.id)).toEqual(['next', 'vite']);
    expect(store.urls).toEqual([previewServerUrl(next), previewServerUrl(vite)]);

    store.dispose();
  });

  it('applies upsert and remove events for the active workspace', async () => {
    rpcMocks.listForWorkspace.mockResolvedValue([]);
    const store = new PreviewServerStore({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
    await store.serversResource.load();
    store.start();

    const active = directServer();
    emitPreviewServerEvent({ type: 'upsert', server: active });
    emitPreviewServerEvent({
      type: 'upsert',
      server: directServer({
        id: 'other',
        workspaceId: 'workspace-2',
        port: 5174,
      }),
    });

    expect(store.servers.map((server) => server.id)).toEqual(['direct-1']);

    emitPreviewServerEvent({ type: 'remove', id: active.id });

    expect(store.servers).toEqual([]);

    store.dispose();
  });
});
