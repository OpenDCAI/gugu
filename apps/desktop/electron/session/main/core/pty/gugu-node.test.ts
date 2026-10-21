import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => null }));

import { GUGU_NODE, guguNodeEnv, guguNodeScripts, guguNodeTarget, installGuguNode, setGuguNodeDir } from './gugu-node';

// 咕咕自带的 Node 摆上 agent 的 PATH:用户没装 Node,App skill 带的脚本也跑得起来(gugu-node.ts)。
describe('gugu-node', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-node-'));
  });
  afterEach(() => {
    setGuguNodeDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 起法与 agent 的 shell 一样:按名字在 PATH 里找;PATH 上除了它只有 /bin(没有任何 node)。stdin 从文件喂(同步 spawn 的
  // `input` 在 macOS 上会间歇性挂死,见 .eslintrc.cjs 的 @@@spawnsync-input)。
  const run = (bin: string, args: string, input = '') => {
    const file = path.join(dir, 'stdin.txt');
    fs.writeFileSync(file, input);
    const fd = fs.openSync(file, 'r');
    try {
      return spawnSync('/bin/sh', ['-c', `${GUGU_NODE} ${args}`], { env: { PATH: `${bin}:/bin` }, stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8' });
    } finally {
      fs.closeSync(fd);
    }
  };
  // A script that says what it got and starts itself again the way tsx and nodemon do (process.execPath, `-e` and a .cjs):
  // on gugu's own Electron those children are Node only while ELECTRON_RUN_AS_NODE reaches them.
  const probe = () => {
    fs.writeFileSync(path.join(dir, 'child.cjs'), "console.log('cjs ' + (process.env.ELECTRON_RUN_AS_NODE ?? 'unset'))\n");
    const script = path.join(dir, 'probe.mjs');
    fs.writeFileSync(script, [
      "import { spawnSync } from 'node:child_process'",
      "import { readFileSync } from 'node:fs'",
      "const again = (args) => { const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 }); return [r.status, r.stdout.trim()] }",
      'const children = [again([\'-e\', "console.log(\'e \' + (process.env.ELECTRON_RUN_AS_NODE ?? \'unset\'))"]), again([new URL(\'child.cjs\', import.meta.url).pathname])]',
      "console.log(JSON.stringify({ asNode: process.env.ELECTRON_RUN_AS_NODE ?? null, children, args: process.argv.slice(2), stdin: readFileSync(0, 'utf8') }))",
      'process.exit(3)',
    ].join('\n'));
    return script;
  };

  it.skipIf(process.platform === 'win32')('PATH 上没有 node 时按名字就跑得起来:参数、stdin、退出码照传;脚本按 process.execPath 再起自己(-e、.cjs)仍是 node', () => {
    installGuguNode({ dir, node: process.execPath, electron: true });
    const script = probe();
    expect(run('/bin', '-e 1').status).not.toBe(0); // 阴控:没摆上的 PATH 里找不到它
    const result = run(dir, `'${script}' outline '第 3 页'`, 'piped-in');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(3);
    // 评审 0f4766613c:把这个变量从脚本的环境里删掉(预载),再起自己就成了 Electron App —— `-e` 挂住、tsx 挂住。
    expect(JSON.parse(result.stdout)).toEqual({ asNode: '1', children: [[0, 'e 1'], [0, 'cjs 1']], args: ['outline', '第 3 页'], stdin: 'piped-in' });
  });

  it.skipIf(process.platform === 'win32')('交给咕咕自己的可执行文件的:ELECTRON_RUN_AS_NODE=1(让它按 node 跑),再是原样的参数', () => {
    // A stand-in for gugu's executable that says what it was handed.
    const exe = path.join(dir, 'fake-gugu');
    fs.writeFileSync(exe, '#!/bin/sh\necho "asNode=$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do echo "arg=$a"; done\n', { mode: 0o755 });
    const bin = path.join(dir, 'bin');
    installGuguNode({ dir: bin, node: exe, electron: true });
    const result = run(bin, `x.mjs '第 3 页'`);
    expect(result.stdout.split('\n')).toEqual(['asNode=1', 'arg=x.mjs', 'arg=第 3 页', '']);
  });

  it.skipIf(process.platform === 'win32')('server 上是真 node:不设 ELECTRON_RUN_AS_NODE,照样跑', () => {
    installGuguNode({ dir, node: process.execPath, electron: false });
    expect(fs.readdirSync(dir).sort()).toEqual(['gugu-node']);
    expect(fs.readFileSync(path.join(dir, GUGU_NODE), 'utf8')).not.toContain('ELECTRON_RUN_AS_NODE');
    const result = run(dir, `'${probe()}' a`, '');
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ asNode: null, children: [[0, 'e unset'], [0, 'cjs unset']], args: ['a'] });
  });

  it.skipIf(process.platform === 'win32')('可执行文件的路径带空格和单引号也跑得起来', () => {
    const odd = path.join(dir, "it's a dir");
    fs.mkdirSync(odd);
    fs.symlinkSync(process.execPath, path.join(odd, 'node'));
    const bin = path.join(odd, 'bin');
    installGuguNode({ dir: bin, node: path.join(odd, 'node'), electron: true });
    const result = run(bin, '-e "console.log(6 * 7)"');
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('42');
  });

  it('Windows:.cmd 给 PowerShell / cmd,无后缀的 sh 给 Git Bash;路径写绝对的(❌ %~dp0),% 在批处理里写成 %%', () => {
    const scripts = guguNodeScripts('C:\\Program Files\\gugu 100%\\gugu.exe', 'win32', true);
    expect(Object.keys(scripts).sort()).toEqual(['gugu-node', 'gugu-node.cmd']);
    const cmd = scripts['gugu-node.cmd']!;
    expect(cmd.split('\r\n')).toEqual(['@echo off', expect.stringMatching(/^rem /), 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', '"C:\\Program Files\\gugu 100%%\\gugu.exe" %*', '']);
    // 评审 0f4766613c:cmd 里带引号按裸名调用("gugu-node")时 %~dp0 展开成当前目录。
    expect(cmd).not.toContain('%~dp0');
    const sh = scripts['gugu-node']!;
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true);
    expect(sh).toContain(`exec 'C:/Program Files/gugu 100%/gugu.exe' "$@"`);
    expect(sh).toContain('export ELECTRON_RUN_AS_NODE');
  });

  // 批处理按 OEM 代码页(936 / 437)读:UTF-8 写的中文路径读出来是乱码,找不到程序(Windows 实测,读数在 PR 正文)。
  it('Windows .cmd:路径全是 ASCII 就直接写;有中文(中文用户名下的按用户安装)就临时切到 UTF-8 读那一行,再切回去', () => {
    const ascii = guguNodeScripts('D:\\gugu\\gugu.exe', 'win32', true)['gugu-node.cmd']!;
    expect(ascii).toMatch(/^[\x20-\x7e\r\n]*$/);
    expect(ascii).not.toContain('chcp');
    const chinese = guguNodeScripts('C:\\Users\\张三\\AppData\\Local\\Programs\\gugu\\gugu.exe', 'win32', true)['gugu-node.cmd']!.split('\r\n');
    const run = chinese.indexOf('"C:\\Users\\张三\\AppData\\Local\\Programs\\gugu\\gugu.exe" %*');
    expect(chinese.indexOf('chcp 65001 >nul')).toBeGreaterThan(-1);
    expect(chinese.indexOf('chcp 65001 >nul')).toBeLessThan(run);
    expect(chinese.slice(-3)).toEqual(['chcp %gugu_cp% >nul', 'exit /b %gugu_rc%', '']);
  });

  it('不叫 node:它排在 PATH 最前,同名会遮住用户自己的 node', () => {
    // 字面量,不拿 GUGU_NODE 比:常量自己被改成 node 时,拿它比永远相等。
    expect(Object.keys(guguNodeScripts('/x/gugu', 'darwin', true))).toEqual(['gugu-node']);
    expect(Object.keys(guguNodeScripts('/x/node', 'linux', false))).toEqual(['gugu-node']);
    expect(Object.keys(guguNodeScripts('C:\\x\\gugu.exe', 'win32', true)).sort()).toEqual(['gugu-node', 'gugu-node.cmd']);
  });

  it('放哪、指向谁:桌面 <GUGU_HOME>/bin + 咕咕自己(Electron);server 放它的助手目录、指向 current 里的真 node(开发构建没有 current 就是在跑的这个)', () => {
    const none = { existsSync: () => false };
    expect(guguNodeTarget({ GUGU_HOME: '/h/.gugu-beta' }, '/Applications/咕咕 Beta.app/Contents/MacOS/咕咕 Beta', none, true)).toEqual({
      dir: path.join('/h/.gugu-beta', 'bin'),
      node: '/Applications/咕咕 Beta.app/Contents/MacOS/咕咕 Beta',
      electron: true,
    });
    const current = path.join('/s/.gugu-server', 'current', 'node', 'bin', 'node');
    const installed = { existsSync: (file: fs.PathLike) => file === current };
    const env = { GUGU_HOME: '/s/.gugu-server/accounts/a/home', GUGU_SERVER_HOME: '/s/.gugu-server' };
    expect(guguNodeTarget(env, '/s/.gugu-server/versions/0.2.60/node/bin/node', installed, false)).toEqual({
      dir: path.join('/s/.gugu-server', 'bin'),
      node: current,
      electron: false,
    });
    expect(guguNodeTarget(env, '/usr/local/bin/node', none, false)).toEqual({ dir: path.join('/s/.gugu-server', 'bin'), node: '/usr/local/bin/node', electron: false });
  });

  // An fs that records what is done to it (评审 729508060d / 3a22de0c5e: judged by the calls, ❌ a wall-clock race).
  const recordingFs = (fail: { read?: string; rename?: string; rm?: string } = {}) => {
    const calls: string[] = [];
    const files = new Map<string, string>();
    const error = (code: string) => Object.assign(new Error(code), { code });
    const fake = {
      mkdirSync: () => undefined,
      chmodSync: (file: fs.PathLike, mode: fs.Mode) => calls.push(`chmod ${String(file)} ${Number(mode).toString(8)}`),
      existsSync: (file: fs.PathLike) => files.has(String(file)),
      readFileSync: (file: fs.PathOrFileDescriptor) => {
        if (fail.read) throw error(fail.read);
        if (!files.has(String(file))) throw error('ENOENT');
        return files.get(String(file))!;
      },
      writeFileSync: (file: fs.PathOrFileDescriptor, body: string | NodeJS.ArrayBufferView) => {
        calls.push(`write ${String(file)}`);
        files.set(String(file), String(body));
      },
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        calls.push(`rename ${String(from)} -> ${String(to)}`);
        if (fail.rename) throw error(fail.rename);
        files.set(String(to), files.get(String(from))!);
        files.delete(String(from));
      },
      rmSync: (file: fs.PathLike) => {
        calls.push(`rm ${String(file)}`);
        if (fail.rm) throw error(fail.rm);
        files.delete(String(file));
      },
    } as unknown as Parameters<typeof installGuguNode>[0]['fsImpl'];
    return { calls, files, fake };
  };
  const target = path.join('/h/bin', GUGU_NODE);
  /** The calls of one write: a temp file of this process's own beside it (<target>.<pid>.<8 hex>.tmp), chmod, rename. */
  const throughTemp = (calls: string[]) => {
    const temp = calls[0]!.replace(/^write /, '');
    const prefix = `${target}.${process.pid}.`;
    expect(temp.startsWith(prefix) && temp.endsWith('.tmp')).toBe(true);
    expect(temp.slice(prefix.length, -'.tmp'.length)).toMatch(/^[0-9a-f]{8}$/);
    expect(calls).toEqual([`write ${temp}`, `chmod ${temp} 700`, `rename ${temp} -> ${target}`]);
    return temp;
  };

  // 评审 729508060d:每次截断重写,正在跑它的人读到空的或半截的(竞速 130 次 42 次失败)。
  it('每次启动核一遍(与 gugu-browser 同一个写法):内容一样只把权限拉回 700;变了先写旁边的临时文件再 rename 过去,❌ 原地截断', () => {
    const { calls, files, fake } = recordingFs();
    installGuguNode({ dir: '/h/bin', node: '/a/gugu', electron: true, platform: 'darwin', fsImpl: fake });
    throughTemp(calls);
    calls.length = 0;
    installGuguNode({ dir: '/h/bin', node: '/a/gugu', electron: true, platform: 'darwin', fsImpl: fake });
    expect(calls).toEqual([`chmod ${target} 700`]);
    calls.length = 0;
    installGuguNode({ dir: '/h/bin', node: '/b/gugu', electron: true, platform: 'darwin', fsImpl: fake });
    throughTemp(calls);
    expect(files.get(target)).toContain(`exec '/b/gugu' "$@"`);
    expect([...files.keys()]).toEqual([target]);
  });

  it.skipIf(process.platform === 'win32')('权限被人改过(644),再装一次恢复 700(评审 3a22de0c5e)', () => {
    installGuguNode({ dir, node: process.execPath, electron: true });
    const file = path.join(dir, GUGU_NODE);
    fs.chmodSync(file, 0o644);
    installGuguNode({ dir, node: process.execPath, electron: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual([GUGU_NODE]);
  });

  it('读不出来(EACCES)当作「不一样」:照样经临时文件 + rename 装上', () => {
    const { calls, files, fake } = recordingFs({ read: 'EACCES' });
    installGuguNode({ dir: '/h/bin', node: '/a/gugu', electron: true, platform: 'darwin', fsImpl: fake });
    throughTemp(calls);
    expect(files.get(target)).toContain(`exec '/a/gugu' "$@"`);
  });

  it('临时文件建好以后出错(rename 报 EPERM):先删掉临时文件,错误照样抛出去,PATH 上的目录里不留 .tmp', () => {
    const { calls, files, fake } = recordingFs({ rename: 'EPERM' });
    expect(() => installGuguNode({ dir: '/h/bin', node: '/a/gugu', electron: true, platform: 'darwin', fsImpl: fake })).toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );
    const temp = calls[0]!.replace(/^write /, '');
    expect(calls.at(-1)).toBe(`rm ${temp}`);
    expect([...files.keys()]).toEqual([]);
  });

  it('删临时文件也失败(Windows 上 EBUSY):抛出去的仍是 rename 的 EPERM,❌ 被 rm 的错盖掉(评审 4c06337fe2)', () => {
    const { fake } = recordingFs({ rename: 'EPERM', rm: 'EBUSY' });
    expect(() => installGuguNode({ dir: '/h/bin', node: '/a/gugu', electron: true, platform: 'darwin', fsImpl: fake })).toThrow(
      expect.objectContaining({ code: 'EPERM' }),
    );
  });

  it('agent 的 PATH:装上了就排最前(已在里面就挪到最前),没装就不动', async () => {
    expect(guguNodeEnv('/usr/bin:/bin', ':')).toEqual({});
    setGuguNodeDir('/h/bin');
    expect(guguNodeEnv('/usr/bin:/h/bin:/bin', ':')).toEqual({ PATH: '/h/bin:/usr/bin:/bin' });
    expect(guguNodeEnv('/usr/bin;/h/bin', ';')).toEqual({ PATH: '/h/bin;/usr/bin' });
    setGuguNodeDir(dir);
    const { buildAgentEnv } = await import('./pty-env');
    expect(buildAgentEnv({ includeUserShellEnv: false }).PATH.split(path.delimiter)[0]).toBe(dir);
    setGuguNodeDir(null);
    expect(buildAgentEnv({ includeUserShellEnv: false }).PATH.split(path.delimiter)).not.toContain(dir);
  });
});

// 按「咕咕自己的可执行文件 + ELECTRON_RUN_AS_NODE」真跑的那一半(桌面三平台、server 包里的 node)单测里量不到:这里的 node
// 不是 Electron。读数在 PR 正文。
