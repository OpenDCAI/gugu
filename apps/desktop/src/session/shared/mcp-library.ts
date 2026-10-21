import z from 'zod';

/**
 * 资源库 → MCP:咕咕自己管的那份 MCP 列表(owner 10-18「仿照 aionui 的那种管理机制」)。
 *
 * 每台机器一份(存在那台机器的咕咕数据库里);新建任务时勾选带哪几台,勾上的经会话能力包送进任务
 * (`owner: 'integration'`,与资源库里连上的服务同一层)。各家自己的配置文件咕咕照旧只读不写。
 */

export const libraryMcpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

/**
 * 检测失败的原因,按类给(界面出中英文案,照 AionUi:缺命令 / 退出 / 超时 / HTTP / 配置可能有误);
 * 异常原文进日志,❌ 端给人看。`said` 是 server 自己在 stderr 上说的最后一行 —— 它自己的话,原样给。
 */
export const libraryMcpFailureSchema = z.object({
  kind: z.enum(['command-not-found', 'permission-denied', 'exited', 'timeout', 'http', 'unreachable']),
  command: z.string().optional(),
  code: z.number().optional(),
  status: z.number().optional(),
  said: z.string().optional(),
});

/** 手动「检测连接」的结果 —— 那一刻的读数,❌ 不是任务里的实时状态。 */
export const libraryMcpCheckSchema = z.object({
  status: z.enum(['ok', 'failed', 'needs-login']),
  /** ISO 时间。 */
  at: z.string(),
  tools: z.array(libraryMcpToolSchema),
  failure: libraryMcpFailureSchema.optional(),
});

export const libraryMcpServerSchema = z
  .object({
    /** 唯一;也是送进任务时的 server 名,任务按它记选了哪几台 ⇒ 建好以后不改名。 */
    name: z.string().trim().min(1),
    transport: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().optional(),
    /** 只认 `Authorization`:会话能力包送 http server 时只带这一个头(capability-bundle 的转换)。 */
    headers: z.record(z.string(), z.string()).optional(),
    /** 新建任务时默认勾上。 */
    enabledByDefault: z.boolean(),
    check: libraryMcpCheckSchema.optional(),
  })
  .superRefine((server, ctx) => {
    if (server.transport === 'stdio' && !server.command?.trim()) {
      ctx.addIssue({ code: 'custom', message: `MCP '${server.name}' is stdio but has no command` });
    }
    if (server.transport === 'http') {
      if (!server.url?.trim()) ctx.addIssue({ code: 'custom', message: `MCP '${server.name}' is http but has no url` });
      const others = Object.keys(server.headers ?? {}).filter((name) => name.toLowerCase() !== 'authorization');
      if (others.length > 0) {
        ctx.addIssue({ code: 'custom', message: `MCP '${server.name}' has unsupported headers: ${others.join(', ')}` });
      }
    }
  });

export const libraryMcpServersSchema = z.array(libraryMcpServerSchema);

export type LibraryMcpTool = z.infer<typeof libraryMcpToolSchema>;
export type LibraryMcpCheck = z.infer<typeof libraryMcpCheckSchema>;
export type LibraryMcpFailure = z.infer<typeof libraryMcpFailureSchema>;
export type LibraryMcpServer = z.infer<typeof libraryMcpServerSchema>;

/**
 * 咕咕自己每条会话都送的那几台的名字(`gugu`、浏览器那台)—— 资源库里不许叫这几个(单测钉着它们与宿主常量一致)。
 * App、集成的名字随装随变,加的时候判不全,由送进会话时的撞名检查兜(撞了就那一台留在外面,任务照常起)。
 */
export const GUGU_RESERVED_MCP_NAMES = ['gugu', 'gugu-browser'] as const;

/** 会话里判重的那个「派生 env 后缀」:名字只差标点的两台,送进会话时是同一个变量名。 */
export const mcpEnvSuffix = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();

export type LibraryMcpConflict = { code: 'reserved-name' } | { code: 'same-env-suffix' | 'same-url'; with: string };

/** 这一台和资源库里别的那几台(不含它自己)撞不撞;撞了,送进会话时就有一台会被留在外面。 */
export function libraryMcpConflict(
  server: Pick<LibraryMcpServer, 'name' | 'url'>,
  others: readonly Pick<LibraryMcpServer, 'name' | 'url'>[]
): LibraryMcpConflict | null {
  const suffix = mcpEnvSuffix(server.name);
  if (GUGU_RESERVED_MCP_NAMES.some((name) => mcpEnvSuffix(name) === suffix)) return { code: 'reserved-name' };
  const sameSuffix = others.find((other) => other.name !== server.name && mcpEnvSuffix(other.name) === suffix);
  if (sameSuffix) return { code: 'same-env-suffix', with: sameSuffix.name };
  const sameUrl = server.url ? others.find((other) => other.name !== server.name && other.url === server.url) : undefined;
  if (sameUrl) return { code: 'same-url', with: sameUrl.name };
  return null;
}

/**
 * 本机装了的那一家**自己的**用户级配置里的一台(owner 10-18「用户全局配置直接和咕咕的共存」)。
 * 只读:由那一家自己加载,咕咕不改、不删、不关;资源库里与咕咕的那几台并排列出,可以检测。
 */
export interface LibraryMcpHarnessServer {
  providerId: string;
  server: Omit<LibraryMcpServer, 'enabledByDefault' | 'check'>;
}

/** 读不成的原因;界面按它出文案(中英两份),`detail` 是解析器的原话。 */
export type LibraryMcpParseProblemCode =
  | 'invalid-json'
  | 'empty'
  | 'no-name'
  | 'not-object'
  | 'duplicate'
  | 'sse-unsupported'
  | 'no-command-or-url'
  | 'unsupported-headers';

export type LibraryMcpParseResult = {
  servers: Omit<LibraryMcpServer, 'enabledByDefault' | 'check'>[];
  /** 读不成的那几条;整段读不成时名字为空。 */
  problems: { name: string; code: LibraryMcpParseProblemCode; detail?: string }[];
};

class ParseProblem extends Error {
  constructor(readonly code: LibraryMcpParseProblemCode, readonly detail?: string) {
    super(code);
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
const stringRecord = (value: unknown): Record<string, string> | undefined =>
  isObject(value) && Object.values(value).every((item) => typeof item === 'string')
    ? (value as Record<string, string>)
    : undefined;

/** 一台 server 的原生写法 → 咕咕的一条(Claude / Cursor / AionUi 通用的 `command` + `args` / `url` 写法)。 */
function entryFrom(name: string, raw: Json): LibraryMcpParseResult['servers'][number] {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined;
  if (typeof raw.command === 'string' && raw.command.trim()) {
    const args = strings(raw.args);
    const env = stringRecord(raw.env);
    return {
      name,
      transport: 'stdio',
      command: raw.command.trim(),
      ...(args && args.length > 0 ? { args } : {}),
      ...(env && Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof raw.cwd === 'string' && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
    };
  }
  const url = [raw.url, raw.httpUrl, raw.serverUrl].find((value): value is string => typeof value === 'string' && !!value.trim());
  if (url) {
    if (type === 'sse' || /\/sse\/?$/.test(url)) throw new ParseProblem('sse-unsupported');
    const headers = stringRecord(raw.headers);
    const others = Object.keys(headers ?? {}).filter((key) => key.toLowerCase() !== 'authorization');
    if (others.length > 0) throw new ParseProblem('unsupported-headers', others.join(', '));
    return { name, transport: 'http', url: url.trim(), ...(headers && Object.keys(headers).length > 0 ? { headers } : {}) };
  }
  throw new ParseProblem('no-command-or-url');
}

/**
 * 粘进来的 JSON → 几台 server。认三种写法(与 AionUi 一致):`{ "mcpServers": { 名字: {...} } }`、
 * 裸的 `{ 名字: {...} }`、数组 `[{ "name": ..., ... }]`。一条读不成只记进 `problems`,❌ 整段作废。
 */
export function parseLibraryMcpJson(text: string): LibraryMcpParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { servers: [], problems: [{ name: '', code: 'invalid-json' }] };
  }
  const entries: [string, unknown][] = Array.isArray(parsed)
    ? parsed.map((item, index): [string, unknown] => [isObject(item) && typeof item.name === 'string' ? item.name : `#${index + 1}`, item])
    : isObject(parsed)
      ? Object.entries(isObject(parsed.mcpServers) ? parsed.mcpServers : parsed)
      : [];
  if (entries.length === 0) return { servers: [], problems: [{ name: '', code: 'empty' }] };
  const result: LibraryMcpParseResult = { servers: [], problems: [] };
  const seen = new Set<string>();
  for (const [rawName, raw] of entries) {
    const name = rawName.trim();
    try {
      if (!name) throw new ParseProblem('no-name');
      if (!isObject(raw)) throw new ParseProblem('not-object');
      if (seen.has(name)) throw new ParseProblem('duplicate');
      result.servers.push(entryFrom(name, raw));
      seen.add(name);
    } catch (error) {
      if (!(error instanceof ParseProblem)) throw error;
      result.problems.push({ name, code: error.code, ...(error.detail ? { detail: error.detail } : {}) });
    }
  }
  return result;
}
