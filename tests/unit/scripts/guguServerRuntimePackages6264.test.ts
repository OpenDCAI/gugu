import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_BRIDGE_ENTRIES,
  APP_ROOT_PACKAGE_FILES,
  ADAPTER_PACKAGES,
  assertRuntimeSpecifiersResolve,
  externalDependencySpec,
  isExcludedNativePackage,
  packageNameOf,
  parsePatchedDependencies,
  RUNTIME_PACKAGES,
  runtimeResolvedSpecifiers,
} from '../../../scripts/gugu-server/runtime-packages.mjs';

/*
 * #6264 咕咕 server 包漏带 ACP 适配器:远端机器上建通用会话当场
 * `Cannot find module '@agentclientprotocol/claude-agent-acp/dist/index.js'`。
 * 这里守三件事:插件按路径现解析的包全在 server 包的清单里;出包闸在 server 布局下真能判出缺件;
 * 桌面那份 pnpm 补丁在 server 包里也会打上(版本对得上、补丁文件在)。
 */

const repoRoot = join(__dirname, '../../..');
const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 一份 server 安装目录的最小形状:app/dist-electron/<chunk>.js + app/node_modules。 */
function serverLayout(chunk: string, packages: string[]): { root: string; app: string } {
  const root = mkdtempSync(join(tmpdir(), 'gugu-server-layout-'));
  scratch.push(root);
  const app = join(root, 'versions', '0.2.114', 'app');
  writeFile(join(app, 'dist-electron', 'registry-abc.js'), chunk);
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  for (const entry of packages) writeFile(join(app, 'node_modules', entry), entry.endsWith('.json') ? '{}\n' : 'module.exports = {}\n');
  return { root, app };
}

// 与 rollup 真实产物同形(0.2.113 的 registry-CvwLCGnh.js 里就是这几句;#6394 之前插件自己现解析)。
const REGISTRY_CHUNK = [
  'const x = Promise.resolve("accepted");',
  'function resolveClaudeAcpEntry() { return _require$2.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"); }',
  'function resolvePiAcpEntry() { return _require.resolve("pi-acp/dist/index.js"); }',
  'function resolveZcodeAcpEntry() { return _require.resolve("zcode-acp-server/dist/cli.js"); }',
  'const p = require.resolve("node:path"); const q = require.resolve("./sibling.js"); const r = _require.resolve("fs");',
].join('\n');
// #6394 之后的产物:桥的说明符是宿主按 `acp.bridge` 声明拼出来的,chunk 里一个字面量都没有。
const DECLARATIVE_CHUNK = 'const bundled = () => deps.resolveBundled(`${bridge.alias}/${bridge.entry}`);\n';
const ADAPTER_ENTRIES = [
  '@agentclientprotocol/claude-agent-acp/dist/index.js',
  'pi-acp/dist/index.js',
  'zcode-acp-server/dist/cli.js',
];
// 宿主从应用根读的配对表与随 App 交付的 npm;完整的 server 包里它们和桥一起在。
const COMPAT_FILE = '@gugu-acp/compat/package.json';
const NPM_FILE = 'npm/package.json';
const APP_ROOT_FILES = [...ADAPTER_ENTRIES, COMPAT_FILE, NPM_FILE];

describe('runtimeResolvedSpecifiers', () => {
  it('只取裸包说明符:改了名的 _require$N 也认,Promise.resolve / 相对路径 / 内置模块不算', () => {
    expect([...runtimeResolvedSpecifiers(REGISTRY_CHUNK)].sort()).toEqual(ADAPTER_ENTRIES);
  });

  it('packageNameOf 认 scope', () => {
    expect(packageNameOf('@agentclientprotocol/claude-agent-acp/dist/index.js')).toBe('@agentclientprotocol/claude-agent-acp');
    expect(packageNameOf('pi-acp/dist/index.js')).toBe('pi-acp');
  });
});

describe('server 包的运行时清单', () => {
  it('插件 acp.bridge 声明的每一座 package 桥都在 ADAPTER_BRIDGE_ENTRIES 里(新接一家时漏了这里会红)', () => {
    const pluginsDir = join(repoRoot, 'packages/session-plugins/src');
    const declared = new Set<string>();
    const literal = new Set<string>();
    const PACKAGE_BRIDGE = /bridge:\s*\{\s*kind:\s*'package',\s*alias:\s*'([^']+)',\s*entry:\s*'([^']+)'/g;
    for (const file of readdirSync(pluginsDir, { recursive: true }) as string[]) {
      if (!/\.ts$/.test(file) || /\.test\.ts$/.test(file)) continue;
      const source = readFileSync(join(pluginsDir, file), 'utf8');
      for (const match of source.matchAll(PACKAGE_BRIDGE)) declared.add(`${match[1]}/${match[2]}`);
      for (const specifier of runtimeResolvedSpecifiers(source)) literal.add(packageNameOf(specifier));
    }
    // 阳控:claude、pi 两座 package 桥都被这条正则认出来 —— 认不出就是声明写法变了,这条闸跟着瞎。
    expect([...declared].sort()).toEqual([...ADAPTER_BRIDGE_ENTRIES].sort());
    // 插件里若又出现字面量现解析的包,也得在清单里。
    for (const name of literal) expect(ADAPTER_PACKAGES).toContain(name);
  });

  it('适配器与桌面同源:都是根 package.json 的生产依赖(桌面包由此带上,server 取同一个版本)', () => {
    for (const name of ADAPTER_PACKAGES) expect(rootPackage.dependencies[name], name).toBeTruthy();
    expect(RUNTIME_PACKAGES).toEqual(expect.arrayContaining([...ADAPTER_PACKAGES, 'better-sqlite3', 'node-pty']));
  });

  it('Claude 桥的配对表与随 App 交付的 npm 进包:是根依赖、在 RUNTIME_PACKAGES 里,且就是宿主读 / 跑的那两个', () => {
    expect(APP_ROOT_PACKAGE_FILES).toEqual([COMPAT_FILE, NPM_FILE]);
    for (const name of ['@gugu-acp/compat', 'npm']) {
      expect(rootPackage.dependencies[name], name).toBeTruthy();
      expect(RUNTIME_PACKAGES).toContain(name);
    }
    const downloader = readFileSync(join(repoRoot, 'apps/desktop/electron/engine-downloader.ts'), 'utf8');
    expect(downloader).toContain("join(appRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')");
    const deps = readFileSync(join(repoRoot, 'apps/desktop/electron/session/main/core/agents/acp-bridge/claude-bridge-deps.ts'), 'utf8');
    expect(deps).toContain("const COMPAT_PACKAGE = '@gugu-acp/compat';");
    expect(deps).toContain('req(`${COMPAT_PACKAGE}/package.json`)');
  });

  it('server App background HTML has its packaged Playwright runtime', () => {
    expect(rootPackage.dependencies['@playwright/mcp']).toBeTruthy();
    expect(RUNTIME_PACKAGES).toContain('@playwright/mcp');
  });

  it('剔掉的只是平台原生二进制包,不误伤 SDK 与 codex 主包', () => {
    expect(isExcludedNativePackage('@anthropic-ai/claude-agent-sdk-linux-arm64')).toBe(true);
    expect(isExcludedNativePackage('@openai/codex-linux-x64')).toBe(true);
    expect(isExcludedNativePackage('@anthropic-ai/claude-agent-sdk')).toBe(false);
    expect(isExcludedNativePackage('@openai/codex')).toBe(false);
  });
});

describe('assertRuntimeSpecifiersResolve(出包闸,server 安装目录布局)', () => {
  it('适配器入口都在包里:通过,并报出解析到的清单', () => {
    const { app } = serverLayout(REGISTRY_CHUNK, APP_ROOT_FILES);
    expect(assertRuntimeSpecifiersResolve(app)).toEqual([COMPAT_FILE, NPM_FILE, ...ADAPTER_ENTRIES].sort());
  });

  it('#6394 之后 chunk 里没有字面量:照样按声明逐条查,缺 claude 适配器时点名失败(❌ 静默放行)', () => {
    const complete = serverLayout(DECLARATIVE_CHUNK, APP_ROOT_FILES);
    expect(assertRuntimeSpecifiersResolve(complete.app)).toEqual([COMPAT_FILE, NPM_FILE, ...ADAPTER_ENTRIES].sort());
    const missing = serverLayout(DECLARATIVE_CHUNK, APP_ROOT_FILES.slice(1));
    expect(() => assertRuntimeSpecifiersResolve(missing.app)).toThrow(/claude-agent-acp\/dist\/index\.js\(acp\.bridge\).*包里没有/);
  });

  it('缺 claude 适配器(0.2.113 的样子):点名失败', () => {
    const { app } = serverLayout(REGISTRY_CHUNK, APP_ROOT_FILES.slice(1));
    expect(() => assertRuntimeSpecifiersResolve(app)).toThrow(/claude-agent-acp\/dist\/index\.js.*包里没有/);
  });

  it('缺配对表 @gugu-acp/compat(0.2.58 的 server 包):点名失败 —— 宿主读不到它就只用随包的桥', () => {
    const { app } = serverLayout(DECLARATIVE_CHUNK, [...ADAPTER_ENTRIES, NPM_FILE]);
    expect(() => assertRuntimeSpecifiersResolve(app)).toThrow(/@gugu-acp\/compat\/package\.json\(app root\).*包里没有/);
  });

  it('缺随 App 交付的 npm(0.2.58 的 server 包):点名失败 —— 读得到表也查不了新表、下不了配上的桥', () => {
    const { app } = serverLayout(DECLARATIVE_CHUNK, [...ADAPTER_ENTRIES, COMPAT_FILE]);
    expect(() => assertRuntimeSpecifiersResolve(app)).toThrow(/npm\/package\.json\(app root\).*包里没有/);
  });

  it('只在上层目录的 node_modules 里有(构建机的仓库根):仍然判失败 —— 用户机器上没有那一层', () => {
    const { root, app } = serverLayout(REGISTRY_CHUNK, APP_ROOT_FILES.slice(1));
    writeFile(join(root, 'node_modules', ADAPTER_ENTRIES[0]!), 'module.exports = {}\n');
    expect(() => assertRuntimeSpecifiersResolve(app)).toThrow(/claude-agent-acp.*解析到包外/);
  });
});

describe('parsePatchedDependencies(桌面那份 pnpm 补丁在 server 包里也打上)', () => {
  const entries = parsePatchedDependencies(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'));

  it('桌面这边已经没有依赖补丁:claude 与 pi 两个桥接改用咕咕维护的构建,node-pty 那份已删(#6394)', () => {
    expect(entries).toEqual([]);
    expect(rootPackage.dependencies['@agentclientprotocol/claude-agent-acp']).toMatch(/^npm:@gugu-acp\/claude-agent-acp@/);
    expect(rootPackage.dependencies['pi-acp']).toMatch(/^npm:@gugu-acp\/pi-acp@/);
    for (const entry of entries) expect(existsSync(join(repoRoot, entry.patch)), entry.patch).toBe(true);
  });

  it('补丁钉的版本 = 根 package.json 装的版本(否则出包时版本闸会停)', () => {
    for (const entry of entries.filter((e) => ADAPTER_PACKAGES.includes(e.name))) {
      expect(rootPackage.dependencies[entry.name]).toBe(entry.version);
    }
  });

  it('引号、注释、段落结束都认', () => {
    const yaml = [
      'packages:',
      "  - 'apps/*'",
      'patchedDependencies:',
      "  '@scope/pkg@1.2.3': patches/@scope__pkg@1.2.3.patch",
      '  plain@0.0.1: patches/plain@0.0.1.patch # note',
      '# comment',
      'other: 1',
      '  late@9.9.9: nope.patch',
    ].join('\n');
    expect(parsePatchedDependencies(yaml)).toEqual([
      { name: '@scope/pkg', version: '1.2.3', patch: 'patches/@scope__pkg@1.2.3.patch' },
      { name: 'plain', version: '0.0.1', patch: 'patches/plain@0.0.1.patch' },
    ]);
  });
});

describe('externalDependencySpec(server 包 package.json 里依赖写什么)', () => {
  it('根 package.json 是 npm: 别名 ⇒ 清单原样写别名(只写 1.0.0 会去原包名下找 → ETARGET)', () => {
    const deps = { '@agentclientprotocol/claude-agent-acp': 'npm:@gugu-acp/claude-agent-acp@1.0.0', 'pi-acp': '0.0.33' };
    expect(externalDependencySpec('@agentclientprotocol/claude-agent-acp', deps, '1.0.0')).toBe('npm:@gugu-acp/claude-agent-acp@1.0.0');
    // arm64 那条路:x64 写下的 externals.json 里若是裸版本号,也改回别名(两条路同一个结果)。
    expect(externalDependencySpec('@agentclientprotocol/claude-agent-acp', deps, 'npm:@gugu-acp/claude-agent-acp@1.0.0')).toBe(
      'npm:@gugu-acp/claude-agent-acp@1.0.0',
    );
  });

  it('普通依赖照旧取装上的版本号', () => {
    expect(externalDependencySpec('pi-acp', { 'pi-acp': '^0.0.33' }, '0.0.33')).toBe('0.0.33');
    expect(externalDependencySpec('ws', undefined, '8.18.0')).toBe('8.18.0');
  });

  it('仓库此刻的根清单:claude 适配器是别名,server 清单里保持 npm:@gugu-acp/…', () => {
    const spec = externalDependencySpec(
      '@agentclientprotocol/claude-agent-acp',
      rootPackage.dependencies,
      JSON.parse(readFileSync(join(repoRoot, 'node_modules/@agentclientprotocol/claude-agent-acp/package.json'), 'utf8')).version,
    );
    expect(spec).toMatch(/^npm:@gugu-acp\/claude-agent-acp@/);
  });
});
