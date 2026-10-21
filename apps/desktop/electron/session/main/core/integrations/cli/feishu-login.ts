import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { cliToolEnv, startCliLogin, type CliLoginOutcome, type CliLoginRun } from './cli-login';
import type { InstalledCliTool } from './cli-tool-installer';
import type { CliLoginPrompt } from './cli-tools';
import { feishuCliRecipe, parseFeishuStatus } from './feishu-cli';

const execFileAsync = promisify(execFile);

/** Exit 3 也可能是「用户已登录，但没有授予所有推荐权限」，不能只看退出码。 */
export function feishuAuthorizationCompleted(output: string): boolean {
  return output.split('\n').some((line) => {
    try {
      const event = JSON.parse(line) as { event?: unknown; user_open_id?: unknown; warning?: { type?: unknown } } | null;
      return event?.event === 'authorization_complete' && typeof event.user_open_id === 'string' &&
        event.user_open_id.length > 0 && event.warning?.type === 'missing_scope';
    } catch { return false; }
  });
}

/** 只识别官方的应用配置页和结构化授权事件，不从输出里随便抓一个链接。 */
export function feishuVerificationUrl(output: string, stage: 'configure' | 'authorize'): string | null {
  if (stage === 'configure') {
    return output.match(/https:\/\/open\.feishu\.cn\/page\/cli\?[^\s]+/)?.[0] ?? null;
  }
  for (const line of output.split('\n')) {
    try {
      const event = JSON.parse(line) as { event?: unknown; verification_uri_complete?: unknown } | null;
      if (!event) continue;
      if (event.event !== 'device_authorization' || typeof event.verification_uri_complete !== 'string') continue;
      const url = new URL(event.verification_uri_complete);
      if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname)) {
        throw new Error('lark-cli returned an unexpected authorization host.');
      }
      return event.verification_uri_complete;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // 日志和没有收齐的一行 JSON 继续等。
    }
  }
  return null;
}

/** 两步都由官方 CLI 自己轮询；云端宿主也无需打开浏览器或接本地回跳。 */
export function startFeishuLogin(installed: InstalledCliTool, work: string): CliLoginRun {
  const controller = new AbortController();
  let active: CliLoginRun | undefined;
  let cancelled = false;
  let currentPrompt: CliLoginPrompt | undefined;
  let resolvePrompt!: (prompt: CliLoginPrompt) => void;
  let rejectPrompt!: (error: Error) => void;
  const prompt = new Promise<CliLoginPrompt>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  prompt.catch(() => {});

  const step = async (stage: 'configure' | 'authorize'): Promise<CliLoginOutcome> => {
    if (cancelled) return { kind: 'cancelled', output: '' };
    const run = startCliLogin(feishuCliRecipe, installed, work, {
      args: stage === 'configure'
        ? ['config', 'init', '--new', '--brand', 'feishu', '--lang', 'zh']
        : feishuCliRecipe.loginArgs(work),
      parsePrompt: async (output) => {
        const url = feishuVerificationUrl(output, stage);
        if (!url) return null;
        const file = `${stage}.png`;
        await execFileAsync(installed.binPath, ['auth', 'qrcode', url, '--output', file], {
          cwd: work, env: cliToolEnv(feishuCliRecipe, installed), timeout: 10_000, signal: controller.signal,
        });
        const image = `data:image/png;base64,${(await fs.readFile(path.join(work, file))).toString('base64')}`;
        return { kind: 'qr-code', image, url };
      },
    });
    active = run;
    try {
      const next = await run.prompt;
      if (cancelled) return { kind: 'cancelled', output: '' };
      currentPrompt = next;
      resolvePrompt(next);
      return await run.done;
    } catch (error) {
      run.cancel();
      await run.done;
      throw error;
    }
  };

  const done: Promise<CliLoginOutcome> = (async () => {
    try {
      const config = path.join(installed.homeDir, 'config', 'config.json');
      if (!existsSync(config)) {
        const outcome = await step('configure');
        if (outcome.kind !== 'exited' || outcome.code !== 0) return outcome;
      }
      const outcome = await step('authorize');
      if (outcome.kind !== 'exited' || cancelled) return outcome;
      if (outcome.code !== 0 && !(outcome.code === 3 && feishuAuthorizationCompleted(outcome.output))) return outcome;
      // 默认使用用户身份，避免个人授权失效后自动切成机器人并读到一份空数据。
      await setFeishuUserIdentity(installed, controller.signal);
      // 最终连接仍由宿主的 --verify 向服务端核实。未授予的能力由 CLI 按实际 scope 拒绝。
      return { ...outcome, code: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejectPrompt(new Error(message));
      return cancelled ? { kind: 'cancelled', output: '' } : { kind: 'exited', code: 1, output: message };
    }
  })();
  return {
    prompt,
    done,
    get currentPrompt() { return currentPrompt; },
    cancel() { cancelled = true; active?.cancel(); controller.abort(); },
  };
}

export async function setFeishuUserIdentity(installed: InstalledCliTool, signal?: AbortSignal): Promise<void> {
  await execFileAsync(installed.binPath, ['config', 'default-as', 'user'], {
    env: cliToolEnv(feishuCliRecipe, installed), timeout: 10_000, signal,
  });
}

/** 登录后真向飞书验证用户令牌；日常列表查询仍走本地状态，避免每次打开界面都请求远端。 */
export async function verifyFeishuLogin(installed: InstalledCliTool): Promise<boolean> {
  const { stdout } = await execFileAsync(installed.binPath, ['auth', 'status', '--json', '--verify'], {
    env: cliToolEnv(feishuCliRecipe, installed), timeout: 30_000,
  });
  return parseFeishuStatus(stdout) && (JSON.parse(stdout) as { verified?: unknown }).verified === true;
}
