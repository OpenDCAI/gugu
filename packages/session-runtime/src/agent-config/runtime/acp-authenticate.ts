import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { defaultEngineTreeOps, signalEngineTree } from '@gugu/session-core/acp/node';
import { spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec';
import type { AuthLoginOutcome } from '@gugu/session-core/workspace-server';

/**
 * 协议登录 —— 起 harness 的 ACP 进程,发 `initialize` 再发 `authenticate {methodId}`,等它返回。
 *
 * ## 为什么是这个形状(#6335)
 *
 * ACP 规范里没有 `type` 的 authMethod 是 **agent 型**:客户端只管发 `authenticate`,登录由 agent 自己完成。
 * antigravity 的 `agy_acp_server` 1.1.1 实测(2026-09-23):`authenticate {methodId:'oauth-personal'}`
 * 在 stderr 打出「Open the following link to authenticate the ACP server: https://accounts.google.com/…」,
 * 拉起 `$BROWSER`,**阻塞到**本地回调 `127.0.0.1:<port>` 收到授权码才回包;
 * `authenticate {methodId:'gemini-api-key'}` 12ms 回 `{}`,并把 `auth.type` 写进
 * `$GEMINI_HOME/antigravity-acp/settings.json`。
 *
 * ⚠️ stdin 必须一直开着:实测 EOF 之后它打「Shutting down AGY ACP Server...」,挂着的 authenticate
 *    即使等到回调也**不再回包**。所以这里从不 `stdin.end()`,结束一律靠杀进程组。
 *
 * ⚠️ 进程组必须收干净:这类服务是**孙**进程形态(`agy_acp_server` 自己再起 `localharness_external`),
 *    只杀根会留孤儿、还占着那个回调端口。与模型目录探针同一套 `signalEngineTree`。
 */
export type AcpAuthenticateSpawn = {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
};

export type AcpAuthenticateOptions = {
  spawn: AcpAuthenticateSpawn;
  methodId: string;
  /** 用户关窗 / 换一次登录 = abort ⇒ 结局 `cancelled`。 */
  signal: AbortSignal;
  /**
   * 整趟上限。OAuth 要等人在浏览器里点完,所以给得宽;它防的是「浏览器那一侧再也不回来」时
   * 进程与回调端口被无限期占着。
   */
  timeoutMs?: number;
  /** stderr/stdout 里第一次出现的 https 链接 —— 备用的「浏览器没打开就点这里」。 */
  onUrl?: (url: string) => void;
};

export const ACP_AUTHENTICATE_TIMEOUT_MS = 10 * 60_000;

/** 协议版本与模型目录探针发的一致(ACP v1)。 */
const PROTOCOL_VERSION = 1;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/i;

type RpcResponse = { id?: unknown; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

export async function runAcpAuthenticate(options: AcpAuthenticateOptions): Promise<AuthLoginOutcome> {
  if (options.signal.aborted) return { kind: 'cancelled' };
  let owned: OwnedChild<ChildProcessWithoutNullStreams> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  try {
    owned = spawnOwnedChild(options.spawn.command, options.spawn.args, {
      cwd: options.spawn.cwd,
      // ❌ 不铺 `...process.env`:宿主 `buildAcpSpawn` 给的就是这家真会话会拿到的那份(含回环 NO_PROXY),
      // 而且**不带** `BROWSER` 屏蔽 —— 这是用户亲手点的登录,浏览器就该弹出来。
      env: options.spawn.env,
      stdio: 'pipe',
      detached: true,
      // spawn 的 'error' 由下面的 `ended` 变成这次登录的结论;收树失败由 finally 的 stop() 报出。
      onError: () => {},
    });
    const proc = owned.child;
    proc.stdin.on('error', () => {});
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});

    let urlSeen = false;
    const scanForUrl = (chunk: string) => {
      if (urlSeen || !options.onUrl) return;
      const match = URL_PATTERN.exec(chunk);
      if (!match) return;
      urlSeen = true;
      options.onUrl(match[0].replace(/[),.;\]]+$/u, ''));
    };
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', scanForUrl);

    const pending = new Map<number, (response: RpcResponse) => void>();
    let buffered = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let index: number;
      while ((index = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (!line) continue;
        let message: RpcResponse & { method?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          // 非 JSON 的 stdout(有的服务把日志也打在这里):照样扫链接,不当协议消息。
          scanForUrl(line);
          continue;
        }
        if (typeof message.method === 'string') {
          // 登录链接走协议通知送来的那种(CodeBuddy:`_codebuddy.ai/authUrl {authUrl, provider}`,
          // 发行包 2.169.0 的 `setupUrlSubjectSubscription`):它只把链接写进自己的日志,stderr / stdout
          // 一个字都没有,不收这一路,远程机器上(没有浏览器)这家就登不上。认的是字段,❌ 不认方法名。
          const authUrl = (message as { params?: { authUrl?: unknown } }).params?.authUrl;
          if (message.id === undefined && typeof authUrl === 'string') scanForUrl(authUrl);
          // agent 发来的请求(登录期间不该有):按 JSON-RPC 回「不支持」,别让它挂着等。
          if (message.id !== undefined) {
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not supported during login' } })}\n`);
          }
          continue;
        }
        if (typeof message.id === 'number') {
          const resolve = pending.get(message.id);
          pending.delete(message.id);
          resolve?.(message);
        }
      }
    });

    let nextId = 0;
    const request = (method: string, params: unknown) =>
      new Promise<RpcResponse>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    const ended = new Promise<AuthLoginOutcome>((resolve) => {
      proc.once('error', (error: NodeJS.ErrnoException) => {
        resolve({ kind: 'failed', message: `无法启动登录进程:${error.message}` });
      });
      proc.once('exit', (code, sig) => {
        resolve({ kind: 'failed', message: `登录进程在完成前退出(code=${code} signal=${sig})` });
      });
    });
    const cancelled = new Promise<AuthLoginOutcome>((resolve) => {
      onAbort = () => resolve({ kind: 'cancelled' });
      options.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timedOut = new Promise<AuthLoginOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ kind: 'failed', message: '登录超时:浏览器那一侧一直没有完成授权。' }),
        options.timeoutMs ?? ACP_AUTHENTICATE_TIMEOUT_MS
      );
    });

    const handshake = (async (): Promise<AuthLoginOutcome> => {
      const init = await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'gugu', version: '1' },
      });
      if (init.error) return { kind: 'failed', message: rpcErrorMessage('initialize', init.error) };
      const auth = await request('authenticate', { methodId: options.methodId });
      if (auth.error) return { kind: 'failed', message: rpcErrorMessage('authenticate', auth.error) };
      return { kind: 'succeeded' };
    })();

    return await Promise.race([handshake, ended, cancelled, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) options.signal.removeEventListener('abort', onAbort);
    if (owned) {
      // 孙进程(agy_acp_server 再起的 localharness_external)可能还占着回调端口:整树收掉并等它停下。
      signalEngineTree(owned, 'SIGKILL', defaultEngineTreeOps());
      await owned.stop();
    }
  }
}

function rpcErrorMessage(method: string, error: NonNullable<RpcResponse['error']>): string {
  const detail = (error.data as { message?: unknown } | undefined)?.message;
  const base = error.message ?? `code ${error.code ?? 'unknown'}`;
  return typeof detail === 'string' && detail && detail !== base
    ? `${method}: ${base} — ${detail}`
    : `${method}: ${base}`;
}
