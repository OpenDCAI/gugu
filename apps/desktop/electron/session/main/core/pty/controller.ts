import { tuiInterruptWrites } from '@gugu/session-core/agents/plugins';
import { err, ok } from '@gugu/session-shared';
import { getPlugin, isValidProviderId } from '@main/core/agents/plugin-registry';
import { sessionEvents } from '@main/core/sessions/session-events';
import { resolveTerminalShell } from '@main/core/terminal-shell/resolver';
import { log } from '@main/lib/logger';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { sessionWorkspaceManager } from '../sessions/session-workspace-manager';
import { spawnLocalPty } from './local-pty';
import {
  cleanupExpiredDroppedBlobs,
  persistClipboardImagePath,
  persistDroppedBlobBytes,
} from './persist-dropped-blob';
import { buildTerminalEnv } from './pty-env';
import { ptySessionRegistry } from './pty-session-registry';
import { resolveLocalPtySpawn } from './pty-spawn-platform';
import { getTerminalColorEnv } from './terminal-color-scheme';
import { writeTerminalInput } from './terminal-input';

void cleanupExpiredDroppedBlobs().catch((error) => {
  log.warn('pty:cleanupExpiredDroppedBlobs failed', { error });
});

/** 临时 shell 起的网格;窗格量好之后渲染层照常发 resize。 */
const SCRATCH_SIZE = { cols: 80, rows: 24 };

/**
 * 这家 harness 的可见终端要求提交键与前一次写入隔开多久。只有会话 PTY 有 providerId(普通终端没有),
 * 所以普通终端与未声明的 harness 都拿到 0 —— 逐字节直写,与声明这条约束之前完全一致。
 */
function submitSeparationMsFor(ptySessionId: string): number {
  const providerId = ptySessionRegistry.getMetadata(ptySessionId)?.providerId;
  if (!providerId || !isValidProviderId(providerId)) return 0;
  const sessionTui = getPlugin(providerId).capabilities.sessionBundle.sessionpage['tui'];
  return sessionTui?.terminalInput?.submitSeparationMs ?? 0;
}

export const ptyController = createRPCController({
  /** Create an ephemeral project shell for UI that exists before a task record does. */
  createScratch: async (args: { ptySessionId: string; cwd: string }) => {
    const parsed = parsePtySessionId(args.ptySessionId);
    if (!parsed || parsed.scopeId !== 'draft') {
      return err({ type: 'invalid_session' as const, message: 'Invalid draft terminal session' });
    }
    if (ptySessionRegistry.get(args.ptySessionId)) return ok();

    try {
      // Scratch terminals deliberately skip the workspace terminal provider: acquiring that provider
      // also starts Git, file indexing, and a workspace lease.
      const shellProfile = await resolveTerminalShell({
        intent: 'system',
        target: { kind: 'local' },
      });
      const resolved = resolveLocalPtySpawn({
        platform: process.platform,
        env: process.env,
        intent: {
          kind: 'interactive-shell',
          cwd: args.cwd,
          shellProfile,
        },
      });
      const pty = spawnLocalPty({
        id: args.ptySessionId,
        command: resolved.command,
        args: resolved.args,
        cwd: resolved.cwd,
        env: {
          ...buildTerminalEnv({ shellProfile }),
          ...(await getTerminalColorEnv()),
        },
        cols: SCRATCH_SIZE.cols,
        rows: SCRATCH_SIZE.rows,
      });
      ptySessionRegistry.register(args.ptySessionId, pty, {
        size: SCRATCH_SIZE,
        metadata: { title: '终端' },
      });
      return ok();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('pty:createScratch failed', { ptySessionId: args.ptySessionId, error: message });
      return err({ type: 'spawn_failed' as const, message });
    }
  },

  /**
   * Send raw input data to a PTY session.
   *
   * Resolves after the bytes are in the PTY, because a submit key may be held back briefly so the
   * harness can still tell the text and the submit apart (see `terminal-input.ts` / #4525).
   */
  sendInput: async (ptySessionId: string, data: string) => {
    const pty = ptySessionRegistry.get(ptySessionId);
    if (!pty) return err({ type: 'not_found' as const });
    await writeTerminalInput({
      ptySessionId,
      pty,
      data,
      submitSeparationMs: submitSeparationMsFor(ptySessionId),
    });
    if (data.includes('\r')) {
      const meta = ptySessionRegistry.getMetadata(ptySessionId);
      if (meta?.providerId) {
        const parsed = parsePtySessionId(ptySessionId);
        if (parsed) {
          sessionEvents._emit('session:input-submitted', {
            projectId: parsed.projectId,
            sessionId: parsed.leafId,
            providerId: meta.providerId,
          });
        }
      }
    }
    return ok();
  },

  /**
   * 暂停一个 agent 会话 —— 把这一家自己的中断键写进 pty。
   *
   * ⚠️ 三级术语(见 `SessionCoexistence.pause`):这是**暂停** —— agent 停下手里的活,
   * 进程活着、会话还在、能接着说。它不是 `kill`(进程没了),也不是 `stopSession`(还从
   * provider 的重生跟踪里摘掉)。混用会让界面报错一级:点「暂停」却把会话杀了。
   *
   * 键位来自 descriptor 的 `sessionTuiInterrupt`,展开成写入序列由 `tuiInterruptWrites` 负责 ——
   * 本函数只按拍子写字节,不理解任何一家的键位语义。没声明键位的家返回 `unsupported`,
   * ❌ 不许回落到 Ctrl-C:那对不少家等于直接退进程,是「暂停」变「杀掉」。
   */
  interrupt: async (ptySessionId: string) => {
    const pty = ptySessionRegistry.get(ptySessionId);
    if (!pty) return err({ type: 'not_found' as const });

    // providerId 只有会话 PTY 才有(普通终端没有),这正好把「暂停」限制在 agent 会话上。
    const providerId = ptySessionRegistry.getMetadata(ptySessionId)?.providerId;
    if (!providerId) return err({ type: 'not_a_conversation' as const });

    // ⚠️ `getPlugin` 在 id 查不到时**抛**(plugin-registry.ts:4-8),而本函数其余每条失败路径都
    // 返回 typed `err(...)` —— 不接住的话,一个已下线/改过名的 providerId 会以裸 RPC reject
    // 的形式冒出去,与这里的约定不一致。今天窄(metadata 的 id 来自 spawn 时的注册表),
    // 但 provider 改名正是让它够得着的那种改动。
    // 用 `isValidProviderId` 先探一下再取,别新拉 `@gugu/session-plugins/agents` 进主进程 ——
    // 主进程的别名解析与 tsc 不同源(见 rollup 别名坑),能不新增就不新增。探过之后
    // `getPlugin` 的那条 throw 已不可达。
    if (!isValidProviderId(providerId)) return err({ type: 'unsupported' as const, providerId });
    const interrupt = getPlugin(providerId).capabilities.sessionBundle.sessionTuiInterrupt;
    if (!interrupt) return err({ type: 'unsupported' as const, providerId });

    try {
      for (const write of tuiInterruptWrites(interrupt)) {
        if (write.delayMs > 0) {
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, write.delayMs));
        }
        // 每一拍都重取:等待期间会话可能已经退出,继续写就是往一个死 pty 上写。
        if (ptySessionRegistry.get(ptySessionId) !== pty) break;
        pty.write(write.data);
      }
    } catch (e) {
      log.warn('ptyController.interrupt: error writing interrupt sequence', {
        ptySessionId,
        providerId,
        error: String(e),
      });
      return err({ type: 'interrupt_failed' as const, message: String((e as Error)?.message || e) });
    }
    return ok();
  },

  /** Resize a PTY session to the given terminal dimensions. */
  resize: (ptySessionId: string, cols: number, rows: number) => {
    const resized = ptySessionRegistry.resize(ptySessionId, cols, rows);
    if (!resized) return err({ type: 'not_found' as const });
    return ok();
  },

  /**
   * Return the session's current screen (pty-screen.ts: content + terminal modes)
   * and register the renderer as a consumer for future IPC delivery.
   * Called once by the renderer when connecting a FrontendPty to a session.
   *
   * `size` is the grid the snapshot was drawn for. The renderer replays it on
   * that grid (FrontendPty.connect).
   */
  subscribe: async (ptySessionId: string) => {
    return ok(await ptySessionRegistry.subscribe(ptySessionId));
  },

  /**
   * Remove the renderer's consumer registration for a session.
   * Called when the renderer disposes its FrontendPty.
   */
  unsubscribe: (ptySessionId: string) => {
    ptySessionRegistry.unsubscribe(ptySessionId);
    return ok();
  },

  /** Kill a PTY session and clean it up immediately. */
  kill: (ptySessionId: string) => {
    const pty = ptySessionRegistry.get(ptySessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('ptyController.kill: error killing PTY', { ptySessionId, error: String(e) });
      }
    }
    ptySessionRegistry.unregister(ptySessionId);
    return ok();
  },

  /**
   * Stop a session for good without deleting its conversation/terminal record.
   *
   * Unlike `kill`, which only terminates the OS process, this routes through
   * the owning provider so the session is removed from its respawn tracking
   * (`knownSessionIds`/`sessions`). A bare `kill` leaves those intact, so the
   * provider's `onExit` handler respawns the PTY ~500ms later — which is what
   * made killing from the resource monitor appear to do nothing. The tab and
   * its history are preserved; the session simply stays stopped until the task
   * is remounted or the user starts a new one.
   */
  stopSession: async (ptySessionId: string) => {
    const parsed = parsePtySessionId(ptySessionId);
    if (!parsed) return err({ type: 'invalid_session' as const });
    const { scopeId, leafId } = parsed;

    // Agents and terminals are scoped by task id, so the task lookup resolves
    // the owning provider. Whether this leaf is a conversation is the conversation
    // provider's own fact (#6183): a session that is still starting has no PTY in
    // the registry yet, and stopping it is exactly how a stuck start is cancelled.
    const session = sessionWorkspaceManager.getSession(scopeId);
    const isSession = session?.sessions.ownsSession(leafId) ?? false;
    // 停止是用户动作,成功时也要留一行:否则「停到了会话」与「落到了别的分支、什么都没停」读起来一模一样。
    log.info('ptyController.stopSession', { ptySessionId, sessionMounted: Boolean(session), isSession });
    if (session) {
      try {
        if (isSession) {
          await session.sessions.stopSession(leafId);
        } else {
          await session.terminals.killTerminal(leafId);
        }
      } catch (e) {
        log.warn('ptyController.stopSession: error stopping session PTY', {
          ptySessionId,
          error: String(e),
        });
        return err({ type: 'stop_failed' as const, message: String((e as Error)?.message || e) });
      }
      return ok();
    }

    // Lifecycle scripts are scoped by workspace id (no task match) and never
    // respawn, so a raw kill is sufficient and safe.
    const pty = ptySessionRegistry.get(ptySessionId);
    if (pty) {
      try {
        pty.kill();
      } catch (e) {
        log.warn('ptyController.stopSession: error killing PTY', { ptySessionId, error: String(e) });
      }
    }
    ptySessionRegistry.unregister(ptySessionId);
    return ok();
  },

  /**
   * Persist a dropped or pasted in-memory image to a stable temp file.
   * HEIC/HEIF bytes are converted to PNG so Claude Code can inline them.
   */
  persistDroppedBlob: async (args: { bytes: Uint8Array; name?: string; mimeType?: string }) => {
    try {
      const path = await persistDroppedBlobBytes(args);
      return ok({ path });
    } catch (e: unknown) {
      log.error('pty:persistDroppedBlob failed', {
        error: (e as Error)?.message || e,
      });
      return err({ type: 'persist_failed' as const, message: String((e as Error)?.message || e) });
    }
  },

  /** Persist the OS clipboard image (macOS HEIC paste, screenshots, etc.). */
  persistClipboardImage: async () => {
    try {
      const path = await persistClipboardImagePath();
      return ok({ path });
    } catch (e: unknown) {
      log.error('pty:persistClipboardImage failed', {
        error: (e as Error)?.message || e,
      });
      return err({ type: 'persist_failed' as const, message: String((e as Error)?.message || e) });
    }
  },
});
