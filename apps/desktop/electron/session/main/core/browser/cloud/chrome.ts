import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * #7199 云电脑上 agent 用的那个 Chrome:咕咕 server 自己拉起、自己收掉,一个账号一个。
 *
 * - 用机器上装好的 Chrome / Chromium(AgentBay `linux_latest` 自带 /usr/bin/google-chrome);没有就照实说,❌ 去下载一个。
 * - 开有界面的:无头模式的 UA 带 `HeadlessChrome`,登录页的风控先拦它。环境给了 DISPLAY 就开在那上面,否则起一块自己的
 *   Xvfb(openDisplay);连 Xvfb 都没有才无头。实时画面走 CDP screencast(live-server.ts),与开在哪块显示上无关。
 * - 资料夹在账号的数据目录里(随云电脑存档走:睡一觉醒来登录还在),缓存放 ~/.cache(存档不收;见 linkCachesOut)。
 * - 调试端口只开在 127.0.0.1、端口由系统给(写进 DevToolsActivePort);桌面经远程隧道看的不是这个端口,
 *   是 live-server.ts 那一个。
 */
export const CHROME_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

export type ChromeFs = Pick<typeof fs, 'existsSync' | 'readdirSync' | 'statSync'>;

function isExecutable(file: string, fsImpl: ChromeFs): boolean {
  try {
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 机器上的 Chrome:`GUGU_CLOUD_BROWSER_CHROME` 指定的(给错了就是错,❌ 再去 PATH 里找),否则按 PATH 找。 */
export function findChrome(env: NodeJS.ProcessEnv, fsImpl: ChromeFs = fs): string | null {
  const pinned = env.GUGU_CLOUD_BROWSER_CHROME?.trim();
  if (pinned) return isExecutable(pinned, fsImpl) ? pinned : null;
  return onPath(CHROME_CANDIDATES, env, fsImpl);
}

function onPath(names: readonly string[], env: NodeJS.ProcessEnv, fsImpl: ChromeFs): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file, fsImpl)) return file;
    }
  }
  return null;
}

export type OwnDisplay = { display: string | null; stop: () => void };

/**
 * Chrome 开在哪块 X 显示上:环境里的 DISPLAY;没有就起一块只给它用的 Xvfb(空号由 Xvfb 自己挑,-nolisten tcp),
 * 跟着这个 Chrome 停(stop);机器上没有 Xvfb = 无头(display null)。❌ 去 /tmp/.X11-unix 里借一块:共用的机器上那是别人的
 * 显示,别人一关 Chrome 跟着断,或者没有它的授权(Lane asks A/B,10-27)。
 */
export async function openDisplay(env: NodeJS.ProcessEnv, fsImpl: ChromeFs = fs, timeoutMs = 10_000): Promise<OwnDisplay> {
  const fromEnv = env.DISPLAY?.trim();
  if (fromEnv) return { display: fromEnv, stop: () => {} };
  const xvfb = onPath(['Xvfb'], env, fsImpl);
  if (!xvfb) return { display: null, stop: () => {} };
  const child = spawn(xvfb, ['-displayfd', '3', '-nolisten', 'tcp', '-screen', '0', `${CHROME_WINDOW.width}x${CHROME_WINDOW.height}x24`], {
    env,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  const number = await new Promise<string>((resolve, reject) => {
    let read = '';
    const timer = setTimeout(() => reject(new Error(`Xvfb did not report its display within ${timeoutMs} ms`)), timeoutMs);
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
      read += chunk.toString();
      if (read.includes('\n')) { clearTimeout(timer); resolve(read.trim()); }
    });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Xvfb exited (${signal ?? code}) before reporting its display`)); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  }).catch((error: unknown) => { stop(); throw error; });
  return { display: `:${number}`, stop };
}

/** 视口按 16:9 设计(1280×720 内容);有界面时窗口外框另加。 */
export const CHROME_WINDOW = { width: 1280, height: 860 };

export function chromeArgs(options: { userDataDir: string; cacheDir: string; headless: boolean; root: boolean }): string[] {
  return [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${options.userDataDir}`,
    `--disk-cache-dir=${options.cacheDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    // 没有钥匙环服务的桌面上,Chrome 存密码 / cookie 时会弹「解锁钥匙环」—— 没人去点。
    '--password-store=basic',
    // agent 的页签不在最前面时也要照常跑定时器、照常出帧(截图、点击才不会卡住)。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter',
    `--window-size=${CHROME_WINDOW.width},${CHROME_WINDOW.height}`,
    ...(options.headless ? ['--headless=new'] : []),
    // root 下 Chrome 不肯开沙箱;普通用户(云电脑是 wuying)保留沙箱。
    ...(options.root ? ['--no-sandbox'] : []),
    'about:blank',
  ];
}

/** `DevToolsActivePort` 的两行:端口 + 浏览器级 websocket 路径。 */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | null {
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !pathLine?.startsWith('/devtools/browser/')) return null;
  return { port, path: pathLine.trim() };
}

/**
 * 睡前存档把资料夹里的 Singleton* 软链一起带走了;醒来换了主机名,Chrome 认它是「别的电脑上正开着这份资料」而拒绝启动。
 * 这份资料只有这里的 Chrome 用,我们自己的还没起 ⇒ 这些锁一定是上一次留下的。
 */
export function clearStaleSingletons(userDataDir: string, fsImpl: Pick<typeof fs, 'rmSync'> = fs): void {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    fsImpl.rmSync(path.join(userDataDir, name), { force: true });
  }
}

/**
 * 资料夹里的纯缓存(相对资料夹)。`--disk-cache-dir` 只挪走网页缓存,这几个 Chrome 没有开关改位置;开着时一直在写,
 * 资料夹随云电脑热存档打包时就打进半截的,也白占包。
 */
export const PROFILE_CACHES = [
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
];

/**
 * 启动前把 PROFILE_CACHES 换成指向缓存目录(存档不收)的软链:存档只带走软链本身。
 * 醒来缓存目录是空的 ⇒ 每次先建好目标;原来是实体目录(老资料夹)或指向别处的软链(家目录换了位置)就换掉 ——
 * 只是缓存,Chrome 会重建。软链写绝对路径:相对路径遇上软链过的上级目录(macOS 的 /var)会差一层、悬空。
 */
export function linkCachesOut(
  userDataDir: string,
  cacheDir: string,
  fsImpl: Pick<typeof fs, 'mkdirSync' | 'lstatSync' | 'readlinkSync' | 'rmSync' | 'symlinkSync'> = fs,
): void {
  for (const rel of PROFILE_CACHES) {
    const link = path.join(userDataDir, rel);
    const target = path.join(cacheDir, 'profile', rel);
    fsImpl.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stat = fsImpl.lstatSync(link, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() && fsImpl.readlinkSync(link) === target) continue;
    if (stat) fsImpl.rmSync(link, { recursive: true, force: true });
    fsImpl.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    fsImpl.symlinkSync(target, link, 'dir');
  }
}

export type LaunchedChrome = { child: ChildProcess; port: number; browserUrl: string; headless: boolean };

export async function launchChrome(options: {
  binary: string;
  userDataDir: string;
  cacheDir: string;
  display: string | null;
  env: NodeJS.ProcessEnv;
  onExit: (reason: string) => void;
  timeoutMs?: number;
}): Promise<LaunchedChrome> {
  fs.mkdirSync(options.userDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 });
  clearStaleSingletons(options.userDataDir);
  linkCachesOut(options.userDataDir, options.cacheDir);
  const activePort = path.join(options.userDataDir, 'DevToolsActivePort');
  fs.rmSync(activePort, { force: true });
  const headless = !options.display;
  const root = typeof process.getuid === 'function' && process.getuid() === 0;
  const env: NodeJS.ProcessEnv = { ...options.env, ...(options.display ? { DISPLAY: options.display } : {}) };
  const child = spawn(options.binary, chromeArgs({ userDataDir: options.userDataDir, cacheDir: options.cacheDir, headless, root }), {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  let exited: string | null = null;
  child.once('exit', (code, signal) => {
    exited = `Chrome exited (${signal ?? code})${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`;
    options.onExit(exited);
  });
  child.once('error', (error) => {
    exited = `Chrome could not start: ${error.message}`;
    options.onExit(exited);
  });
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (exited) throw new Error(exited);
    try {
      const parsed = parseDevToolsActivePort(fs.readFileSync(activePort, 'utf8'));
      if (parsed) return { child, port: parsed.port, browserUrl: `ws://127.0.0.1:${parsed.port}${parsed.path}`, headless };
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill('SIGKILL');
  throw new Error(`Chrome did not open its debugging port within ${options.timeoutMs ?? 20_000} ms${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`);
}
