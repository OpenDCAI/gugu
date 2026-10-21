export type PreviewServerSource = {
  kind: 'terminal-output';
  terminalId: string;
};

export type PreviewServerProtocol = 'http:' | 'https:';
export type DirectPreviewServerHost = 'localhost' | '127.0.0.1';

export type PreviewServerBase = {
  id: string;
  projectId: string;
  workspaceId: string;
  source: PreviewServerSource;
  protocol: PreviewServerProtocol;
  urlPath: string;
};

export type DirectPreviewServer = PreviewServerBase & {
  kind: 'direct';
  host: DirectPreviewServerHost;
  port: number;
};

export type PreviewServer = DirectPreviewServer;

export function previewServerUrl(server: PreviewServer): string {
  return `${server.protocol}//${server.host}:${server.port}${server.urlPath}`;
}


export type PreviewServerEvent =
  | { type: 'upsert'; server: PreviewServer }
  | { type: 'remove'; id: string };
