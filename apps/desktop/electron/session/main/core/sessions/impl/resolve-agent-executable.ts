import fs from 'node:fs';
import path from 'node:path';
import type { DependencyId, Installation } from '@gugu/session-core/deps/runtime';
import { resolveActiveInstallation, resolveCommandPath } from '@gugu/session-core/deps/runtime';
import type { IHostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import type { IExecutionContext } from '@gugu/session-core/exec';
import { log } from '@main/lib/logger';

/**
 * Per-context cache: keyed by `${connectionId ?? 'local'}:${providerId}` → resolved absolute path.
 * Populated on first successful resolution; cleared when a new installation is triggered.
 */
const resolvedPathCache = new Map<string, string>();

export function clearResolvedPathCache(providerId: string, connectionId?: string): void {
  resolvedPathCache.delete(cacheKey(providerId, connectionId));
}

async function resolveSelectedCommand(command: string, ctx: IExecutionContext): Promise<string | null> {
  const resolved = await resolveCommandPath(command, ctx);
  if (!resolved) return null;
  // `which /absolute/missing` can echo its argument on macOS. Verify an
  // absolute selection is an executable before treating it as installed.
  // Windows has no `test`, and `where dir:file` already fails for a missing file.
  if (process.platform !== 'win32' && path.isAbsolute(command)) {
    try {
      await ctx.exec('test', ['-x', command]);
    } catch {
      return null;
    }
  }
  return resolved;
}

/** A missing harness is deterministic and must reach the product repair surface. */
export class HarnessNotInstalledError extends Error {
  constructor(readonly providerId: string, readonly harnessName: string, detail?: string) {
    super(`${providerId} not installed: ${detail ?? `harness "${harnessName}" was not found`}`);
    this.name = 'HarnessNotInstalledError';
  }
}

/**
 * The harness is being replaced on disk right now — a self-update or a reinstall.
 *
 * This is **not** the deterministic absence `HarnessNotInstalledError` stands for, and telling the
 * user to install something that is already installed sends them the wrong way. A package manager
 * swapping a copy in place leaves a window where the file is present but not yet executable, so
 * `which` reports nothing: npm writing @anthropic-ai/claude-code (215 MB) held that window open for
 * 10s on #5173, and the copy that opened it was the one Claude Code's own auto-updater fetched
 * while gugu was spawning a second conversation.
 *
 * It resolves itself, so — unlike a missing harness — retrying is the correct repair.
 */
export class HarnessUpdatingError extends Error {
  constructor(readonly providerId: string, readonly harnessName: string, detail?: string) {
    super(`${providerId} is updating: ${detail ?? `harness "${harnessName}" is being replaced`}`);
    this.name = 'HarnessUpdatingError';
  }
}

/**
 * Tell "being replaced" apart from "gone" using the locations we already remembered.
 *
 * A path we recorded that is *still on disk* while `which` refuses it means something is sitting
 * there half-written — the package manager has not chmod'd it yet. Nothing left at any remembered
 * location means the harness really is gone.
 *
 * Best-effort by construction: only the local host is inspected, because these paths are read with
 * `fs` and a remote host's filesystem is not ours to stat. An SSH context therefore keeps today's
 * behaviour (classified as missing) rather than guessing — a wrong "wait a minute" would strand the
 * user on a harness that is never coming back.
 */
function harnessIsBeingReplaced(rememberedPaths: string[], ctx: IExecutionContext): boolean {
  if (!ctx.supportsLocalSpawn) return false;
  // existsSync follows symlinks: a live link to a file that is still being written counts as
  // present (the #5173 shape), while a link whose target is already gone counts as absent — the
  // conservative reading, since that is indistinguishable from an uninstall.
  return rememberedPaths.some((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
}

function cacheKey(providerId: string, connectionId?: string): string {
  return `${connectionId ?? 'local'}:${providerId}`;
}

/**
 * Resolve the absolute path of the agent binary to use for conversation spawns.
 *
 * Resolution order:
 * 1. selection.kind === 'pinned': use selection.realpath if it exists on disk; otherwise fall through.
 * 2. selection.kind === 'path': use selection.path if it exists on disk; otherwise fall through.
 * 3. selection.kind === 'cli': resolve the selected command in the same execution context.
 * 4. selection.kind === 'method': use the copy that selection resolves to among `installations` —
 *    the same mapping the settings panel displays; otherwise fall through.
 * 5. selection.kind === 'auto' (or no override):
 *    a. In-memory cached path from dependency probe (cachedStatePath).
 *    b. Probe via ctx (resolveCommandPath).
 *    c. Fail loudly with the exhausted checks and a repair entrypoint.
 *
 * Step 4 exists so that what the panel says and what we spawn cannot disagree. Without it a
 * method selection fell through to the PATH winner, which is only the selected copy when the
 * app happens to win the PATH race — true for the copies the app installs itself (their bin
 * directory is prepended, see managed-agent-home.ts) and false for anything a system package
 * manager places, e.g. a Homebrew copy in /opt/homebrew/bin sitting behind an older ~/.local/bin
 * one. The panel would read the new version while the old binary kept being spawned: #4271
 * displaced rather than fixed. Resolving through the selection makes it method-agnostic and
 * removes the race instead of winning it.
 */
export async function resolveAgentExecutable({
  providerId,
  dependencyId = providerId,
  binaryName,
  ctx,
  hostDependencyStore,
  cachedStatePath,
  installations,
  connectionId,
}: {
  providerId: string;
  /**
   * 依赖管理器里那一行的 id —— 选择、探测缓存按它读。缺省 = `providerId`。
   * 某条腿跑的是伴随程序时(#6335,Antigravity 终端腿的 `agy` = `antigravity-cli`)它与插件 id 不同;
   * 报错里的 `providerId` 仍是插件 id:修复入口开的是那一家的面板。取值一律来自 `agentProgramFor`。
   */
  dependencyId?: string;
  binaryName: string;
  ctx: IExecutionContext;
  /** Store for reading the persisted host-scoped installation selection. */
  hostDependencyStore: IHostDependencyStore;
  /** The absolute path the dependency manager resolved during its last probe, if available. */
  cachedStatePath?: string | null;
  /**
   * The copies this host is known to have, as the dependency manager last enumerated them.
   * Only consulted for a `method` selection — that is the one kind that names a copy indirectly.
   */
  installations?: Installation[];
  connectionId?: string;
}): Promise<string> {
  const hostId = connectionId ?? 'local';
  const selection = await hostDependencyStore.getSelection(hostId, dependencyId as DependencyId);
  const harnessName = binaryName.trim() || providerId;
  const searched: string[] = [];
  // Every concrete location we were told to look at, kept so a failure can be classified:
  // still on disk = being replaced, nothing left = really gone. A bare PATH name is not a
  // location and never lands here.
  const rememberedPaths: string[] = [];

  if (selection?.kind === 'pinned') {
    const resolved = await resolveCommandPath(selection.realpath, ctx);
    if (resolved) return resolved;
    searched.push(`pinned realpath: ${selection.realpath}`);
    rememberedPaths.push(selection.realpath);
    log.warn(
      `[resolveAgentExecutable] Pinned realpath "${selection.realpath}" for ${providerId} not found — falling back to auto-resolution`
    );
  }

  if (selection?.kind === 'path') {
    const resolved = await resolveCommandPath(selection.path, ctx);
    if (resolved) return resolved;
    searched.push(`saved path: ${selection.path}`);
    rememberedPaths.push(selection.path);
    log.warn(
      `[resolveAgentExecutable] Saved path "${selection.path}" for ${providerId} not found — falling back to auto-resolution`
    );
  }

  if (selection?.kind === 'cli') {
    const resolved = await resolveSelectedCommand(selection.command, ctx);
    if (resolved) return resolved;
    searched.push(`selected cli: ${selection.command}`);
    // Only an absolute selection names a location we can stat; a bare command does not.
    if (path.isAbsolute(selection.command)) rememberedPaths.push(selection.command);
    const cliDetail = `selected command "${selection.command}" was not found`;
    throw harnessIsBeingReplaced(rememberedPaths, ctx)
      ? new HarnessUpdatingError(providerId, harnessName, cliDetail)
      : new HarnessNotInstalledError(providerId, harnessName, cliDetail);
  }

  if (selection?.kind === 'method') {
    const source = selection.registry
      ? `${selection.method}@${selection.registry}`
      : selection.method;
    const picked = installations ? resolveActiveInstallation(installations, selection) : undefined;
    if (picked) {
      const resolved = await resolveCommandPath(picked.realpath, ctx);
      if (resolved) return resolved;
      searched.push(`selected source ${source}: ${picked.realpath}`);
      rememberedPaths.push(picked.realpath);
      log.warn(
        `[resolveAgentExecutable] Copy selected for ${providerId} via ${source} ("${picked.realpath}") not found — falling back to auto-resolution`
      );
    } else {
      searched.push(`selected source ${source}: no copy of it on this host`);
      log.warn(
        `[resolveAgentExecutable] Selected source ${source} for ${providerId} matches no installed copy — falling back to auto-resolution`
      );
    }
  }

  // Auto-resolution with in-memory cache
  const key = cacheKey(dependencyId, connectionId);
  const cached = resolvedPathCache.get(key);
  if (cached) {
    const resolvedCachedPath = await resolveCommandPath(cached, ctx);
    if (resolvedCachedPath) return resolvedCachedPath;
    resolvedPathCache.delete(key);
    searched.push(`in-memory cache: ${cached}`);
    rememberedPaths.push(cached);
    log.warn(
      `[resolveAgentExecutable] Cached path "${cached}" for ${providerId} not found — falling back to live resolution`
    );
  }

  // Re-resolve the manager's cached path. On Windows an older probe may have
  // cached npm's extensionless POSIX shim instead of codex.exe/codex.cmd.
  if (cachedStatePath) {
    const resolvedCachedPath = await resolveCommandPath(cachedStatePath, ctx);
    if (resolvedCachedPath) {
      resolvedPathCache.set(key, resolvedCachedPath);
      return resolvedCachedPath;
    }
    searched.push(`dependency probe cache: ${cachedStatePath}`);
    rememberedPaths.push(cachedStatePath);
    log.warn(
      `[resolveAgentExecutable] Cached path "${cachedStatePath}" for ${providerId} not found — falling back to live resolution`
    );
  }

  // Live resolution via execution context
  const resolved = await resolveCommandPath(harnessName, ctx);
  if (resolved) {
    resolvedPathCache.set(key, resolved);
    return resolved;
  }

  searched.push(`PATH lookup: ${harnessName}`);
  const checked = ['Checked:', ...searched.map((entry) => `  - ${entry}`)];

  // A location we remembered is still on disk but refuses to run: the copy is mid-replacement,
  // not absent. Saying "install it" here points the user at work that is already happening and
  // that finishes on its own — so this failure is reported as transient and retryable instead.
  if (harnessIsBeingReplaced(rememberedPaths, ctx)) {
    throw new HarnessUpdatingError(providerId, harnessName, [
      `Harness "${harnessName}" is present but not runnable — it is being updated or reinstalled.`,
      ...checked,
      'This clears itself once the install finishes. Wait a minute, then retry.',
    ].join('\n'));
  }

  throw new HarnessNotInstalledError(providerId, harnessName, [
    `Could not resolve harness "${harnessName}" before spawn.`,
    ...checked,
    `Fix: install the ${harnessName} CLI, add it to the Desktop App PATH, or choose a valid executable path in agent settings, then retry.`,
  ].join('\n'));
}
