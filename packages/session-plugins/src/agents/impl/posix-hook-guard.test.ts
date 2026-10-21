import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { GUGU_HOOK_MARKER, makeStdinHookCommand } from '@gugu/session-core/agents/plugins/helpers';
import * as toml from 'smol-toml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awaitPending } from '../../../../../tests/support/awaitFact';
import { fixtureExecutable } from '../../../../../tests/support/fixtureExecutable';
import { makeCodexNotifyConfigOverride } from './codex/hooks';
import { qwenHookSpecs } from './qwen/hooks';
import { pluginRegistry } from '../registry';

/**
 * Every hook command gugu writes lands in the agent CLI's *global* config, so it
 * also runs for sessions gugu never started — where GUGU_HOOK_PORT and friends
 * are simply absent. Two things must hold for all of them, and the tests that
 * existed asserted neither (the POSIX one compared the command against a copy of
 * itself, which is true no matter what the command does):
 *
 *   1. With the env unset, the hook must not call out at all. Unguarded,
 *      `http://127.0.0.1:$GUGU_HOOK_PORT/hook` collapses to port 80 and posts
 *      the session's payload at whatever the user happens to run there.
 *   2. With the env set, the response body must not reach stdout. `curl -f` does
 *      not fail on 3xx and `|| true` only swallows the exit code, so without
 *      `-o /dev/null` a redirect page's HTML lands where the agent expects JSON.
 *
 * Both are checked by running the real command under a real bash, with a fake
 * `curl` first on PATH that records its argv — no network, no port 80.
 */

const fakeCurl = [
  '#!/bin/sh',
  'printf "%s\\n" "$*" >> "$EMDASH_TEST_CURL_LOG"',
  // Honour -o the way curl does, so the "body must not reach stdout" check is
  // about the flag being present rather than about this stub's behaviour.
  'out=""; prev=""',
  'for a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done',
  'cat > /dev/null',
  'if [ -n "$out" ]; then printf "<html>301</html>" > "$out"; else printf "<html>301</html>"; fi',
].join('\n');

let harnessDir = '';
let curlLog = '';

beforeAll(() => {
  // Built once, not per command: on a contended CI runner the per-command
  // mkdtemp/chmod/rm churn dominated everything and tripped the spawn timeout.
  harnessDir = mkdtempSync(join(tmpdir(), 'emdash-hook-guard-'));
  curlLog = join(harnessDir, 'curl-calls.txt');
  const curl = join(harnessDir, 'curl');
  // 假 curl 走 fixtureExecutable:硬链接到全机共用、首次执行费已付过的蹦床(#4357)。
  // 上面那条「built once, not per command」的注释描述的正是同一个坑的表层症状。
  fixtureExecutable(curl, fakeCurl);
});

afterAll(() => {
  if (harnessDir) rmSync(harnessDir, { recursive: true, force: true });
});

/**
 * Hooks whose payload arrives on stdin, as opposed to argv (`-d "$1"`) or a
 * baked-in body (`--data-binary '{…}'`). Read off the command because that is
 * the same distinction the builder itself makes, and it must hold on the
 * *skipped* branch too: a command that would have read stdin has a writer
 * attached either way.
 */
function consumesStdin(command: string): boolean {
  return command.includes('-d @-') || command.includes('$(cat)');
}

type RunResult = {
  stdout: string;
  calls: string[];
  /** Non-null when the writer's pipe was torn down under it — an unread payload. */
  stdinError: NodeJS.ErrnoException | null;
  code: number | null;
  signal: NodeJS.Signals | null;
};

/**
 * Async on purpose: `spawnSync` delivers EOF by queueing a `uv_shutdown` behind
 * the input write, and on macOS that shutdown intermittently never lands — the
 * child then sits in read(2) on an empty pipe until the spawn timeout kills it.
 * Measured on a CI runner at 7/6000 for `execFileSync({ input })` against 0/6000
 * for this path, same machine, arms interleaved; every failure came back at
 * exactly the timeout, so it is a hang and a larger budget buys nothing. Nothing
 * gugu ships uses spawnSync, so the test harness was the only thing exposed —
 * which is why every command here goes through this one runner, not just the
 * large-payload one that happened to fail first.
 *
 * The result splits the writer's errno from a non-zero exit. There is no
 * wall-clock watchdog (#4357): the run waits for `close`, and a command that
 * never closes stays pending under an `[awaiting-fact]` heartbeat until the CI
 * job's own limit — killing it here would hand the pending write an EPIPE and
 * dress the hang up as the drain regression this file exists for.
 */
function runHookCommand(
  command: string,
  hookEnv: Record<string, string>,
  stdinPayload = '{"session_id":"probe"}'
): Promise<RunResult> {
  writeFileSync(curlLog, '');

  return awaitPending(`hook command closes: ${command}`, new Promise<RunResult>((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: `${harnessDir}:${process.env.PATH ?? ''}`,
        HOME: harnessDir,
        EMDASH_TEST_CURL_LOG: curlLog,
        ...hookEnv,
      },
    });

    let stdout = '';
    let stdinError: NodeJS.ErrnoException | null = null;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    // The whole point of the drain: a skip path that exits without reading tears
    // down the read end mid-write, and the writer learns about it here.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      stdinError ??= err;
    });
    // ENOENT/EAGAIN from spawn itself. Without a listener node throws this on
    // the event emitter and takes the whole worker down instead of the test.
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        stdout,
        calls: readFileSync(curlLog, 'utf8').split('\n').filter(Boolean),
        stdinError,
        code,
        signal,
      });
    });

    child.stdin.end(consumesStdin(command) ? stdinPayload : undefined);
  }));
}

function commandsIn(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    try {
      parsed = toml.parse(content);
    } catch {
      return [];
    }
  }

  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.includes(GUGU_HOOK_MARKER)) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(parsed);
  return found;
}

function memoryFs(): PluginFs & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    read: async (path) => written.get(path) ?? null,
    write: async (path, content) => {
      written.set(path, content);
    },
    delete: async (path) => {
      written.delete(path);
    },
    exists: async (path) => written.has(path),
    list: async () => [],
  };
}

async function shippedHookCommands(): Promise<{ id: string; command: string }[]> {
  const out: { id: string; command: string }[] = [];

  for (const plugin of pluginRegistry.getAll()) {
    const writeHooks = plugin.behavior.hooks?.writeHooks;
    if (!writeHooks) continue;
    const fs = memoryFs();
    // 最新版本:有版本门的键(HookSpec.sinceVersion)的命令也要过这道守卫。
    await writeHooks(fs, [{ event: 'gugu', command: GUGU_HOOK_MARKER }], { harnessVersion: '999.0.0' });
    for (const content of fs.written.values()) {
      for (const command of commandsIn(content)) {
        out.push({ id: plugin.metadata.id, command });
      }
    }
  }

  // Codex's `notify` never touches the fs — it ships as a CLI override, so the
  // fs sweep above cannot see it. It is one of the three sites this guard exists
  // for, hence lifted in by hand.
  const notify = makeCodexNotifyConfigOverride();
  const argv = JSON.parse(notify.slice(notify.indexOf('=') + 1)) as string[];
  for (const arg of argv) {
    if (arg.includes(GUGU_HOOK_MARKER)) out.push({ id: 'codex:notify', command: arg });
  }
  // qwen 的 hooks 同样不经写入器:它们住在终端腿那份会话级 system settings 副本里(#6195)。
  for (const { command } of qwenHookSpecs()) out.push({ id: 'qwen:session', command });

  return out;
}

describe.skipIf(process.platform === 'win32')('POSIX hook commands', () => {
  it('sweeps every hook-capable plugin, not an empty list', async () => {
    const commands = await shippedHookCommands();
    const ids = new Set(commands.map((c) => c.id));

    // Positive control: if this sweep silently found nothing, the checks below
    // would pass over an empty list and read as green.
    expect(commands.length).toBeGreaterThan(20);
    expect(ids.has('claude')).toBe(true);
    expect(ids.has('codex:notify')).toBe(true);
    expect(ids.has('qwen:session')).toBe(true);
  });

  it('stays silent when gugu did not start the session', async () => {
    const commands = await shippedHookCommands();

    for (const { id, command } of commands) {
      const { stdout, calls } = await runHookCommand(command, {});
      expect(calls, `${id} called out with no hook env: ${command}`).toEqual([]);
      expect(stdout, `${id} wrote to stdout with no hook env`).toBe('');
    }
  });

  it('keeps the response body out of stdout when it does post', async () => {
    const commands = await shippedHookCommands();

    for (const { id, command } of commands) {
      const { stdout, calls } = await runHookCommand(command, {
        GUGU_HOOK_PORT: '48213',
        GUGU_HOOK_TOKEN: 'nonce',
        GUGU_PTY_ID: 'pty-1',
      });

      expect(calls.length, `${id} did not post with the hook env set`).toBeGreaterThan(0);
      expect(calls.join('\n'), `${id} posted somewhere other than the hook port`).toContain(
        'http://127.0.0.1:48213/hook'
      );
      expect(stdout, `${id} leaked the response body to stdout`).toBe('');
    }
  });

  it('drains a skipped stdin payload instead of breaking the writer pipe', async () => {
    // Larger than a pipe buffer (64 KiB Linux / 16 KiB macOS) on purpose. With a
    // small payload the writer's bytes fit in the buffer and it finishes whether
    // or not anyone reads them, so "does the skip path drain?" becomes a race
    // decided by scheduling. At this size a skip path that fails to drain always
    // EPIPEs and one that drains always succeeds. Kept to this one command
    // rather than the whole sweep so the cost stays at a single spawn.
    const payload = `{"session_id":"probe","pad":"${'x'.repeat(256 * 1024)}"}`;
    const command = makeStdinHookCommand('stop', { platform: 'linux' });

    const { stdinError, code, signal, calls } = await runHookCommand(command, {}, payload);

    expect(stdinError, `跳过分支没有排空 stdin，写方的管道被打断(${stdinError?.code}): ${command}`)
      .toBeNull();
    expect(code, `跳过分支未正常退出(code=${code} signal=${signal}): ${command}`).toBe(0);
    // Silence is the other half of the skip contract, and the payload size has no
    // bearing on it — without this the large-payload case would stay green if the
    // skip branch ever started posting.
    expect(calls, `跳过分支在没有 hook env 时发起了调用: ${command}`).toEqual([]);
  });
});

describe('改名前后两套钩子条目同时留在配置里', () => {
  // 每次起会话前咕咕都会重写钩子;可同一台机器上还开着的旧版本,会把它那套旧条目再写回同一份配置。
  // 于是同一个事件会同时跑新旧两条命令 —— 靠各自只认自己那套变量来保证:谁起的会话,只有谁那条会发。
  const legacyStopCommand =
    'if [ -n "$EMDASH_HOOK_PORT" ] && [ -n "$EMDASH_HOOK_NONCE" ] && [ -n "$EMDASH_PTY_ID" ]; then ' +
    'curl -sf -o /dev/null -X POST -H "Content-Type: application/json" ' +
    '-H "X-Emdash-Token: $EMDASH_HOOK_NONCE" -H "X-Emdash-Pty-Id: $EMDASH_PTY_ID" ' +
    '-H "X-Emdash-Event-Type: stop" -d @- "http://127.0.0.1:$EMDASH_HOOK_PORT/hook" || true; ' +
    'else cat > /dev/null; fi';
  const currentStopCommand = makeStdinHookCommand('stop', { platform: 'linux' });

  it('a session this build started: the leftover legacy entry stays silent, the current one posts once', async () => {
    const env = { GUGU_HOOK_PORT: '4321', GUGU_HOOK_TOKEN: 'new-token', GUGU_PTY_ID: 'claude-conv-1' };
    const legacy = await runHookCommand(legacyStopCommand, env);
    const current = await runHookCommand(currentStopCommand, env);

    expect(legacy.calls).toEqual([]);
    expect(current.calls).toHaveLength(1);
    expect(current.calls[0]).toContain('X-Gugu-Token: new-token');
  });

  it('a session an older build started: the current entry stays silent, the legacy one posts once', async () => {
    const env = { EMDASH_HOOK_PORT: '4321', EMDASH_HOOK_NONCE: 'old-token', EMDASH_PTY_ID: 'claude-conv-1' };
    const legacy = await runHookCommand(legacyStopCommand, env);
    const current = await runHookCommand(currentStopCommand, env);

    expect(current.calls).toEqual([]);
    expect(legacy.calls).toHaveLength(1);
  });
});
