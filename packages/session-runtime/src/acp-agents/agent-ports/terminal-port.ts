import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from '@agentclientprotocol/sdk';
import type { AgentTerminalManager } from './terminal-manager';

export class TerminalPort {
  constructor(private readonly terminals: AgentTerminalManager) {}

  async createTerminal(
    sessionId: string,
    defaultCwd: string,
    params: CreateTerminalRequest,
    connectionKey: string
  ): Promise<CreateTerminalResponse> {
    const envRecord = params.env
      ? Object.fromEntries(params.env.map((e) => [e.name, e.value]))
      : {};
    const terminalId = await this.terminals.create(sessionId, {
      command: params.command,
      args: params.args ?? [],
      env: envRecord,
      cwd: params.cwd ?? defaultCwd,
      outputByteLimit: params.outputByteLimit,
      scope: JSON.stringify([connectionKey, params.sessionId]),
    });
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest, connectionKey: string): Promise<TerminalOutputResponse> {
    const terminal = this.terminals.getOwned(params.terminalId, JSON.stringify([connectionKey, params.sessionId]));
    if (!terminal) throw new Error(`AcpRuntime: terminal not found: ${params.terminalId}`);
    const snap = terminal.snapshot();
    return {
      output: snap.output,
      truncated: snap.truncated,
      exitStatus: snap.exitStatus ?? undefined,
    };
  }

  async waitForTerminalExit(
    params: WaitForTerminalExitRequest,
    connectionKey: string
  ): Promise<WaitForTerminalExitResponse> {
    const terminal = this.terminals.getOwned(params.terminalId, JSON.stringify([connectionKey, params.sessionId]));
    if (!terminal) throw new Error(`AcpRuntime: terminal not found: ${params.terminalId}`);
    const status = await terminal.waitForExit();
    return { exitCode: status.exitCode, signal: status.signal ?? undefined };
  }

  async killTerminal(params: KillTerminalRequest, connectionKey: string): Promise<KillTerminalResponse> {
    const terminal = this.terminals.getOwned(params.terminalId, JSON.stringify([connectionKey, params.sessionId]));
    if (!terminal) throw new Error(`AcpRuntime: terminal not found: ${params.terminalId}`);
    terminal.kill();
    return {};
  }

  releaseTerminal(params: ReleaseTerminalRequest, connectionKey: string): ReleaseTerminalResponse {
    if (this.terminals.get(params.terminalId) && !this.terminals.getOwned(params.terminalId, JSON.stringify([connectionKey, params.sessionId]))) {
      throw new Error(`AcpRuntime: terminal not found: ${params.terminalId}`);
    }
    this.terminals.release(params.terminalId);
    return {};
  }
}
