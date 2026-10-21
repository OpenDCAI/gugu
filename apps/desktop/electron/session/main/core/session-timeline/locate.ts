import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import type { SessionRecordHarness, SessionRecordLocator } from '@gugu/session-core/session-record';
import { piAgentDir } from '@gugu/session-plugins/agents/pi-agent-dir';
import { requireNativeHome } from '@gugu/session-plugins/agents';

/**
 * 会话行 → 「这份记录在哪」。**纯路径拼接**：不碰磁盘、不判存在 —— 存不存在归记录源，
 * 它才是那个要打开文件的人；这一层只负责把候选说全。
 *
 * ⚠️ 候选是**列表**不是一个：各家的环境变量都是「覆盖」而不是「替换」（把配置根挪过家的机器上，
 * 默认目录里往往还留着挪家之前的会话）。只猜一个 = 老会话在手机上静默消失，而两边都不报错。
 * 同一条判断在 `packages/core/src/local/agent/transcriptSources/*` 已经踩过一次，口径照抄那边。
 */

/** 「这一家的记录在哪」用到的环境：宿主进程的环境变量、OS home、咕咕自己的 home。 */
type Where = { env: Record<string, string | undefined>; home: string; guguHome: string };

/**
 * 一家的记录格式，以及这一家的记录在哪 —— 各家的差别全写在这一行上，候选由 `rootsOf` 一处拼。
 * 候选顺序对所有家一样：托管根 → 环境变量指的根(按 `envs` 的顺序)→ 默认根。
 */
type RecordFormatRow = {
  format: SessionRecordHarness;
  /** 把这一家的配置根挪走的环境变量，按序。`[变量, 一截]` = 根在 `$变量/一截`。 */
  envs: ReadonlyArray<string | readonly [string, string]>;
  /** 没设环境变量时的根。 */
  defaults: (where: Where) => string[];
  /** 每个根下面，记录在哪一截(目录或库文件)。 */
  sub: string;
  /** opencode 族(一份按安装通道分名的 sqlite 库)才有的几样。 */
  opencode?: {
    /** 库文件名 `<app>.db` 与通道库前缀(各家 `core/src/database/database.ts` 一类的取路径函数)。 */
    app: string;
    /** 整个指定库文件的环境变量：绝对路径就是它，相对路径相对数据目录。 */
    dbEnv: string;
    /** 设成 `true` / `1` 时库一律叫 `<app>.db`,不按安装通道分库。 */
    channelOffEnv: string;
    /** 只读这个 agent 的消息(见 locator 上的说明)。 */
    agentId?: string;
  };
};

/** opencode 族的一行：数据目录是 `$XDG_DATA_HOME/<app>` 或 `~/.local/share/<app>`(有 `homeEnv` 的家另认 `$homeEnv/data`)。 */
function opencodeRow(app: string, prefix: string, extra: { homeEnv?: string; agentId?: string } = {}): RecordFormatRow {
  return {
    format: 'opencode',
    envs: [...(extra.homeEnv ? [[extra.homeEnv, 'data'] as const] : []), ['XDG_DATA_HOME', app]],
    defaults: ({ home }) => [join(home, '.local', 'share', app)],
    sub: `${app}.db`,
    opencode: { app, dbEnv: `${prefix}_DB`, channelOffEnv: `${prefix}_DISABLE_CHANNEL_DB`, ...(extra.agentId ? { agentId: extra.agentId } : {}) },
  };
}

/** 记录在这一家原生配置根(插件声明的 `nativeHome`)下面的一行。 */
function nativeHomeRow(providerId: string, format: SessionRecordHarness, sub: string): RecordFormatRow {
  const { envVar, userPath } = requireNativeHome(providerId);
  return { format, envs: [envVar], defaults: ({ home }) => [join(home, userPath)], sub };
}

/**
 * provider → 记录格式。一行一家，格式相同的家共用一个解码器;❌ 不按名字形状推。只列已上架的家。
 * mimocode 是 opencode 的分支，库表核过(2026-10-17):多一列 `message.agent_id`。
 */
const RECORD_FORMAT_BY_PROVIDER: Readonly<Record<string, RecordFormatRow>> = {
  claude: nativeHomeRow('claude', 'claude', 'projects'),
  codex: nativeHomeRow('codex', 'codex', 'sessions'),
  copilot: nativeHomeRow('copilot', 'copilot', 'session-state'),
  hermes: nativeHomeRow('hermes', 'hermes', 'state.db'),
  // ↓ 以下几行的根不是这一家的配置根,留在这里:qwen 的记录在 runtime 目录(`Storage.getRuntimeBaseDir()`:
  //   `QWEN_RUNTIME_DIR` 优先，否则 `QWEN_HOME`,否则 `~/.qwen`);pi 的根归咕咕;opencode 族是 XDG 数据目录。
  qwen: { format: 'qwen', envs: ['QWEN_RUNTIME_DIR', 'QWEN_HOME'], defaults: ({ home }) => [join(home, '.qwen')], sub: 'projects' },
  // pi 的配置根由咕咕逐腿指定(`PI_CODING_AGENT_DIR`),两条腿各一份。
  pi: { format: 'pi', envs: [], defaults: ({ guguHome }) => (['tui', 'acp'] as const).map((surface) => piAgentDir(surface, guguHome)), sub: 'sessions' },
  opencode: opencodeRow('opencode', 'OPENCODE'),
  mimocode: opencodeRow('mimocode', 'MIMOCODE', { homeEnv: 'MIMOCODE_HOME', agentId: 'main' }),
};

function formatRowFor(provider: string | null | undefined): RecordFormatRow | null {
  const id = provider?.trim();
  if (!id) return null;
  return RECORD_FORMAT_BY_PROVIDER[id] ?? null;
}

/** opencode 族的开关怎么读(上游 `Flag` 的布尔读法):`true` / `1`,不分大小写。 */
function flagOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === 'true' || v === '1';
}

export type SessionRecordLocation =
  | { supported: true; locator: SessionRecordLocator }
  | { supported: false; reason: string };

export type LocateSessionRecordInput = {
  /** `sessions.provider`。 */
  provider: string | null | undefined;
  /** `sessions.provider_session_id` —— provider 自己的会话 id（codex 那边就是 thread id）。 */
  providerSessionId: string | null | undefined;
  /** 宿主进程的环境。缺省读 `process.env`。 */
  env?: Record<string, string | undefined>;
  /** OS home。缺省读 `os.homedir()`。 */
  homeDir?: string;
  /**
   * 咕咕替这一家托管的配置根（`resolveAgentHome().configRoot`）。
   * **今天表里各家都是 `injectionMode: 'runtime'`**，所以实际恒为 null；留着这一维是因为
   * 「某家改判成托管」是一次 descriptor 改动，那时记录会整份搬到托管 home 下，
   * 而这一层如果不认它，手机上会看到「会话在、时间线空」。
   */
  managedConfigRoot?: string | null;
};

export function sessionRecordHarnessForProvider(
  provider: string | null | undefined
): SessionRecordHarness | null {
  return formatRowFor(provider)?.format ?? null;
}

/** 保序去重并丢掉空串 —— 两个候选指向同一个目录时（`CLAUDE_CONFIG_DIR=~/.claude`）只留一份。 */
function candidates(paths: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const value = path?.trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

export function locateSessionRecord(input: LocateSessionRecordInput): SessionRecordLocation {
  const provider = input.provider?.trim() || '(未记录)';
  const row = formatRowFor(input.provider);
  if (!row) {
    return {
      supported: false,
      reason: `这家引擎（${provider}）的会话记录还没有接：本机记录只解码了 ${Object.keys(RECORD_FORMAT_BY_PROVIDER).join(' / ')}`,
    };
  }
  const providerSessionId = input.providerSessionId?.trim();
  if (!providerSessionId) {
    // 会话还没起过（`session_id` 只有 provider 真的开出会话之后才落库）—— 这不是「不支持这家」，
    // 但对读侧同样是「没有记录可读」，如实说出是哪一种。
    return {
      supported: false,
      reason: `这条会话还没有 provider 会话 id：${provider} 尚未真正开出会话，本机没有记录可读`,
    };
  }

  const env = input.env ?? process.env;
  const where: Where = { env, home: input.homeDir ?? homedir(), guguHome: resolveGuguHome(env) };
  const dirs = homesOf(row, where, input.managedConfigRoot?.trim() || null);
  if (!row.opencode) {
    return { supported: true, locator: { harness: row.format, providerSessionId, roots: dirs.map((dir) => join(dir, row.sub)) } };
  }

  // opencode 族：库文件名可以被 `<家>_DB` 整个指定(绝对路径排最前;相对路径换掉库名)。
  const { app, dbEnv: dbEnvName, channelOffEnv, agentId } = row.opencode;
  const dbEnv = env[dbEnvName]?.trim();
  const dbFile = dbEnv && !isAbsolute(dbEnv) ? dbEnv : row.sub;
  return {
    supported: true,
    locator: {
      harness: 'opencode',
      providerSessionId,
      ...(agentId ? { agentId } : {}),
      roots: candidates([dbEnv && isAbsolute(dbEnv) ? dbEnv : null, ...dirs.map((dir) => join(dir, dbFile))]),
      // 安装通道不是 latest / beta / prod 的构建把库叫 `<app>-<通道>.db`(上游 `getChannelPath`);
      // 通道是 harness 构建时定的，宿主不知道 ⇒ 交给记录源在这些目录里按名字认。
      ...(dbEnv || flagOn(env[channelOffEnv]) ? {} : { channelDbs: { app, dirs } }),
    },
  };
}

/** 一家的候选根：托管根 → 环境变量指的根(按序)→ 默认根，保序去重。 */
function homesOf(row: RecordFormatRow, where: Where, managed: string | null): string[] {
  const fromEnv = row.envs.map((entry) => {
    const [name, sub] = typeof entry === 'string' ? [entry, ''] : entry;
    const value = where.env[name]?.trim();
    return value ? join(value, sub) : null;
  });
  return candidates([managed, ...fromEnv, ...row.defaults(where)]);
}
