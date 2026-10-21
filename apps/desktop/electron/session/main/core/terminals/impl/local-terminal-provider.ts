import type { IExecutionContext } from '@gugu/session-core/exec';
import { previewServerService } from '@main/core/preview-servers/preview-server-service-instance';
import { wireTerminalUrlDetector } from '@main/core/preview-servers/terminal-url-detector';
import { isUnexpectedPtyExit } from '@main/core/pty/exit-classification';
import { spawnLocalPty } from '@main/core/pty/local-pty';
import type { Pty } from '@main/core/pty/pty';
import { buildTerminalEnv } from '@main/core/pty/pty-env';
import { ptySessionRegistry, type PtySessionMetadata } from '@main/core/pty/pty-session-registry';
import {
  logLocalPtySpawnWarnings,
  resolveLocalPtySpawn,
  type PtyCommandSpec,
  type PtySpawnIntent,
} from '@main/core/pty/pty-spawn-platform';
import { getTerminalColorEnv } from '@main/core/pty/terminal-color-scheme';
import {
  assertTmuxAvailable,
  killTmuxSession,
  makeTmuxSessionName,
} from '@main/core/pty/tmux-session-name';
import { resolveTerminalShell } from '@main/core/terminal-shell/resolver';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';
import { log } from '@main/lib/logger';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import type { Terminal } from '@shared/core/terminals/terminals';
import {
  type LifecycleScriptSpawnRequest,
  type TerminalProvider,
  type TerminalSpawnOptions,
} from '../terminal-provider';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_RESPAWNS = 2;

type SpawnPolicy = {
  respawnOnExit: boolean;
  preserveBufferOnExit: boolean;
  watchDevServer: boolean;
};

export class LocalTerminalProvider implements TerminalProvider {
  readonly kind = 'local' as const;

  private ptysBySession = new Map<string, Pty>();
  private knownPtySessionIds = new Set<string>();
  private shellProfiles = new Map<string, ResolvedShellProfile>();
  private respawnCounts = new Map<string, number>();
  private readonly projectId: string;
  private readonly workspaceId: string;
  private readonly scopeId: string;
  private readonly sessionPath: string;
  private readonly tmuxByPtySession = new Map<string, boolean>();
  private readonly resolveTmuxSetting: () => Promise<boolean>;
  private readonly shellSetup?: string;
  private readonly ctx: IExecutionContext;
  private readonly sessionEnvVars: Record<string, string>;

  constructor({
    projectId,
    workspaceId,
    scopeId,
    sessionPath,
    tmux = false,
    shellSetup,
    ctx,
    sessionEnvVars = {},
  }: {
    projectId: string;
    workspaceId?: string;
    scopeId: string;
    sessionPath: string;
    tmux?: boolean | (() => Promise<boolean>);
    shellSetup?: string;
    ctx: IExecutionContext;
    sessionEnvVars?: Record<string, string>;
  }) {
    this.projectId = projectId;
    this.workspaceId = workspaceId ?? scopeId;
    this.scopeId = scopeId;
    this.sessionPath = sessionPath;
    const initialTmux = typeof tmux === 'boolean' ? tmux : false;
    this.resolveTmuxSetting = typeof tmux === 'function' ? tmux : async () => initialTmux;
    this.shellSetup = shellSetup;
    this.ctx = ctx;
    this.sessionEnvVars = sessionEnvVars;
  }

  async spawnTerminal(
    terminal: Terminal,
    initialSize: { cols: number; rows: number } = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    options: TerminalSpawnOptions = {}
  ): Promise<void> {
    return this.spawnWithPolicy(
      terminal,
      initialSize,
      options.command
        ? { kind: 'argv', command: options.command.command, args: options.command.args }
        : undefined,
      undefined,
      options.shell ?? terminal.shellId,
      { title: terminal.name },
      {
        respawnOnExit: true,
        preserveBufferOnExit: false,
        watchDevServer: true,
      }
    );
  }

  async spawnLifecycleScript({
    terminal,
    command,
    shellSetup,
    initialSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    respawnOnExit = false,
    preserveBufferOnExit = true,
    watchDevServer = false,
  }: LifecycleScriptSpawnRequest): Promise<void> {
    return this.spawnWithPolicy(
      terminal,
      initialSize,
      command === undefined ? undefined : { kind: 'shell-line', commandLine: command },
      shellSetup,
      'system',
      undefined,
      {
        respawnOnExit,
        preserveBufferOnExit,
        watchDevServer,
      }
    );
  }

  async getLifecycleScriptShellFamily(terminalId: string) {
    const ptySessionId = makePtySessionId(this.projectId, this.scopeId, terminalId);
    const shellProfile = await this.getSessionShellProfile(ptySessionId, 'system');
    return shellProfile.family;
  }

  private async spawnWithPolicy(
    terminal: Omit<Terminal, 'sessionId'>,
    initialSize: { cols: number; rows: number },
    command: PtyCommandSpec | undefined,
    shellSetup: string | undefined,
    shellIntent: TerminalShellId,
    metadata: PtySessionMetadata | undefined,
    policy: SpawnPolicy
  ): Promise<void> {
    const ptySessionId = makePtySessionId(terminal.projectId, this.scopeId, terminal.id);
    this.knownPtySessionIds.add(ptySessionId);
    if (this.ptysBySession.has(ptySessionId)) return;
    const tmuxEnabled = await this.resolveTmuxSetting();
    if (tmuxEnabled && process.platform !== 'win32') {
      await assertTmuxAvailable(this.ctx, `terminal ${terminal.id}`);
    }
    const shellProfile = await this.getSessionShellProfile(ptySessionId, shellIntent);

    const intent: PtySpawnIntent = command
      ? {
          kind: 'run-command',
          cwd: this.sessionPath,
          command,
          shellProfile,
          shellSetup: shellSetup ?? this.shellSetup,
          tmuxEnabled,
          tmuxSessionName: tmuxEnabled ? makeTmuxSessionName(ptySessionId) : undefined,
        }
      : {
          kind: 'interactive-shell',
          cwd: this.sessionPath,
          shellProfile,
          shellSetup: shellSetup ?? this.shellSetup,
          tmuxEnabled,
          tmuxSessionName: tmuxEnabled ? makeTmuxSessionName(ptySessionId) : undefined,
        };
    const resolved = resolveLocalPtySpawn({
      platform: process.platform,
      env: process.env,
      intent,
    });

    logLocalPtySpawnWarnings('LocalTerminalProvider', resolved.warnings, {
      terminalId: terminal.id,
      ptySessionId,
    });

    const pty = spawnLocalPty({
      id: ptySessionId,
      command: resolved.command,
      args: resolved.args,
      cwd: resolved.cwd,
      env: {
        ...buildTerminalEnv({ shellProfile }),
        ...(await getTerminalColorEnv()),
        ...this.sessionEnvVars,
        ...resolved.env,
      },
      cols: initialSize.cols,
      rows: initialSize.rows,
    });
    this.tmuxByPtySession.set(ptySessionId, tmuxEnabled);

    if (policy.watchDevServer) {
      wireTerminalUrlDetector({
        pty,
        probeLocalPorts: true,
        onDetected: (server) => {
          void previewServerService
            .registerDetectedTarget({
              projectId: this.projectId,
              workspaceId: this.workspaceId,
              source: { kind: 'terminal-output', terminalId: terminal.id },
              protocol: server.protocol,
              host: server.host,
              port: server.port,
              urlPath: server.urlPath,
            })
            .catch((error) => {
              log.warn('LocalTerminalProvider: preview target registration failed', {
                terminalId: terminal.id,
                error: String(error),
              });
            });
        },
        onSourceClosed: (event) =>
          previewServerService.handleTerminalSourceClosed({
            projectId: this.projectId,
            workspaceId: this.workspaceId,
            terminalId: terminal.id,
            reason: event.reason,
            server: 'server' in event ? event.server : undefined,
          }),
      });
    }

    pty.onExit((info) => {
      const { exitCode, signal } = info;
      const shouldRespawn =
        policy.respawnOnExit &&
        this.ptysBySession.has(ptySessionId) &&
        isUnexpectedPtyExit({ exitCode, signal });
      this.ptysBySession.delete(ptySessionId);
      const sessionTmux = this.tmuxByPtySession.get(ptySessionId) ?? tmuxEnabled;
      if (!policy.preserveBufferOnExit) {
        ptySessionRegistry.unregister(ptySessionId, { pty, exitInfo: info });
      }
      if (shouldRespawn && !sessionTmux) {
        const count = (this.respawnCounts.get(ptySessionId) ?? 0) + 1;
        this.respawnCounts.set(ptySessionId, count);

        if (count > MAX_RESPAWNS) {
          log.error('LocalTerminalProvider: respawn limit reached, giving up', {
            terminalId: terminal.id,
            respawnCount: count,
          });
          this.respawnCounts.delete(ptySessionId);
          this.shellProfiles.delete(ptySessionId);
          return;
        }

        setTimeout(() => {
          this.spawnWithPolicy(
            terminal,
            initialSize,
            command,
            shellSetup,
            shellIntent,
            metadata,
            policy
          ).catch((e) => {
            log.error('LocalTerminalProvider: respawn failed', {
              terminalId: terminal.id,
              error: String(e),
            });
          });
        }, 500);
      } else {
        this.shellProfiles.delete(ptySessionId);
      }
    });

    ptySessionRegistry.register(ptySessionId, pty, {
      size: initialSize,
      preserveBufferOnExit: policy.preserveBufferOnExit,
      metadata,
    });
    this.ptysBySession.set(ptySessionId, pty);
  }

  private async getSessionShellProfile(
    ptySessionId: string,
    shellIntent: TerminalShellId
  ): Promise<ResolvedShellProfile> {
    const existing = this.shellProfiles.get(ptySessionId);
    if (existing) return existing;
    const profile = await resolveTerminalShell({
      intent: shellIntent,
      target: { kind: 'local' },
    });
    this.shellProfiles.set(ptySessionId, profile);
    return profile;
  }

  async killTerminal(terminalId: string): Promise<void> {
    const ptySessionId = makePtySessionId(this.projectId, this.scopeId, terminalId);
    this.knownPtySessionIds.delete(ptySessionId);
    const pty = this.ptysBySession.get(ptySessionId);
    if (pty) {
      try {
        pty.kill();
      } catch {}
      this.ptysBySession.delete(ptySessionId);
      ptySessionRegistry.unregister(ptySessionId);
    }
    this.shellProfiles.delete(ptySessionId);
    const sessionTmux = this.tmuxByPtySession.get(ptySessionId) ?? false;
    if (sessionTmux) {
      await killTmuxSession(this.ctx, makeTmuxSessionName(ptySessionId));
    }
    this.tmuxByPtySession.delete(ptySessionId);
  }

  async destroyAll(): Promise<void> {
    const ptySessionIds = Array.from(this.knownPtySessionIds);
    await this.detachAll();
    await Promise.all(
      ptySessionIds
        .filter((id) => this.tmuxByPtySession.get(id) === true)
        .map((id) => killTmuxSession(this.ctx, makeTmuxSessionName(id)))
    );
    this.knownPtySessionIds.clear();
    this.tmuxByPtySession.clear();
    this.shellProfiles.clear();
  }

  async detachAll(): Promise<void> {
    for (const [ptySessionId, pty] of this.ptysBySession) {
      try {
        pty.kill();
      } catch {}
      ptySessionRegistry.unregister(ptySessionId);
      this.shellProfiles.delete(ptySessionId);
    }
    this.ptysBySession.clear();
  }
}
