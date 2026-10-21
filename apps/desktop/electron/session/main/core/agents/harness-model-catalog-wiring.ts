/**
 * 把模型目录模块接到主进程的真实设施上。
 *
 * 单独一个文件，是为了让 `harness-model-catalog.ts` 保持「只起进程 + 只说协议」——它一旦直接
 * import plugin-registry / settings / db，就会把 Electron `app` 与 drizzle 一起拽进来，单测当场
 * 崩在 `app.getPath`（上一版的实测教训）。脏活集中在这里，那边保持可在任何 node 环境下测。
 */
import { join } from 'node:path';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import { diskFileStamp } from '@gugu/session-core/exec';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { appSettings } from '@main/db/schema';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';
import type { AcpPlatformInjection } from '@gugu/session-core/acp';
import {
  setAcpSpawnResolver,
  setCatalogKeyResolver,
  setCatalogStore,
  setSpawnIdentityResolver,
  type AcpSpawnSpec,
} from './harness-model-catalog';
import { getPlugin } from './plugin-registry';
import { scrubCodexProbeTrustEntries } from './codex-probe-trust-scrub';
import { createLogger } from '../../../../lib/logger';

const log = createLogger('harness-model-catalog');

const STORAGE_KEY = 'harnessModelCatalogs';

let wired = false;

/**
 * 装配一次（幂等）。
 *
 * ❌ 不在模块顶层跑：那会让「import 这个文件」这一动作本身产生副作用，测试与工具脚本一旦
 * 顺带引到它就被迫连上 db。
 */
export function wireHarnessModelCatalog(): void {
  if (wired) return;
  wired = true;

  // 探针必须用**跑会话的那座桥**去探(#5050):桥入口由宿主按插件的 `acp.bridge` 声明解析,
  // 探针与会话都从 `AgentRunContext.acpAdapterEntry` 取同一个值(#6394),见下面的 resolveHarnessModelCatalogSpawn。

  // 起法完全交给插件自己声明的 `acp.buildSpawn` —— 它知道该用 adapter 包还是 harness 二进制
  // 原生 ACP、该注入哪些环境变量（CLAUDE_CODE_EXECUTABLE / GUGU_CODEX_BIN …）;桥的入口由宿主按 `acp.bridge` 声明解析好递进去。
  // ❌ 探测这边不复制任何一家的知识：复制一次就是又开一张会漂的表。
  setAcpSpawnResolver(resolveHarnessModelCatalogSpawn);

  // 「这一趟会跑哪一份东西」—— 与真起进程走**同一个**解析器(`resolveLocalAcpSpawnContext`),
  // 所以它认的身份和会话实际跑的那一份恒等;❌ 这边不另写一份「哪些东西算身份」的判据,
  // 复制一次就是又开一张会漂的表。
  setSpawnIdentityResolver(resolveHarnessSpawnIdentity);

  // 按腿分缓存只看声明(#6246):腿的配置根不同的家才分,其余两条腿共用一份 —— 否则每家多冷启一次。
  setCatalogKeyResolver(harnessCatalogKey);

  setCatalogStore({
    read: async () => {
      const [row] = await db
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, STORAGE_KEY))
        .execute();
      if (!row) return {};
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        // 「能 parse」不等于「形状对」。`as never` 会把契约在运行时抹掉：少了 `state` 的行一路
        // 走到 `isFresh` 读 `entry.state.kind` → TypeError → RPC 整个挂掉，而渲染层 retry:false
        // 于是每次启动都永远转「正在读取…」。逐行核形状，坏行**丢掉**而不是让它进来。
        // 缓存结构以后一改，盘上的旧行就正是这一类。
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(([, entry]) => {
            if (!entry || typeof entry !== 'object') return false;
            const e = entry as { state?: unknown; probedAt?: unknown };
            return (
              typeof e.probedAt === 'number' &&
              !!e.state &&
              typeof e.state === 'object' &&
              typeof (e.state as { kind?: unknown }).kind === 'string'
            );
          })
        ) as never;
      } catch {
        // 盘上那份坏了就当没有 —— 重探一次的代价是几秒，读到半份坏数据的代价是列错模型。
        return {};
      }
    },
    write: async (all) => {
      const serialized = JSON.stringify(all);
      await db
        .insert(appSettings)
        .values({ key: STORAGE_KEY, value: serialized })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: serialized } })
        .execute();
    },
  });
}

/**
 * 这家 harness 此刻的「跑哪一份」身份：解析出的可执行文件 + 它此刻指着的那份文件 + 递给子进程的那份 env。
 *
 * env 里就有 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 这类决定**读哪个配置根**(= 哪个账号)的变量,
 * 以及 `ANTHROPIC_BASE_URL` 这类决定**连哪儿**的变量 —— 它们和可执行文件一样,是模型目录的输入。
 *
 * 只有路径不够(#7081):就地升级路径不变 —— 原生安装器只改 `~/.local/bin/claude` 的软链接指向,
 * npm / brew 原地覆盖文件;而 harness 版本只在启动时探一次,也认不出来。于是升级前那份清单
 * 靠 TTL 再活 12 小时。`diskFileStamp` 把「这条路径此刻是哪一份文件」并进来,一次 stat,不起进程。
 * 盖不住的:wrapper 脚本(`~/bin/claude` 里再 exec 真身)本身没变,那一类仍靠 TTL。
 *
 * ❌ 不走 `buildSpawn`:那要一个 cwd,而 cwd 每趟都是新建的临时目录、并不是身份的一部分。
 * 解析不出来(没装 / 运行时版本不兼容)返回 `null`,由调用方退回 TTL。
 */
export async function resolveHarnessSpawnIdentity(
  pluginId: string,
  leg: SessionpageLeg
): Promise<string | null> {
  try {
    const { resolveLocalAcpSpawnContext } = await import('../acp/transport/local-acp-process-host');
    const { cli, agentEnv } = await resolveLocalAcpSpawnContext(pluginId);
    // 键序不是语义:随手一个顺序变化不该被算成「换了一份东西」。
    const env = Object.entries({ ...agentEnv, ...legConfigRootEnv(pluginId, leg) })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return JSON.stringify({ cli, file: diskFileStamp(cli), env });
  } catch {
    return null;
  }
}

/**
 * #6264 探针以前漏进用户 codex 配置的信任条目,每个进程在第一次探 codex 之前清一次(见
 * codex-probe-trust-scrub.ts)。成本:读一个几百字节的文件;没得清就不写。
 * 清不掉只记日志 —— 它是旧账,❌ 拖垮这一次模型目录。
 */
let codexProbeTrustScrub: Promise<void> | null = null;
function scrubCodexProbeTrustOnce(env: Record<string, string | undefined>): Promise<void> {
  codexProbeTrustScrub ??= scrubCodexProbeTrustEntries(env)
    .then((removed) => {
      if (removed > 0) log.info({ removed }, 'removed stale gugu model-probe trust entries from codex config');
    })
    .catch((error: unknown) => {
      log.warn({ error: String(error) }, 'could not scrub gugu model-probe trust entries from codex config');
    });
  return codexProbeTrustScrub;
}

/** Catalog-only resolution. It never records startup diagnostics. */
export async function resolveHarnessModelCatalogSpawn(
  pluginId: string,
  leg: SessionpageLeg,
  cwd: string,
  /** 第二遍探测的占位平台载荷(codex 那族的信封);第一遍没有。 */
  probePlatform?: AcpPlatformInjection
): Promise<AcpSpawnSpec | 'not-found' | null> {
  let plugin;
  try {
    plugin = getPlugin(pluginId);
  } catch {
    return 'not-found';
  }
  const acp = plugin.behavior.acp;
  if (plugin.capabilities.acp.kind !== 'supported' || !acp) return null;

  const { resolveLocalAcpSpawnContext } = await import('../acp/transport/local-acp-process-host');
  const { cli, agentEnv, runContext } = await resolveLocalAcpSpawnContext(pluginId);
  if (pluginId === 'codex') await scrubCodexProbeTrustOnce(agentEnv);
  const spawn = acp.buildSpawn({
    cwd,
    env: agentEnv,
    cli,
    ...(probePlatform ? { platform: probePlatform } : {}),
    // 目录要从真会话会用的那份桥接里探(#6394),否则两边可以是两个桥接版本。
    ...(runContext.acpAdapterEntry ? { adapterEntry: runContext.acpAdapterEntry } : {}),
  });
  return {
    command: spawn.command,
    args: spawn.args,
    // 占位中转凭据的环境与 `_meta` **不在这里**叠 —— 它们住在宿主 bundle,由 `setProbePlatformEnvResolver`
    // 注入,在 `harness-model-catalog.ts` 的第二遍探测里合进来(平台载荷是插件 buildSpawn 的入参,所以走上面那格)。
    // 理由见那边抬头:会话页相对路径 import 宿主模块会被 esbuild 复制一份,
    // 模块级状态就此分家(extension-bridge-relay 的五个动词就是这么全坏的)。
    // 叠放顺序全产品只有一处(#5702):❌ 不写 `{ ...agentEnv, ...spawn.env }` ——
    // 那样这一家的独立配置根会被 provider 的同名命令 env 顶掉,探到的清单就是另一个账号的。
    // 声明了自有配置根的家,ACP 腿读的是那份根而不是用户的默认根 ⇒ 探 ACP 腿时指到同一处(#6211),
    // 叠在最上面,与真会话里物化器那份 env 的位置相同;探终端腿时不叠,读用户自己的根(#6246)。
    env: composeAgentSpawnEnv(runContext, {
      providerEnv: spawn.env,
      hostInjections: [legConfigRootEnv(pluginId, leg)],
    }),
    ...(acp.catalogProbeSessionMeta ? { sessionMeta: acp.catalogProbeSessionMeta } : {}),
  };
}

/**
 * 这条腿的会话读哪个配置根 —— 只有 ACP 腿可能被 descriptor `acpConfigRoot` 改到咕咕自有的根,
 * 与物化器读同一份声明。终端腿与不声明的家返回空:它们读的就是 run context 给的那份根
 * (pi 的终端腿自有 key 会话 = 用户自己的 `~/.pi/agent`)。
 */
function legConfigRootEnv(pluginId: string, leg: SessionpageLeg): Record<string, string> {
  if (leg !== 'acp') return {};
  const root = getPlugin(pluginId).capabilities.sessionBundle.acpConfigRoot;
  if (!root) return {};
  return { [root.envVar]: join(resolveGuguHome(), ...root.guguHomePath) };
}

/**
 * 目录缓存键:两条腿读的配置根不同(声明了 `acpConfigRoot`)才按腿分开,否则一家一份(#6246)。
 * 未知插件交给探针自己报 `not-installed`,这里不先判。
 */
export function harnessCatalogKey(pluginId: string, leg: SessionpageLeg): string {
  let declaresLegRoot = false;
  try {
    declaresLegRoot = !!getPlugin(pluginId).capabilities.sessionBundle.acpConfigRoot;
  } catch {
    return pluginId;
  }
  return declaresLegRoot ? `${pluginId}@${leg}` : pluginId;
}
