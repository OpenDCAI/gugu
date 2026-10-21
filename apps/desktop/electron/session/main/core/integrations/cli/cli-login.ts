import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import {
  parseDwsDevicePrompt,
  parseWecomQrUrl,
  wecomQrPath,
  type CliLoginPrompt,
  type CliToolRecipe,
} from './cli-tools';
import type { InstalledCliTool } from './cli-tool-installer';
import { parseTmeetPrompt } from './tmeet-cli';

/**
 * 跑一次工具自带的登录:起进程,等它把「给人看的那一下」(授权链接 + 授权码 / 二维码)打出来,
 * 然后让它接着等对方确认,直到它自己退出。
 *
 * 进程在这台机器上跑 —— 连在哪台机器上就在哪台登(云电脑 / 咕咕 server 一样),
 * 人那一侧只需要看到链接或二维码;对方确认后,登录态落在这台机器上工具自己的目录里。
 */

export type CliLoginOutcome =
  | { kind: 'exited'; code: number | null; output: string }
  | { kind: 'timed-out'; output: string }
  | { kind: 'cancelled'; output: string };

export type CliLoginRun = {
  /** 链接 / 二维码出来了就给;进程先退了、或久久不出 → 抛错,带上它最后说的话。 */
  prompt: Promise<CliLoginPrompt>;
  /** 进程结束(或超时 / 取消)时落定,不会抛。 */
  done: Promise<CliLoginOutcome>;
  /** 多步授权中最新的一次提示；等待端据此刷新链接与二维码。 */
  readonly currentPrompt?: CliLoginPrompt;
  cancel(): void;
};

/** 链接 / 二维码多久没打出来就算起不来。 */
const PROMPT_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const STATUS_TIMEOUT_MS = 7_000;

export function cliToolEnv(recipe: CliToolRecipe, installed: InstalledCliTool): NodeJS.ProcessEnv {
  return { ...process.env, ...recipe.env(installed.homeDir) };
}

/** 进程输出的最后几行:失败时原样给人看(去掉终端颜色与二维码字符画)。 */
export function outputTail(output: string, lines = 8): string {
  return output
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !/[█▀▄]/.test(line))
    .slice(-lines)
    .join('\n');
}

export function startCliLogin(recipe: CliToolRecipe, installed: InstalledCliTool, work: string, options?: {
  args?: string[];
  parsePrompt?: (output: string) => Promise<CliLoginPrompt | null>;
}): CliLoginRun {
  const child = spawn(installed.binPath, options?.args ?? recipe.loginArgs(work), {
    env: cliToolEnv(recipe, installed),
    cwd: work,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 自成一个进程组:取消 / 超时时连它起的子进程一起结束 —— 只结束它自己,子进程攥着输出管道,
    // 「结束了」要等到子进程自己退(单测里实撞:取消等了 30 秒)。
    detached: true,
  });
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };
  let output = '';
  let settled: CliLoginOutcome['kind'] | null = null;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));

  const done = new Promise<CliLoginOutcome>((resolve) => {
    const timer = setTimeout(() => {
      settled ??= 'timed-out';
      stop();
    }, recipe.loginTimeoutMs);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      const kind = settled ?? 'exited';
      resolve(kind === 'exited' ? { kind, code, output } : { kind, output });
    };
    child.once('error', (error) => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });

  const prompt = new Promise<CliLoginPrompt>((resolve, reject) => {
    const started = Date.now();
    let exited = false;
    void done.then(() => (exited = true));
    const qrFile = wecomQrPath(work);
    const tick = async () => {
      try {
        if (options?.parsePrompt) {
          const found = await options.parsePrompt(output);
          if (found) return resolve(found);
        } else if (recipe.tool === 'tmeet') {
          const found = parseTmeetPrompt(output);
          if (found) return resolve(found);
        } else if (recipe.tool === 'dws') {
          const found = parseDwsDevicePrompt(output);
          if (found) return resolve(found);
        } else if (output.includes(qrFile) && existsSync(qrFile)) {
          const image = `data:image/png;base64,${(await fs.readFile(qrFile)).toString('base64')}`;
          const url = parseWecomQrUrl(output);
          return resolve({ kind: 'qr-code', image, ...(url ? { url } : {}) });
        }
        if (exited) {
          return reject(new Error(outputTail(output) || `${recipe.bin} stopped before showing how to log in.`));
        }
        if (Date.now() - started > PROMPT_TIMEOUT_MS) {
          stop();
          return reject(new Error(`${recipe.bin} did not show how to log in within a minute.\n${outputTail(output)}`.trim()));
        }
        setTimeout(() => void tick(), POLL_MS);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    void tick();
  });
  // 调用方可能只等 done(比如先取消了):别让没人接的 prompt 拒绝变成 unhandledRejection。
  prompt.catch(() => {});

  return {
    prompt,
    done,
    cancel() {
      settled ??= 'cancelled';
      stop();
    },
  };
}

/** 问工具「还登着吗」。已登录 → true;未登录 → false;问不出 → 抛错(❌ 当成未登录)。 */
export async function readCliLoginStatus(recipe: CliToolRecipe, installed: InstalledCliTool): Promise<boolean> {
  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(installed.binPath, recipe.statusArgs, {
        env: cliToolEnv(recipe, installed),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      // 比资源库查一家连没连上的总时限(connection-statuses.ts,8 秒)短:超时由这里说出是哪个命令没答。
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error(`${recipe.bin} ${recipe.statusArgs.join(' ')} did not answer within ${STATUS_TIMEOUT_MS / 1000} seconds.`));
      }, STATUS_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    }
  );
  try {
    return recipe.parseStatus(stdout);
  } catch (error) {
    throw new Error(
      `${recipe.bin} could not report whether it is logged in (exit ${code}): ${(error as Error).message}\n${outputTail(stderr)}`.trim()
    );
  }
}
