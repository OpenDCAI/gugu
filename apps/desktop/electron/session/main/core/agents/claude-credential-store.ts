import { createHash } from 'node:crypto';
import { execFile, spawn } from '@gugu/core/local/childProcess';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * Claude Code 的登录凭据存在哪(官方文档 authentication / troubleshoot-install):
 * macOS 存登录钥匙串,钥匙串写不进去时退回 `<配置根>/.credentials.json`;没有钥匙串的平台只有那个文件。
 *
 * 钥匙串条目的服务名是 `Claude Code-credentials`;配置根不是缺省位置(设了 `CLAUDE_CONFIG_DIR`)时
 * 后面接 `-<配置根路径 sha256 的前 8 位>`(本机实测:连接目录算出来的哈希与它的条目名一致)。
 * 条目的访问控制只信任 `/usr/bin/security`(CLI 自己就是这么读写的),所以这里同样走它,❌ 不另起钥匙串 API ——
 * 那样每次读写都会弹系统授权框。
 *
 * 这一层只搬**整段凭据文本**,不解析里面的 token。
 */

export type ClaudeCredentialLocation = {
  /** 这份凭据所属的配置根。 */
  root: string;
  /** 这个根在 CLI 眼里是不是「设了 `CLAUDE_CONFIG_DIR`」—— 是 ⇒ 钥匙串服务名带哈希后缀。连接保管目录恒为 true。 */
  suffixed: boolean;
};

export type ClaudeCredentialStore = {
  read(location: ClaudeCredentialLocation): Promise<string | null>;
  write(location: ClaudeCredentialLocation, text: string): Promise<void>;
};

const SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = '.credentials.json';
const SECURITY = '/usr/bin/security';
/** `security` 的「没有这一项」退出码(errSecItemNotFound)。 */
const NOT_FOUND = 44;
/** 钥匙串被锁时 `security` 会等人去点解锁框;不设上限就把整次切换(和状态读取)挂死。 */
const SECURITY_TIMEOUT_MS = 10_000;
/**
 * `security -i` 一行读不了太长:超出的部分被截掉,写进去的是半份凭据,命令却照样报成功(实测 2KB 的 JSON 即如此)。
 * CLI 自己(2.1.293)也是整条命令不超过这个长度才走 stdin,超了改走参数 —— 照它。
 */
const SECURITY_STDIN_LIMIT = 4032;

export function claudeKeychainService(location: ClaudeCredentialLocation): string {
  return location.suffixed
    ? `${SERVICE}-${createHash('sha256').update(location.root).digest('hex').slice(0, 8)}`
    : SERVICE;
}

export type SecurityRunner = {
  /** 读:退出码 0 返回 stdout;`NOT_FOUND` 返回 null;其余抛。 */
  find(args: string[]): Promise<string | null>;
  /** 写:把命令行喂给 `security -i` 的 stdin(❌ 不放进 argv,免得凭据出现在进程列表里)。 */
  interactive(command: string): Promise<void>;
  /** 写:命令太长、stdin 装不下时才用,凭据会短暂出现在本机进程列表里(CLI 同样如此)。 */
  run(args: string[]): Promise<void>;
};

function realSecurity(): SecurityRunner {
  return {
    find: (args) =>
      new Promise((resolve, reject) => {
        execFile(SECURITY, args, { maxBuffer: 4 * 1024 * 1024, timeout: SECURITY_TIMEOUT_MS }, (error, stdout) => {
          if (!error) return resolve(stdout);
          const { code, killed } = error as { code?: unknown; killed?: boolean };
          if (code === NOT_FOUND) return resolve(null);
          reject(new Error(killed ? `security ${args[0]} timed out` : `security ${args[0]} failed (${String(code)})`));
        });
      }),
    interactive: (command) =>
      new Promise((resolve, reject) => {
        const child = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('security write timed out'));
        }, SECURITY_TIMEOUT_MS);
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          // `security -i` 对命令失败也可能返回 0,错误只在 stderr 里。
          if (code === 0 && !stderr.trim()) return resolve();
          reject(new Error(`security write failed (${String(code)})`));
        });
        child.stdin.end(`${command}\n`);
      }),
    run: (args) =>
      new Promise((resolve, reject) => {
        execFile(SECURITY, args, { timeout: SECURITY_TIMEOUT_MS }, (error) => {
          if (!error) return resolve();
          const { code, killed } = error as { code?: unknown; killed?: boolean };
          reject(new Error(killed ? `security ${args[0]} timed out` : `security ${args[0]} failed (${String(code)})`));
        });
      }),
  };
}

function quote(value: string): string {
  if (/["\\\n\r]/.test(value)) throw new Error('Unsupported character in keychain argument');
  return `"${value}"`;
}

/** `security -w` 遇到不可打印内容会改成十六进制输出;凭据本身是单行 JSON,所以能还原就还原。 */
function decodeSecret(output: string): string {
  const text = output.replace(/\r?\n$/, '');
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0 && !text.startsWith('{')) {
    try {
      const decoded = Buffer.from(text, 'hex').toString('utf8');
      if (decoded.trimStart().startsWith('{')) return decoded;
    } catch {
      // 不是十六进制就按原文。
    }
  }
  return text;
}

async function readFileCredential(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, CREDENTIALS_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** 先写临时文件再改名:写到一半崩了,留下的要么是旧凭据、要么是新凭据,❌ 半个文件。 */
async function writeFileCredential(root: string, text: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, CREDENTIALS_FILE);
  const temporary = `${target}.gugu-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, { mode: 0o600 });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export type ClaudeCredentialStoreOptions = {
  platform?: NodeJS.Platform;
  /** 钥匙串条目的账户名:CLI 用的是系统用户名。 */
  account?: string;
  /** 指定钥匙串文件(测试用临时钥匙串;缺省 = 登录钥匙串)。 */
  keychain?: string;
  security?: SecurityRunner;
};

export function createClaudeCredentialStore(options: ClaudeCredentialStoreOptions = {}): ClaudeCredentialStore {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      read: ({ root }) => readFileCredential(root),
      write: ({ root }, text) => writeFileCredential(root, text),
    };
  }
  const security = options.security ?? realSecurity();
  const account = options.account ?? userInfo().username;
  const keychainArgs = options.keychain ? [options.keychain] : [];

  const readKeychain = async (location: ClaudeCredentialLocation): Promise<string | null> => {
    const output = await security.find([
      'find-generic-password', '-s', claudeKeychainService(location), '-a', account, '-w', ...keychainArgs,
    ]);
    return output === null ? null : decodeSecret(output);
  };

  return {
    // 与 CLI 同一个先后:钥匙串优先,没有再看文件。
    async read(location) {
      return (await readKeychain(location)) ?? (await readFileCredential(location.root));
    },
    // 写到 CLI 此刻实际在用的那一处:钥匙串里已有就写钥匙串;只有文件(CLI 在钥匙串写不进时的退路)就写文件;
    // 两处都没有 = 全新,macOS 上放钥匙串。
    async write(location, text) {
      if ((await readKeychain(location)) === null && (await readFileCredential(location.root)) !== null) {
        await writeFileCredential(location.root, text);
        return;
      }
      const service = claudeKeychainService(location);
      const hex = Buffer.from(text, 'utf8').toString('hex');
      const command =
        `add-generic-password -U -a ${quote(account)} -s ${quote(service)} -X ${hex}` +
        (options.keychain ? ` ${quote(options.keychain)}` : '');
      if (command.length <= SECURITY_STDIN_LIMIT) await security.interactive(command);
      else await security.run(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex, ...keychainArgs]);
      // 读回来逐字比对:`security` 写坏了也可能报成功,宁可当场报错让切换回滚,❌ 留一份坏凭据在那里。
      if ((await readKeychain(location)) !== text) throw new Error('The Claude sign-in was not stored intact in the keychain');
    },
  };
}
