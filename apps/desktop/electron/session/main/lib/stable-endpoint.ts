/**
 * #6264 长寿进程手里的回环端点,跨宿主进程重启不变。
 *
 * 编程会话跑在 tmux 里,agent 进程活得比启动它的宿主进程(server 的账号进程、桌面主进程)久:升级、看门人重启、
 * 回滚、崩溃之后,它手里那几个地址 —— 咕咕 MCP、钩子、集成转发口、平台模型转发口 —— 的端口和令牌都是上一个宿主的。
 * 以前每个宿主都 `listen(0)` + 随机令牌,换一个进程就全变:agent 报「咕咕插件刚才断开了(连接被拒绝)」,钩子全被拒。
 *
 * 照 VS Code 的做法:它让持久终端里的 `code` CLI 认 `VSCODE_IPC_HOOK_CLI` 指的那个固定地址,新起的 server 在同一个
 * 地址重新监听;这里对应的是 ——
 *  · 端口:按名字记在数据目录里(0600),新进程**先绑回同一个端口**再接请求;被别的程序占了才另挑一个,响亮记一笔;
 *  · 令牌:发出去的那些同样落盘(0600),新进程把它们原样认回来,❌ 重新随机。
 * 数据目录本身 0700、只归这个账号(server-permissions.ts),令牌与登录态同一个待遇。
 */
import fs from 'node:fs';
import http from 'node:http';
import type { Server } from 'node:net';
import path from 'node:path';

export type EndpointLog = {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
};

/** 数据目录里的一份小 JSON(0600,先写临时文件再改名)。读坏了当作没有。 */
export class PrivateJsonFile<T> {
  constructor(readonly file: string) {}

  read(): T | null {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  /** 写不进(磁盘满)返回 false:调用方照常工作,只是这一份下次重启认不回来。 */
  write(value: T): boolean {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      fs.rmSync(tmp, { force: true });
      return false;
    }
  }
}

export const ENDPOINTS_FILE = 'endpoints.json';

type EndpointRecord = { ports?: Record<string, number> };

/** 按名字记端口的那一份(`<数据目录>/endpoints.json`)。 */
export class EndpointPorts {
  private readonly store: PrivateJsonFile<EndpointRecord>;
  constructor(dataDir: string) {
    this.store = new PrivateJsonFile(path.join(dataDir, ENDPOINTS_FILE));
  }

  get(name: string): number | null {
    const port = this.store.read()?.ports?.[name];
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  }

  set(name: string, port: number): void {
    const current = this.store.read() ?? {};
    if (current.ports?.[name] === port) return;
    this.store.write({ ...current, ports: { ...(current.ports ?? {}), [name]: port } });
  }
}

const listenOnce = (server: Server, port: number, host: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

/**
 * 摩擦单 F45 一个 agent 反复来调的 HTTP 端点(咕咕 MCP、平台模型转发口):闲着的连接由客户端关,❌ 由宿主关。
 * Node 默认闲 5 s(另加 1 s 余量)就由宿主关掉;Codex 的连接池(reqwest/hyper)不认 `Keep-Alive: timeout`、闲到 90 s
 * 才弃 —— 隔 6 s 左右的下一次调用正好写进宿主刚关、FIN 还在路上的连接,报「Transport send error … error sending
 * request」(L6 两次,都在上一次调用之后 5–6 s)。回环上闲连接几乎不花什么;谁复用连接谁决定它何时关,复用和关闭就撞不上。
 */
export function agentEndpointServer(listener: http.RequestListener): http.Server {
  const server = http.createServer(listener);
  server.keepAliveTimeout = 0;
  return server;
}

export type ListenStableOptions = {
  name: string;
  ports: EndpointPorts | null;
  log: EndpointLog;
  host?: string;
  /** 上一个宿主可能还在退出途中、端口没放:重试几次再放弃(默认 5 次 × 400ms)。 */
  retries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * 绑回记下的那个端口;没记过就随便挑一个并记下。那个端口被别的程序占着(重试后仍然 EADDRINUSE)时另挑一个,
 * 响亮记一笔 —— 重启前起的 agent 从此连不上这一项,要重新打开那条会话。返回实际端口与是否绑回了原端口。
 */
export async function listenStable(server: Server, options: ListenStableOptions): Promise<{ port: number; reused: boolean }> {
  const host = options.host ?? '127.0.0.1';
  const wanted = options.ports?.get(options.name) ?? null;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (wanted !== null) {
    const retries = options.retries ?? 5;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await listenOnce(server, wanted, host);
        return { port: wanted, reused: true };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE' || attempt >= retries) {
          options.log.warn(`${options.name}: 端口 ${wanted} 绑不回来,换一个;重启前起的会话连不上它,重新打开那条会话即可`, {
            port: wanted,
            code: code ?? String(error),
          });
          break;
        }
        await sleep(options.retryDelayMs ?? 400);
      }
    }
  }
  await listenOnce(server, 0, host);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error(`${options.name} did not bind TCP`);
  options.ports?.set(options.name, address.port);
  return { port: address.port, reused: false };
}

/** 一批按名字存的令牌记录:发出去就落盘,正式收回(会话真结束)才删;宿主正常退出 ❌ 删。 */
export class PersistedRecords<T extends { key: string }> {
  private readonly store: PrivateJsonFile<{ records?: T[] }>;
  constructor(file: string, private readonly limit = 500) {
    this.store = new PrivateJsonFile(file);
  }

  list(): T[] {
    const records = this.store.read()?.records;
    return Array.isArray(records) ? records.filter((record) => record && typeof record.key === 'string') : [];
  }

  /** 覆盖同 key 的那一条;超过上限丢最旧的(没人再来认领的会话不能让这份文件无限长)。 */
  put(record: T): void {
    const rest = this.list().filter((existing) => existing.key !== record.key);
    this.store.write({ records: [...rest, record].slice(-this.limit) });
  }

  remove(key: string): void {
    const list = this.list();
    const rest = list.filter((existing) => existing.key !== key);
    if (rest.length !== list.length) this.store.write({ records: rest });
  }
}
