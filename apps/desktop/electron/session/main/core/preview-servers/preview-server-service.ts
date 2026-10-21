import type {
  DirectPreviewServer,
  DirectPreviewServerHost,
  PreviewServer,
  PreviewServerEvent,
  PreviewServerProtocol,
  PreviewServerSource,
} from '@shared/core/preview-servers/types';
import type { DetectedPreviewUrl, PreviewSourceClosed } from './terminal-url-detector';

export type RegisterDetectedPreviewTarget = {
  projectId: string;
  workspaceId: string;
  source: PreviewServerSource;
  protocol: PreviewServerProtocol;
  host: DirectPreviewServerHost;
  port: number;
  urlPath: string;
};

export type TerminalSourceClosedInput = {
  projectId: string;
  workspaceId: string;
  terminalId: string;
  reason: PreviewSourceClosed['reason'];
  server?: DetectedPreviewUrl;
};

export class PreviewServerService {
  private readonly servers = new Map<string, PreviewServer>();
  private readonly identities = new Map<string, string>();
  private readonly metadata = new Map<string, { identity: string }>();
  private readonly emit: (event: PreviewServerEvent) => void;

  constructor({ emit }: { emit: (event: PreviewServerEvent) => void }) {
    this.emit = emit;
  }

  async registerDetectedTarget(target: RegisterDetectedPreviewTarget): Promise<PreviewServer> {
    const identity = localAutoIdentity(target);
    const existing = this.serverForIdentity(identity);
    if (existing) return existing;

    const server: DirectPreviewServer = {
      id: identity,
      kind: 'direct',
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      source: target.source,
      protocol: target.protocol,
      urlPath: target.urlPath,
      host: target.host,
      port: target.port,
    };
    this.identities.set(identity, server.id);
    this.servers.set(server.id, server);
    this.metadata.set(server.id, { identity });
    this.emit({ type: 'upsert', server });
    return server;
  }

  listForWorkspace({
    projectId,
    workspaceId,
  }: {
    projectId: string;
    workspaceId: string;
  }): PreviewServer[] {
    return Array.from(this.servers.values()).filter(
      (server) => server.projectId === projectId && server.workspaceId === workspaceId
    );
  }

  async handleTerminalSourceClosed(input: TerminalSourceClosedInput): Promise<void> {
    const ids = Array.from(this.servers.values())
      .filter(
        (server) =>
          server.projectId === input.projectId &&
          server.workspaceId === input.workspaceId &&
          server.source.kind === 'terminal-output' &&
          server.source.terminalId === input.terminalId &&
          matchesDetectedServer(server, input.server)
      )
      .map((server) => server.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  async stop(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (!server) return;
    this.servers.delete(id);
    const metadata = this.metadata.get(id);
    this.metadata.delete(id);
    if (metadata) this.identities.delete(metadata.identity);
    this.emit({ type: 'remove', id });
  }

  async stopForWorkspace(projectId: string, workspaceId: string): Promise<void> {
    const ids = Array.from(this.servers.values())
      .filter((server) => server.projectId === projectId && server.workspaceId === workspaceId)
      .map((server) => server.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  async stopForProject(projectId: string): Promise<void> {
    const ids = Array.from(this.servers.values())
      .filter((server) => server.projectId === projectId)
      .map((server) => server.id);
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  private serverForIdentity(identity: string): PreviewServer | undefined {
    const id = this.identities.get(identity);
    return id ? this.servers.get(id) : undefined;
  }
}

function localAutoIdentity(target: {
  projectId: string;
  workspaceId: string;
  host: DirectPreviewServerHost;
  port: number;
}): string {
  return `local:auto:${target.projectId}:${target.workspaceId}:${target.host}:${target.port}`;
}

function matchesDetectedServer(
  server: PreviewServer,
  detected: DetectedPreviewUrl | undefined
): boolean {
  if (!detected) return true;
  if (server.protocol !== detected.protocol) return false;
  return server.host === detected.host && server.port === detected.port;
}
