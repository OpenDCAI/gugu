import type { IDisposable } from '@gugu/session-shared';
import { events, rpc } from '@renderer/lib/ipc';
import { Resource } from '@renderer/lib/stores/resource';
import { previewServerEventChannel } from '@shared/core/preview-servers/events';
import type { PreviewServer, PreviewServerEvent } from '@shared/core/preview-servers/types';
import { previewServerUrl } from '@shared/core/preview-servers/types';

type PreviewServerStoreOptions = {
  projectId: string;
  workspaceId: string;
};

export class PreviewServerStore implements IDisposable {
  readonly serversResource: Resource<Map<string, PreviewServer>, PreviewServerEvent>;

  private readonly projectId: string;
  private readonly workspaceId: string;
  private started = false;

  constructor({ projectId, workspaceId }: PreviewServerStoreOptions) {
    this.projectId = projectId;
    this.workspaceId = workspaceId;
    this.serversResource = new Resource<Map<string, PreviewServer>, PreviewServerEvent>(
      async () => {
        const servers = await rpc.previewServers.listForWorkspace({ projectId, workspaceId });
        return new Map(servers.map((server) => [server.id, server]));
      },
      [
        {
          kind: 'event',
          subscribe: (handler) => events.on(previewServerEventChannel, handler),
          onEvent: (event, ctx) => {
            const next = new Map(ctx.data ?? []);
            if (event.type === 'upsert') {
              if (
                event.server.projectId !== this.projectId ||
                event.server.workspaceId !== this.workspaceId
              ) {
                return;
              }
              next.set(event.server.id, event.server);
            } else {
              next.delete(event.id);
            }
            ctx.set(next);
          },
        },
      ],
      { init: new Map(), refData: true }
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.serversResource.start();
  }

  get servers(): PreviewServer[] {
    return Array.from(this.serversResource.data?.values() ?? []).sort(comparePreviewServers);
  }

  get urls(): string[] {
    return this.servers.map((server) => previewServerUrl(server));
  }

  dispose(): void {
    this.serversResource.dispose();
  }
}

function comparePreviewServers(a: PreviewServer, b: PreviewServer): number {
  if (a.port !== b.port) return a.port - b.port;
  return a.id.localeCompare(b.id);
}
