import { spawnOwnedChild } from '@gugu/session-core/exec';
import type { InstallProgressReport } from '@gugu/session-core/deps';

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** 剩余时间上限,口径同 `install-progress-meter.ts` 的同名常量。 */
const MAX_PLAUSIBLE_ETA_SECONDS = 6 * 60 * 60;
const BYTE_UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/**
 * Pinned mise's captured-stderr protocol, measured on v2026.9.12. Never invent a denominator.
 *
 * 认三种工具行,因为一次托管安装最多牵三个东西:
 *  · `http:gugu-<id>@…`  平台归档那条后端;
 *  · `npm:<包>@…`        npm 那条后端(aube);
 *  · `node@<版本>`       npm 后端一起装的解释器 —— 第一次装时它就是那 50MB,
 *                        不认它的话进度条会在下 node 的整段时间里一动不动。
 *
 * 实测到的阶段词(2026-09-22,同一个版本):`downloading` / `extracting` / `installing`、
 * aube 的 `checking package` / `resolving` / `fetching`、装完 node 时的 `node -v` / `npm -v`。
 * `waiting for node@…` 刻意不报:那一行不是一个阶段,是「还没开始」。
 */
export function miseProgress(line: string, elapsedMs: number): InstallProgressReport | undefined {
  const text = line.replace(ANSI, '');
  if (!/^\s*(?:http:gugu-[A-Za-z0-9_-]+|npm:(?:@[^\s@/]+\/)?[^\s@]+|node)@/.test(text)) return undefined;
  if (/\bwaiting for\b/.test(text)) return undefined;
  const phase = /\bchecking package\b|\bresolving\b/.test(text) ? 'resolving'
    : /\bdownloading\b|\bfetching\b/.test(text) ? 'downloading'
    : /\bextracting\b|\binstalling\b|\bnode -v\b|\bnpm -v\b/.test(text) ? 'installing' : undefined;
  if (!phase) return undefined;
  const bytes = /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\s+(B|KB|MB|GB|KiB|MiB|GiB)\b/.exec(text);
  const rate = /(\d+(?:\.\d+)?)\s+(B|KB|MB|GB|KiB|MiB|GiB)\/s\b/.exec(text);
  const bytesDone = bytes ? Number(bytes[1]) * BYTE_UNITS[bytes[3]!]! : undefined;
  const bytesTotal = bytes ? Number(bytes[2]) * BYTE_UNITS[bytes[3]!]! : undefined;
  const bytesPerSecond = rate ? Number(rate[1]) * BYTE_UNITS[rate[2]!]! : undefined;
  // 剩余时间:mise 自己不报,但同一行里分子、分母、速度都是它的一手计数,除出来就是事实 ——
  // ❌ 不是估算。实测(2026-09-23,antigravity-acp 316 MB 的 zip)那一行长这样:
  // `downloading  12.0s  29.0/316.0 MB · 2.6 MB/s`。三样缺一样就不报。
  const eta = bytesDone !== undefined && bytesTotal !== undefined && bytesPerSecond && bytesTotal > bytesDone
    ? Math.round((bytesTotal - bytesDone) / bytesPerSecond)
    : undefined;
  return {
    phase, elapsedMs,
    ...(bytes ? { bytesDone, bytesTotal } : {}),
    ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
    // 与 `install-progress-meter.ts` 同一条上限:算得出但不可信的剩余时间(起步那几秒)不报。
    ...(eta !== undefined && eta <= MAX_PLAUSIBLE_ETA_SECONDS ? { etaSeconds: eta } : {}),
  };
}

/** Direct process execution; cancellation waits for the owned process tree to terminate. */
export function runMiseProcess(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const owned = spawnOwnedChild(command, args, {
      cwd: options.cwd, env: options.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      onError: (error) => { options.signal?.removeEventListener('abort', abort); reject(error); },
    });
    const child = owned.child;
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    let kill: Promise<void> | undefined;
    const abort = () => {
      if (!child.pid || kill) return;
      kill = owned.stop({ graceMs: 0 });
      void kill.catch(reject);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      pendingLine += chunk;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) options.onOutput?.(line);
    });
    child.once('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      if (pendingLine) options.onOutput?.(pendingLine);
      void (async () => {
        if (kill) await kill;
        options.signal?.throwIfAborted();
        if (code !== 0) throw new Error(stderr.trim() || 'mise exited with code ' + code);
        return stdout.trim();
      })().then(resolve, reject);
    });
  });
}
