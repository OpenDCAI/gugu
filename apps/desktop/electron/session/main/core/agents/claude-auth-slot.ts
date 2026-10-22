import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import type { ClaudeCredentialLocation, ClaudeCredentialStore } from './claude-credential-store';

/**
 * Claude 订阅切换照 Codex(`codex-auth-slot.ts`)和 cockpit-tools 的做法(#26):会话永远跑在用户自己的配置根
 * (`~/.claude` 或用户导出的 `CLAUDE_CONFIG_DIR`),切换默认订阅 = 把那个账号的登录凭据换进这个根,
 * ❌ 不再给每个账号另起一个空的配置根。
 *
 * 每个 OAuth 账号同一时刻只有**一份**权威凭据:正在用的那个在用户根里(CLI 会原地刷新、轮换 refresh token),
 * 其余的在各自的保管目录 `<连接 home>/.claude`(凭据放那个根对应的钥匙串条目或 `.credentials.json`)。
 * 换出时先把用户根里那份(已轮换过的)写回它的主人,再换入新的 —— 否则主人手里那份 refresh token 已经作废,
 * 下次换回来就得重新登录。写回前比 `expiresAt`:用户根里那份比保管目录里的还旧,说明保管目录那份是后来被刷新过的,
 * 这时写回等于拿作废的 token 盖掉有效的。
 *
 * 凭据文本里属于账号的只有 `claudeAiOauth` 这一个键,同一份文本里还可能放别的东西(例如 MCP 服务器的登录)。
 * 换账号只换这一个键,其余原样留在用户根里,❌ 整段文本互换。
 * `.claude.json` 同理,只动属于账号的两格(`oauthAccount`、`hasCompletedOnboarding`)。
 *
 * 「用户根里此刻是谁」由调用方告知它认为选中的连接,再用 `.claude.json` 的 `oauthAccount.accountUuid` 校验;
 * 校验不上(用户在终端里自己 `claude login` 过)才按身份在所有连接里找,找不到就当未知账号,换出前另存副本。
 *
 * 和 CLI 拿同样的锁(bundled CLI 源码里看到的,claude-agent-sdk 0.3.293;对真 CLI 实测过它会等):
 * - 换凭据期间拿着用户根与目标保管目录的刷新锁:CLI 要刷新 token 时会一直等到我们放锁,
 *   不会在中途把旧账号刷新出来的新 token 写回来、盖掉换进去的账号。
 * - 改 `.claude.json` 时拿着它的锁:CLI 写这个文件时会等一会儿(约 1.5 秒),等不到就重读文件、在最新内容上改它那一处。
 *   我们只在「读 → 改 → 写」那几毫秒里拿着,它总能等到。
 * 在终端里开着的 `claude` 也守这两把锁。
 */

export type ClaudeAuthSlotPaths = {
  /** 用户自己的 Claude 配置根,会话就跑在这里。 */
  nativeRoot: string;
  /** 用户根的 `.claude.json`:没导出 `CLAUDE_CONFIG_DIR` 时在 home 下,导出了就在那个根里。 */
  nativeGlobalConfig: string;
  /** 用户导出了 `CLAUDE_CONFIG_DIR` ⇒ 用户根的钥匙串条目带哈希后缀。 */
  nativeSuffixed: boolean;
  /** 连接的保管目录(`native` 也有一份:第一次换出时把用户原来那个账号存进去)。 */
  vaultRoot(connectionId: string): string;
  /** 用户根里出现了谁都不认识的账号时,换出前留一份副本在这里。 */
  backupDir: string;
  store: ClaudeCredentialStore;
  /** 锁被 CLI 拿着时重试几次(缺省约等十几秒);测试传 0。 */
  lockRetries?: number;
};

const NATIVE = 'native';
const GLOBAL_CONFIG = '.claude.json';
const ACCOUNT_KEYS = ['oauthAccount', 'hasCompletedOnboarding'] as const;

type Account = { identity: string; fields: Record<string, unknown> };
type Json = Record<string, unknown>;

const native = (paths: ClaudeAuthSlotPaths): ClaudeCredentialLocation => ({ root: paths.nativeRoot, suffixed: paths.nativeSuffixed });
const vault = (paths: ClaudeAuthSlotPaths, id: string): ClaudeCredentialLocation => ({ root: paths.vaultRoot(id), suffixed: true });
const vaultConfig = (paths: ClaudeAuthSlotPaths, id: string): string => join(paths.vaultRoot(id), GLOBAL_CONFIG);

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

async function readJson(path: string): Promise<Json | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    throw new Error(`Cannot read ${path}; Claude subscriptions were not switched`);
  }
}

/** 账号身份:`oauthAccount.accountUuid`。 */
export function claudeAccountIdentity(config: Json | null): string | null {
  const account = config?.oauthAccount;
  if (!isObject(account)) return null;
  const uuid = account.accountUuid;
  return typeof uuid === 'string' && uuid ? uuid : null;
}

async function readAccount(path: string): Promise<Account | null> {
  const config = await readJson(path);
  const identity = claudeAccountIdentity(config);
  if (!config || !identity) return null;
  const fields: Json = {};
  for (const key of ACCOUNT_KEYS) if (key in config) fields[key] = config[key];
  return { identity, fields };
}

const DEFAULT_LOCK_RETRIES = 30;
const retryOptions = (retries: number) => ({ retries, minTimeout: 100, maxTimeout: 500 });
/** 锁的维护定时器出错时别把主进程带走(proper-lockfile 缺省是直接抛)。换一次凭据不到一秒,用不着它。 */
const ignoreCompromise = () => undefined;

function lockBusy(error: unknown): Error {
  if ((error as { code?: unknown })?.code === 'ELOCKED') {
    return new Error('Claude is updating its sign-in right now; try switching again in a moment');
  }
  return error as Error;
}

/**
 * 拿 CLI 也拿的那一把(锁就是 `lockfilePath` 这个目录,两边 mkdir 同一个路径互斥)。
 * proper-lockfile 在进程内按第一个参数记账,所以第一个参数也传锁目录本身:同一个根上的两把锁
 * 若都按根记,后拿的会盖掉先拿的那条账,先拿的那把就再也放不掉,下一次切换被自己留下的锁挡住。
 */
async function lockLikeClaude(lockfilePath: string, retries: number, timing: { stale: number; update: number }): Promise<() => Promise<void>> {
  const release = await lockfile
    .lock(lockfilePath, { realpath: false, lockfilePath, ...timing, retries: retryOptions(retries), onCompromised: ignoreCompromise })
    .catch((error: unknown) => {
      throw lockBusy(error);
    });
  return () => release().catch(() => undefined);
}

/**
 * CLI 刷新 token 时拿的两把锁:`<根>/.oauth_refresh.lock`,以及老版本用的 `<根的真实路径>.lock`;
 * 时长与 CLI 一致(stale 60s、update 5s),同一把锁两边的 stale 不一致会互相判成过期。
 */
async function lockRefresh(root: string, retries: number): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const timing = { stale: 60_000, update: 5_000 };
  const releaseCurrent = await lockLikeClaude(join(root, '.oauth_refresh.lock'), retries, timing);
  try {
    const releaseLegacy = await lockLikeClaude(`${await realpath(root).catch(() => root)}.lock`, retries, timing);
    return async () => {
      await releaseLegacy();
      await releaseCurrent();
    };
  } catch (error) {
    await releaseCurrent();
    throw error;
  }
}

/** 只改账号那两格,其余原样;在 CLI 同一把锁(`<文件>.lock`)里重读再写,先写临时文件再改名。 */
async function mergeAccount(path: string, fields: Json, retries: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const release = await lockLikeClaude(`${path}.lock`, retries, { stale: 10_000, update: 5_000 });
  try {
    const config = (await readJson(path)) ?? {};
    for (const key of ACCOUNT_KEYS) {
      if (key in fields) config[key] = fields[key];
    }
    const temporary = `${path}.gugu-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  } finally {
    await release();
  }
}

function parseCredential(text: string | null): Json | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** 一份凭据文本里的账号登录(`claudeAiOauth`),没有或读不出来 = null。 */
function oauthOf(text: string | null): Json | null {
  const oauth = parseCredential(text)?.claudeAiOauth;
  return isObject(oauth) ? oauth : null;
}

/** 在 `base` 的基础上换上 `oauth`,`base` 里别的键原样保留;`base` 读不出来就只放这一个键。 */
function withOauth(base: string | null, oauth: Json): string {
  return JSON.stringify({ ...(parseCredential(base) ?? {}), claudeAiOauth: oauth });
}

/** `live` 严格早于 `saved` 过期 ⇒ 保管目录那份是后来被刷新过的,用户根里这份是作废的旧 token。读不出过期时间就当不旧。 */
function isStale(live: Json, saved: Json | null): boolean {
  const liveExpiry = live.expiresAt;
  const savedExpiry = saved?.expiresAt;
  return typeof liveExpiry === 'number' && typeof savedExpiry === 'number' && liveExpiry < savedExpiry;
}

/**
 * 用户根里此刻是哪个连接的账号。`selectedId` = 调用方认为当前选中的连接。
 *
 * 1. 选中的是账号连接,且它保管目录里的账号和用户根里的一致 ⇒ 就是它。
 * 2. `native` 还没有保管的账号 = 还没换出过,用户根里的(含用户在终端里登录的未知账号)就是它。
 *    ❌ 不能放在 1 之前:新用户原生没登录、先加了账号 A,这时用户根里是 A,若判成 native,
 *    换出时 A 轮换过的 token 会被存到 native 名下,A 自己那份保持作废。
 * 3. 否则按身份在所有连接里找;找不到 = 未知账号(null)。
 */
export async function claudeLiveOwner(
  paths: ClaudeAuthSlotPaths,
  connectionIds: readonly string[],
  selectedId: string | null
): Promise<string | null> {
  const live = await readAccount(paths.nativeGlobalConfig);
  if (selectedId && selectedId !== NATIVE && live) {
    if ((await readAccount(vaultConfig(paths, selectedId)))?.identity === live.identity) return selectedId;
  }
  const nativeSaved = await readAccount(vaultConfig(paths, NATIVE));
  if (!nativeSaved) return NATIVE;
  if (!live) return null;
  if (nativeSaved.identity === live.identity) return NATIVE;
  for (const id of connectionIds) {
    if (id !== NATIVE && (await readAccount(vaultConfig(paths, id)))?.identity === live.identity) return id;
  }
  return null;
}

/** 读某个连接的登录态该去哪个根:它的账号此刻在用户根里就读用户根(那份才是最新的),否则读它的保管目录。 */
export async function claudeCredentialRoot(
  paths: ClaudeAuthSlotPaths,
  connectionIds: readonly string[],
  connectionId: string,
  selectedId: string | null
): Promise<'native' | 'vault'> {
  return (await claudeLiveOwner(paths, connectionIds, selectedId)) === connectionId ? 'native' : 'vault';
}

/**
 * 把用户根换成 `targetId` 的账号。`connectionIds` = 全部 OAuth 连接(含 `native`),`currentId` = 换之前选中的连接。
 * 返回换之前用户根属于谁(`null` = 不认识的账号,已另存副本)。
 */
export async function activateClaudeAccount(
  paths: ClaudeAuthSlotPaths,
  connectionIds: readonly string[],
  targetId: string,
  currentId: string | null,
  now: () => Date = () => new Date()
): Promise<string | null> {
  const owner = await claudeLiveOwner(paths, connectionIds, currentId);
  // 已经在用户根里(含「用户从没登录过,原生连接就是空的」):什么都不用搬。
  if (owner === targetId) return owner;
  const retries = paths.lockRetries ?? DEFAULT_LOCK_RETRIES;
  // 先用户根、再目标保管目录:CLI 一次只拿一个根的锁,固定这个顺序不会和它互等。
  const releaseNative = await lockRefresh(paths.nativeRoot, retries);
  try {
    const releaseTarget = await lockRefresh(paths.vaultRoot(targetId), retries);
    try {
      return await swapUnderLock(paths, connectionIds, targetId, currentId, retries, now);
    } finally {
      await releaseTarget();
    }
  } finally {
    await releaseNative();
  }
}

async function swapUnderLock(
  paths: ClaudeAuthSlotPaths,
  connectionIds: readonly string[],
  targetId: string,
  currentId: string | null,
  retries: number,
  now: () => Date
): Promise<string | null> {
  // 拿到锁之后重新认一次:等锁期间 CLI 可能刚刷新完、或用户刚在终端里换了登录。
  const owner = await claudeLiveOwner(paths, connectionIds, currentId);
  if (owner === targetId) return owner;
  const incomingOauth = oauthOf(await paths.store.read(vault(paths, targetId)));
  const incomingAccount = await readAccount(vaultConfig(paths, targetId));
  if (!incomingOauth || !incomingAccount) {
    throw new Error('The selected Claude account has no saved sign-in; sign in to it again');
  }
  const liveText = await paths.store.read(native(paths));
  const liveOauth = oauthOf(liveText);
  const liveAccount = await readAccount(paths.nativeGlobalConfig);
  if (liveText !== null) {
    if (owner) {
      const saved = await paths.store.read(vault(paths, owner));
      if (liveOauth && !isStale(liveOauth, oauthOf(saved))) {
        await paths.store.write(vault(paths, owner), withOauth(saved, liveOauth));
        if (liveAccount) await mergeAccount(vaultConfig(paths, owner), liveAccount.fields, retries);
      }
    } else {
      await mkdir(paths.backupDir, { recursive: true, mode: 0o700 });
      const stamp = now().toISOString().replace(/[:.]/g, '-');
      await writeFile(
        join(paths.backupDir, `credentials-${stamp}.json`),
        JSON.stringify({ credentials: liveText, account: liveAccount?.fields ?? null }),
        { mode: 0o600 }
      );
    }
  }
  await paths.store.write(native(paths), withOauth(liveText, incomingOauth));
  try {
    await mergeAccount(paths.nativeGlobalConfig, incomingAccount.fields, retries);
  } catch (error) {
    // 凭据与账号信息要一起换:后一步没成,把凭据放回去,❌ 留一个「凭据是 B、账号信息是 A」的半截状态。
    if (liveText !== null) await paths.store.write(native(paths), liveText).catch(() => undefined);
    throw error;
  }
  return owner;
}

/** 保管目录要存在(`claude auth login` 以它为配置根;凭据落钥匙串条目或其下的 `.credentials.json`)。 */
export async function ensureClaudeVault(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
}
