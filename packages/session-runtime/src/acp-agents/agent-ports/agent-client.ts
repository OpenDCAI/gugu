import type { AcpPermissionParams } from '@gugu/session-core/agents/plugins';
import type { AcpClient } from '@gugu/session-core/agents/plugins';
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';
import type { NormalizedEvent } from '@gugu/session-core/acp';
import type { AcpConnectionContext } from '../connection/source';
import type { FsPort } from './fs-port';
import type { TerminalPort } from './terminal-port';

export interface InboundRouter {
  onSessionUpdate(
    connection: AcpConnectionContext,
    params: { sessionId: string; trace?: unknown },
    event: NormalizedEvent
  ): void;
  onPermissionRequest(
    connection: AcpConnectionContext,
    params: AcpPermissionParams
  ): Promise<RequestPermissionResponse>;
  onCreateTerminal(
    connection: AcpConnectionContext,
    params: CreateTerminalRequest
  ): Promise<CreateTerminalResponse>;
}

export interface AgentPorts {
  fs: FsPort;
  terminals: TerminalPort;
}

export function buildAgentClient(
  connection: AcpConnectionContext,
  router: InboundRouter,
  ports: AgentPorts
): AcpClient {
  return {
    sessionEvent: params => router.onSessionUpdate(connection, params, params.event),

    requestPermission: (params: AcpPermissionParams): Promise<RequestPermissionResponse> => {
      return router.onPermissionRequest(connection, params);
    },

    readTextFile: async (params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
      return ports.fs.readTextFile(params);
    },

    writeTextFile: async (params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
      return ports.fs.writeTextFile(params);
    },

    createTerminal: async (params: CreateTerminalRequest): Promise<CreateTerminalResponse> => {
      return router.onCreateTerminal(connection, params);
    },

    terminalOutput: async (params: TerminalOutputRequest): Promise<TerminalOutputResponse> => {
      return ports.terminals.terminalOutput(params, connection.key);
    },

    waitForTerminalExit: async (
      params: WaitForTerminalExitRequest
    ): Promise<WaitForTerminalExitResponse> => {
      return ports.terminals.waitForTerminalExit(params, connection.key);
    },

    killTerminal: async (params: KillTerminalRequest): Promise<KillTerminalResponse> => {
      return ports.terminals.killTerminal(params, connection.key);
    },

    releaseTerminal: async (params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> => {
      return ports.terminals.releaseTerminal(params, connection.key);
    },
  };
}
