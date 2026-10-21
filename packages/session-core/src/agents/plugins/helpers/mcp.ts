import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import { parseDocument } from 'yaml';
import type { PluginFs } from '../../runtime/fs';
import type { McpServerRegistration } from '../capabilities/mcp';

// ── Internal helpers ────────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (cur, key) =>
        cur != null && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined,
      obj
    );
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<Record<string, unknown>>((cur, key) => {
    if (cur[key] == null || typeof cur[key] !== 'object') cur[key] = {};
    return cur[key] as Record<string, unknown>;
  }, obj);
  target[last] = value;
}

export function cloneMcpEntry<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * 落盘会丢掉**值为 `undefined` 的键** —— `JSON.stringify` 与 smol-toml 都是这样。所以比较前
 * 得按同一把尺子归一,否则「拿去比较的值」与「真正写下去的值」不是同一个,幂等就不再由构造成立:
 * `mcpServerToRegistration` 给每个缺席字段都显式发一个 `undefined`(mcp/registration.ts),
 * 那样的 registration 第一次写得进去、第二次必抛 —— 与 #4651 同一个死法,只是换了个来源。
 * 写侧字节不变(序列化本来就丢它们),变的只是比较变得诚实。
 */
function dropUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, dropUndefined(entry)])
  );
}

export const INJECTED_MCP_ACCEPT = 'application/json, text/event-stream';

export function ensureMcpHeader(headers: Record<string, string>, key: string, val: string): void {
  if (typeof headers[key] !== 'string') headers[key] = val;
}

/**
 * gemini / qwen 家的原生 HTTP MCP 条目形状 —— 键是 `httpUrl` 不是 `type`+`url`,并且**必须**带
 * `Accept: application/json, text/event-stream`(MCP streamable-HTTP 的客户端要求;缺了它,
 * 服务端按协议可以直接 406)。
 *
 * ⚠️ 导出它是为了**只有一份方言**:除了这里的 writer,咕咕的 qwen 会话物化器也要产出同形条目
 *    (它把 MCP 写进 run-scoped 的系统级 settings 副本,见 impl/qwen/session-bundle.ts)。
 *    两处各手写一份 = 一处改了另一处静默漂移,而漂移的后果是「连不上」这种只有真端点才照得出的错。
 */
export function geminiFamilyHttpMcpEntry(
  url: string,
  headers: Record<string, string> = {}
): { httpUrl: string; headers: Record<string, string> } {
  const merged: Record<string, string> = { ...headers };
  ensureMcpHeader(merged, 'Accept', INJECTED_MCP_ACCEPT);
  return { httpUrl: url, headers: merged };
}

export function stripInjectedMcpHeaders(entry: Record<string, unknown>): void {
  if (typeof entry.headers !== 'object' || entry.headers === null) return;
  const headers = entry.headers as Record<string, string>;
  if (headers.Accept === INJECTED_MCP_ACCEPT) {
    delete headers.Accept;
    if (!Object.keys(headers).length) delete entry.headers;
  }
}

// ── McpConfigShape ──────────────────────────────────────────────────────────

type McpConfigShape = {
  /** Primary config path: the only file written to. */
  configPath: string;
  /** Extra paths read for migration only — never written. */
  legacyReadPaths?: string[];
  /**
   * Same-priority sibling paths read AFTER configPath; on a name conflict the companion wins.
   * 为 opencode 系的 `.jsonc` 候选名而设：厂商加载序是 `[x.json, x.jsonc]` 逐个 merge、后载者胜
   * (MiMo 0.1.13 发行字节的 config 加载循环;opencode 同族),所以 companion 的优先级在 configPath 之上。
   */
  companionReadPaths?: string[];
  /** Optional server key used only by legacyReadPaths. */
  legacyServersKey?: string;
  /** Treat legacyServersKey as a literal key instead of a dot-delimited object path. */
  legacyServersKeyIsLiteral?: boolean;
  format: 'json' | 'toml' | 'yaml';
  serversKey: string;
  /** Treat serversKey as a literal key instead of a dot-delimited object path. */
  serversKeyIsLiteral?: boolean;
  toNative(server: McpServerRegistration): Record<string, unknown>;
  fromNative(name: string, raw: Record<string, unknown>): McpServerRegistration;
};

function parseYamlDocument(content: string) {
  const doc = parseDocument(content);
  if (doc.errors.length > 0) throw new Error(`invalid YAML config: ${doc.errors[0].message}`);
  return doc;
}

function parseMcpFile(content: string, format: 'json' | 'toml' | 'yaml'): Record<string, unknown> {
  if (format === 'toml') return parseTOML(content) as Record<string, unknown>;
  if (format === 'yaml') return (parseYamlDocument(content).toJS() ?? {}) as Record<string, unknown>;
  // 厂商把这些 JSON 配置当 JSONC 用(#4595:qwen 自己 stripJsonComments,cursor 打包 jsonc-parser,
  // MiMo 对 .json/.jsonc 走同一 jsonc 解析,copilot #4582)。严格 JSON.parse 会在这里抛,
  // 再被 readFromPath 的 catch 吞成"静默空读" —— 用户配了 server,咕咕说没有,零报错。
  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true }) as Record<
    string,
    unknown
  >;
  if (errors.length > 0) {
    throw new Error(`invalid JSON(C) config: parse error at offset ${errors[0].offset}`);
  }
  return parsed;
}

export function createMcpAdapter(shape: McpConfigShape) {
  function assertWritable(fs: PluginFs): void {
    // 白名单:只有显式声明为可写的 scope 才能动配置文件。undefined 一律拒绝 ——
    // 没有声明写权的 fs 不允许"因为忘了传"就获得改写用户配置的能力(#4595 fail-open:
    // qwen 会话写入器曾经由一个无 scope 的 PluginFs 绕过本闸整文件重写 ~/.qwen/settings.json)。
    const scope = fs.mcpWriteScope;
    if (scope === 'owned') return;
    throw new Error(
      'MCP settings are read-only in Gugu: user harness configuration files are never modified' +
        ` (write scope: ${scope ?? 'undeclared'}). Edit the server in its harness configuration.`
    );
  }

  const getServers = (
    parsed: Record<string, unknown>,
    serversKey = shape.serversKey,
    serversKeyIsLiteral = shape.serversKeyIsLiteral
  ): unknown => (serversKeyIsLiteral ? parsed[serversKey] : getNestedValue(parsed, serversKey));

  const setServers = (
    parsed: Record<string, unknown>,
    servers: unknown,
    serversKey = shape.serversKey,
    serversKeyIsLiteral = shape.serversKeyIsLiteral
  ): void => {
    if (serversKeyIsLiteral) {
      parsed[serversKey] = servers;
      return;
    }
    setNestedValue(parsed, serversKey, servers);
  };

  const serversKeyPath = (
    serversKey = shape.serversKey,
    serversKeyIsLiteral = shape.serversKeyIsLiteral
  ): string[] => (serversKeyIsLiteral ? [serversKey] : serversKey.split('.'));

  const legacyServersKey = shape.legacyServersKey ?? shape.serversKey;
  const legacyServersKeyIsLiteral =
    shape.legacyServersKey === undefined
      ? shape.serversKeyIsLiteral
      : shape.legacyServersKeyIsLiteral;

  /**
   * 会话启动那几条路走这里:一份读不懂的文件当作没有 server,❌ 不让它把整条会话拦下。
   */
  async function readFromPath(
    fs: PluginFs,
    filePath: string,
    serversKey = shape.serversKey,
    serversKeyIsLiteral = shape.serversKeyIsLiteral
  ): Promise<Map<string, McpServerRegistration>> {
    const content = await fs.read(filePath);
    if (!content) return new Map();
    try {
      const parsed = parseMcpFile(content, shape.format);
      const servers = getServers(parsed, serversKey, serversKeyIsLiteral) ?? {};
      return new Map(
        Object.entries(servers as Record<string, unknown>).map(([name, raw]) => [
          name,
          shape.fromNative(name, raw as Record<string, unknown>),
        ])
      );
    } catch {
      return new Map();
    }
  }

  async function removeFromPath(
    fs: PluginFs,
    filePath: string,
    name: string,
    serversKey = shape.serversKey,
    serversKeyIsLiteral = shape.serversKeyIsLiteral
  ): Promise<void> {
    const content = await fs.read(filePath);
    if (!content) return;
    try {
      const parsed = parseMcpFile(content, shape.format);
      const servers = getServers(parsed, serversKey, serversKeyIsLiteral) ?? {};
      if (!(name in (servers as Record<string, unknown>))) return;
      if (shape.format === 'yaml') {
        // 定点删除,不整文件重写:用户 YAML 里的注释与排版在咕咕删掉它写的那一条之后照旧。
        const doc = parseYamlDocument(content);
        doc.deleteIn([...serversKeyPath(serversKey, serversKeyIsLiteral), name]);
        await fs.write(filePath, doc.toString());
        return;
      }
      const filtered = Object.fromEntries(
        Object.entries(servers as Record<string, unknown>).filter(([k]) => k !== name)
      );
      setServers(parsed, filtered, serversKey, serversKeyIsLiteral);
      const output =
        shape.format === 'json' ? JSON.stringify(parsed, null, 2) + '\n' : stringifyTOML(parsed);
      await fs.write(filePath, output);
    } catch {
      // ignore parse errors in legacy files
    }
  }

  return {
    async readServers(fs: PluginFs): Promise<McpServerRegistration[]> {
      const serverMap = new Map<string, McpServerRegistration>();
      // Legacy paths first (lower priority — canonical wins on name conflict)
      for (const legacyPath of shape.legacyReadPaths ?? []) {
        for (const [name, reg] of await readFromPath(
          fs,
          legacyPath,
          legacyServersKey,
          legacyServersKeyIsLiteral
        )) {
          if (!serverMap.has(name)) serverMap.set(name, reg);
        }
      }
      // Canonical path — overwrites any legacy entry with the same name
      for (const [name, reg] of await readFromPath(fs, shape.configPath)) {
        serverMap.set(name, reg);
      }
      // Companions (.jsonc siblings) — vendor loads them after the .json, later wins
      for (const companionPath of shape.companionReadPaths ?? []) {
        for (const [name, reg] of await readFromPath(fs, companionPath)) {
          serverMap.set(name, reg);
        }
      }
      return Array.from(serverMap.values());
    },
    async writeServers(fs: PluginFs, servers: McpServerRegistration[]): Promise<void> {
      assertWritable(fs);
      // Always write the canonical path only; legacy paths are read-only
      const content = await fs.read(shape.configPath);
      // 写前读取与读侧同一把尺子:parseMcpFile 容注释(JSONC 是厂商常态,#4595),
      // 真错误 fail loud;这里补上文件名归属。
      let parsed: Record<string, unknown> = {};
      if (content) {
        try {
          parsed = parseMcpFile(content, shape.format);
        } catch (error) {
          throw new Error(`Cannot edit '${shape.configPath}': ${(error as Error).message}`, {
            cause: error,
          });
        }
      }
      const existing = getServers(parsed) ?? {};
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        throw new Error(`MCP servers at '${shape.configPath}' must be an object`);
      }
      const native = { ...(existing as Record<string, unknown>) };
      for (const server of servers) {
        const next = dropUndefined(shape.toNative(server)) as Record<string, unknown>;
        const previous = native[server.name];
        // @@@冲突判定在 native 空间 —— 比「盘上的字节」与「这次要写的字节」。同一个 `next`
        // 既用来比较也用来落盘,所以咕咕重复注册同一条 registration 必然自等:幂等由构造保证,
        // 不靠任何 adapter 的额外性质。
        // ❌ 不要拿 `fromNative(previous)` 去比 `server`:那把写路径的存活挂在 adapter
        // round-trip 的保真度上,而没有任何判据要求 toNative/fromNative 互逆。#4651 就死在这:
        // gemini/qwen 的 `toNative` 在 http 分支只留 httpUrl/headers/env,丢掉 registration 的
        // `transport:'http'`,`fromNative` 只补得回 `type` ⇒ 我们上一次写的条目读回来与本次要写的
        // 不深等 ⇒ 第二次开 TUI 会话就抛,冒泡到 hydrateSession,整条腿起不来。
        if (previous !== undefined && !isDeepStrictEqual(previous, next)) {
          throw new Error(
            `MCP server '${server.name}' already exists with different configuration` +
              ` in '${shape.configPath}'. Gugu never overwrites an entry it did not write —` +
              ' remove or rename that entry there to let the session register.'
          );
        }
        native[server.name] = next;
      }
      if (shape.format === 'yaml') {
        // 与下面 JSON 那条同一个要求:只触碰 serversKey 下被写的条目,注释与排版幸存。
        const doc = parseYamlDocument(content ?? '');
        for (const server of servers) {
          doc.setIn([...serversKeyPath(), server.name], native[server.name]);
        }
        await fs.write(shape.configPath, doc.toString());
        return;
      }
      if (shape.format === 'json') {
        // 定点编辑,不整文件 stringify:用户文件里的注释与排版必须在咕咕的注册写之后幸存
        // (#4595 类 2;先例 #4585 的 modify+applyEdits)。只触碰 serversKey 下被写的条目。
        const keyPath = serversKeyPath();
        let text = content && content.trim() ? content : '{}\n';
        for (const server of servers) {
          const edits = modify(text, [...keyPath, server.name], native[server.name], {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          });
          text = applyEdits(text, edits);
        }
        await fs.write(shape.configPath, text);
        return;
      }
      setServers(parsed, native);
      // TOML 仍整文件写(kimi/codex 写侧属 #4595 类 2 批次,与 TOML 定点编辑一起落)。
      await fs.write(shape.configPath, stringifyTOML(parsed));
    },
    async removeServer(fs: PluginFs, name: string): Promise<void> {
      assertWritable(fs);
      // Remove from canonical path
      await removeFromPath(fs, shape.configPath, name);
      // Remove from all legacy paths so a stale copy cannot resurface on next read
      for (const legacyPath of shape.legacyReadPaths ?? []) {
        await removeFromPath(fs, legacyPath, name, legacyServersKey, legacyServersKeyIsLiteral);
      }
      // Same for companions — they outrank canonical on read, a stale copy would win
      for (const companionPath of shape.companionReadPaths ?? []) {
        await removeFromPath(fs, companionPath, name);
      }
    },
  };
}

// ── Per-provider adapters ───────────────────────────────────────────────────

/** Passthrough adapter — agent uses canonical format (mcpServers JSON key). */
export function passthroughMcpAdapter(configPath: string, legacyReadPaths?: string[]) {
  return createMcpAdapter({
    configPath,
    legacyReadPaths,
    format: 'json',
    serversKey: 'mcpServers',
    toNative(s) {
      const { name: _n, ...rest } = s;
      return rest as Record<string, unknown>;
    },
    fromNative(name, raw) {
      return { name, ...raw } as McpServerRegistration;
    },
  });
}

/** 一份 JSON(C) 配置读成对象;不在 = null,读不懂照原样抛(调用方决定它算「读不懂的文件」还是「那一层没有」)。 */
export async function readJsoncObject(fs: PluginFs, path: string): Promise<Record<string, unknown> | null> {
  const content = await fs.read(path);
  if (!content) return null;
  return parseMcpFile(content, 'json');
}
