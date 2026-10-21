import { constants as fsConstants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentHomeSegments, type ResolvedAgentHome } from '../capabilities/config-root';
import type { AgentInjectionMode, AgentConfigRoot, NativeHome } from '../capabilities/session-bundle';
import type { PluginFs } from '../../runtime/fs';
import type { AgentHomeProvisioner } from '../plugin-host';
import { createLocalPluginFs } from './local-plugin-fs';
import { readJsonConfig, writeJsonConfig, writeTomlOverlay } from './hook-config';

/**
 * 把独立 home 的落盘侧接给 `AgentPluginHost`。**每个 node 侧 boot 都该用它** ——
 * 各自现搓一份的话,「影子 home 的 fs 锚在哪一层」这种细节会在两处慢慢分叉。
 *
 * 拿不到 `GUGU_HOME` 就返回 `undefined` = 整套不启用(见 `AgentHomeProvisioner` 的注释):
 * ❌ 不猜一个默认路径 —— 猜错了就是把用户的登录态复制到一个谁也不会去读的地方。
 */
export function createAgentHomeProvisioner(
  guguHome: string | undefined,
  osHomeDir: string,
  sourceEnv: Record<string, string | undefined>
): AgentHomeProvisioner | undefined {
  const root = guguHome?.trim();
  if (!root) return undefined;
  return {
    provision: async (providerId, injectionMode, spec) => {
      const home = resolveAgentHome({
        providerId,
        injectionMode,
        configRoot: spec,
        guguHome: root,
        osHomeDir,
        sourceEnv,
      });
      if (!home) return null;
      await ensureAgentHome(home);
      return home;
    },
    createFs: (fsRoot) => createLocalPluginFs(fsRoot),
  };
}

/**
 * 原生配置根的候选:环境变量那份在前、默认那份在后,去重。覆盖不是替换 —— 挪过家的机器上默认目录里
 * 还留着旧会话,扫记录的读者扫全部;只问「现在用哪一份」的读者取第一个。
 */
export function nativeHomeRoots(
  nativeHome: NativeHome,
  env: Record<string, string | undefined>,
  osHomeDir: string
): string[] {
  const roots: string[] = [];
  for (const root of [env[nativeHome.envVar]?.trim(), join(osHomeDir, nativeHome.userPath)]) {
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

/**
 * 算出这一家的独立 home。**纯路径拼接** —— 不碰磁盘、不判存在。
 * 没声明 `configRoot` 的家返回 `null` = 沿用用户的配置根,咕咕不为它另持一份。
 *
 * ⚠️ 它住在 helpers(node 侧)而不是 `capabilities/config-root.ts`,是因为要用 `node:path`,
 *    而那个文件进渲染包 —— 理由钉在那边的注释里,❌ 别搬回去。
 */
export function resolveAgentHome(input: {
  providerId: string;
  /**
   * 这一家声明的注入方式。**只有 `'managed-config-root'` 才有独立 home** ——
   * 运行时注入的家在这里就返回 `null`，整份复制那条路它够不到（#4834）。
   * ⚠️ ❌ 别改成「有 configRoot 就算托管」:那正是被判过的隐式推导。
   */
  injectionMode: AgentInjectionMode;
  configRoot: AgentConfigRoot | undefined;
  guguHome: string;
  osHomeDir: string;
  /**
   * 用户自己的环境。⚠️ **要**读:`envVar` 在用户那边设了,就说明他**把自己那份挪过家了** ——
   * 复制的来源得跟着挪,否则咕咕会从一个空的 `~/.kimi-code` 复制,而用户真正的登录态在别处。
   * 这跟各家自己的解析式同形(kimi:`env['KIMI_CODE_HOME'] ?? join(osHomeDir, '.kimi-code')`)。
   */
  sourceEnv?: Record<string, string | undefined>;
}): ResolvedAgentHome | null {
  const spec = input.configRoot;
  if (input.injectionMode !== 'managed-config-root') {
    if (spec) {
      // fail loud:两个声明互相矛盾时,❌ 不许猜哪个是真的。
      throw new Error(
        `'${input.providerId}' 声明 injectionMode='${input.injectionMode}' 却又声明了 configRoot —— ` +
          `托管配置根只属于 'managed-config-root' 那一侧。删掉其一(见 product spec)。`
      );
    }
    return null;
  }
  if (!spec) {
    throw new Error(
      `'${input.providerId}' 声明 injectionMode='managed-config-root' 却没有 configRoot —— ` +
        `托管这一侧必须说清托管的是哪一份配置根。`
    );
  }
  if (!input.guguHome.trim()) {
    // fail loud:静默退回用户那份 = 登录写一处、会话读另一处,而两边都不报错。
    throw new Error(
      `独立 home 需要 GUGU_HOME:'${input.providerId}' 声明了 configRoot,但调用方没给咕咕的数据根`
    );
  }
  const segments = agentHomeSegments(input.providerId, spec.userPath);
  // 影子 home = 布局里除掉 userPath 那几段之后剩下的部分。
  const shadowSegments = segments.slice(0, 2);
  const shadowHome = join(input.guguHome, ...shadowSegments);
  const moved = input.sourceEnv?.[spec.envVar]?.trim();
  return {
    providerId: input.providerId,
    envVar: spec.envVar,
    shadowHome,
    configRoot: join(input.guguHome, ...segments),
    userConfigRoot: moved || join(input.osHomeDir, spec.userPath),
    carryExclusions: spec.carryExclusions.map((entry) => entry.path),
    seedFiles: (spec.seedFiles ?? []).map((seed) => ({ path: seed.path, content: seed.content })),
    firstRunState: spec.firstRunState ?? [],
  };
}

/** 复制的存根 —— 只为事后能查「这份是什么时候、从哪儿来的」,机制本身不读它。 */
export const AGENT_HOME_MARKER = '.gugu-agent-home.json';

export type AgentHomeSeed =
  /** 咕咕这份已经在了 —— 什么都没做。**这是绝大多数次调用的结果**。 */
  | 'already-present'
  /** 首次:从用户那份整份复制过来了。 */
  | 'copied'
  /** 首次,但用户那份不存在(没装过 / 没跑过)—— 只建了影子 home,让引擎自己初始化。 */
  | 'source-absent';

/**
 * 首次为这一家起会话/登录时,把用户那份配置根**整份复制**成咕咕自己的一份。
 *
 * ## 时机:「首次触碰」,不是「每次会话」,更不是「安装时」
 *
 *  · **每次会话都复制** ❌ —— 那不是分家,是每次把用户那边的状态盖回来,咕咕这边的
 *    登录/偏好/历史会被反复抹掉。
 *  · **安装时复制一次** ❌ —— 用户很可能是**装了咕咕之后**才去装 kimi、才去登录的;
 *    那时复制到的是空的,而真正有内容的那一刻永远等不到。
 *  · **首次触碰时复制** ✅ —— 判据是「咕咕这份在不在」:不在就复制,在就一个字节都不动。
 *    它天然幂等、天然是「用户第一次在咕咕里用这一家」的那一刻。
 *
 * 「触碰」= 起会话、点登录、读写这一家的 MCP/配置 —— 全都经 `AgentPluginHost`,
 * 由它 memo 一次(见 `plugin-host.ts` 的 `agentHomeOnce`)。
 *
 * ## 分家之后**永不**回头
 *
 * 复制过一次就再也不看用户那份。❌ 不比对、不合并、不补齐、不同步。用户之后在自己那份里
 * 做的事(换模型、重登、加 skill)咕咕这份**看不见**,反之亦然 —— 这正是「独立 home」要的:
 * 两份各自维护,所以不存在漂移。
 *
 * ## 判据是**存根**,不是「目录在不在」
 *
 * ⚠️ 这一条踩过:会话物化(`applySessionMaterialization`)会往咕咕这份配置根里写
 * `config.toml`,而它用的是 `mkdir -p` —— 于是「目录在不在」在**复制之前**就已经为真,
 * 用户的登录态、历史、skill 会**永远**等不到那次复制。而且这依赖两件事的先后顺序,
 * 顺序在五个调用点上各不相同、也没有判据看得住。
 *
 * ⇒ 判据换成 `.gugu-agent-home.json` 这个存根:它**只**由本函数在整份复制完成后写下。
 *   顺序依赖就此消失 —— 谁先谁后都不影响。
 *
 * ## 复制**不覆盖**已经在的文件
 *
 * 咕咕这份里可能已经有东西(引擎自己初始化的、或物化刚写的 config.toml)。复制只补
 * **缺的那些**,已有的一个字节不动 —— 否则「把物化刚写好的配置盖掉」就成了下一个静默 bug。
 * 因为不覆盖,重跑是幂等的,崩在半路下次接着补也安全。
 */
export async function ensureAgentHome(home: ResolvedAgentHome): Promise<AgentHomeSeed> {
  const marker = join(home.shadowHome, AGENT_HOME_MARKER);
  if (await pathExists(marker)) {
    // ⚠️ 种子文件**每次都补缺**,不只首次 —— 它与「分家之后不回头」不冲突:回头看的是
    //    **用户那份**,而种子写的是咕咕自己这份,且已存在就一个字节不动。
    //    2026-08-31 owner 真撞到:他那份 home 建于种子机制**之前**,于是这一维永远等不到,
    //    kimi 照旧问他要不要迁移(而那个问题的默认答案会盖掉咕咕的模型配置)。
    //    只在首次写 = 这个能力对**所有存量 home** 恒不生效,而存量 home 正是全部用户。
    await writeSeedFiles(home);
    return 'already-present';
  }

  await fs.mkdir(home.shadowHome, { recursive: true });

  if (!(await pathExists(home.userConfigRoot))) {
    // ⚠️ 这里**不建**配置根本身:用户可能只是还没装这一家,建了只是个空壳。
    //    留给引擎自己 mkdir —— 它本来就会。父目录建好是为了它 mkdir 得下去。
    //    ❌ 也**不写**存根:没复制成任何东西,下次用户装好跑过之后还得再来一次。
    return 'source-absent';
  }

  // 只补缺的,不覆盖已有的(见抬头)。带完才写存根 —— 崩在半路下次接着补。
  //
  // ⚠️ **默认全带,只跳过这一家声明为「不是配置」的那些**(`carryExclusions`)。
  //    先做过反过来的版本(由各家挑选要带哪些),被判否 —— 失败方向错了那一边:
  //    漏排一个缓存目录只是多占点盘(可测量、可回收),漏挑一个配置条目是**静默丢用户设置**。
  //    而引擎的配置面由上游定义、随版本增删,白名单结构上跟不上。判否的实证:
  //    第一版按 mac1 那台的目录布局挑清单,漏了 `skills/`/`AGENTS.md`/`SYSTEM.md`/`agents/`
  //    —— 它们只在用户用过那个功能后才存在。
  //
  // ⚠️ 「托管 ⇒ 必带走,没有第三种形态」(owner 2026-09-03)在这个方向上天然成立:
  //    默认全带,排除清单只能减去派生物。
  await copyTree(home.userConfigRoot, home.configRoot, 0, {
    copied: 0,
    root: home.userConfigRoot,
    skip: new Set(home.carryExclusions),
  });
  await writeSeedFiles(home);
  await writeMarker(home, 'copied');
  return 'copied';
}

/** Apply descriptor-declared dynamic trust/onboarding state through the shared write port. */
export async function applyAgentFirstRunState(
  home: ResolvedAgentHome,
  fs: PluginFs,
  cwd: string
): Promise<void> {
  for (const state of home.firstRunState ?? []) {
    const path = typeof state.relPath === 'function'
      ? state.relPath({ cwd, homeRoot: home.configRoot })
      : state.relPath;
    const entries = state.entries({ cwd, homeRoot: home.configRoot });
    if (state.format === 'json') {
      const current = await readJsonConfig(fs, path, 'user');
      await writeJsonConfig(fs, path, mergeStateEntries(current, entries), 'user');
      continue;
    }
    if (state.format === 'toml') {
      await writeTomlOverlay(fs, path, entries);
      continue;
    }
    const raw = (await fs.read(path)) ?? '';
    const lines = raw.length > 0 && !raw.endsWith('\n') ? `${raw}\n` : raw;
    const additions = Object.entries(entries)
      .filter(([key]) => !raw.split(/\r?\n/).includes(key))
      .map(([key, value]) => (value === true ? key : `${key}: ${String(value)}`))
      .join('\n');
    if (additions) await fs.write(path, `${lines}${additions}\n`);
  }
}

function mergeStateEntries(
  current: Record<string, unknown>,
  entries: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...current };
  for (const [key, value] of Object.entries(entries)) {
    const existing = out[key];
    if (Array.isArray(existing) && Array.isArray(value)) {
      out[key] = [...new Set([...existing, ...value])];
    } else if (isRecord(existing) && isRecord(value)) {
      out[key] = mergeStateEntries(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 递归复制。**软链一律解引用成真实内容** —— 保留软链就等于没分家:
 * 用户把 `config.toml` 软链到别处时,咕咕写 hook 会**穿过软链改到用户的真文件**上,
 * 那正是 codex 那条注释点名禁掉的绷带。
 *
 * ⚠️ 断链(指向不存在的东西)**跳过**:它本来就没有内容可复制。
 * ⚠️ 深度封顶 —— 软链解引用之后目录环是可能的,不封顶就是无限递归。撞顶 fail loud,
 *    ❌ 不静默截断(那会造出一份**缺东西**的配置根,而它长得跟完整的一样)。
 * ⚠️ **体量也封顶**,理由见 `MAX_COPY_BYTES`:深度那一维拦不住「又宽又浅」的来源。
 */
const MAX_COPY_DEPTH = 32;

/**
 * 一份独立 home 允许复制的**总字节数**上限。
 *
 * ## 为什么深度封顶不够(2026-09-03 P0,owner 的 MBP 只剩 172 MB)
 *
 * mimocode 当时声明 `userPath: '.'` = 整个 `$HOME`。而咕咕的数据根就在 HOME 里面 ⇒ 复制的目标
 * 是来源的子目录 ⇒ **自我嵌套**。深度闸确实会响,但它响在**磁盘已经被撑爆之后** —— 它限的是
 * 递归层数,而自我嵌套下「层数」与「体量」是指数关系:实测单个 agent tier 43 GB
 * (mimocode 34 GB + codex 8.8 GB + claude 810 MB + kimi 178 MB),而每条并行 agent lane 一个 tier,
 * 机器盘按 lane 数线性烧穿,mac1 那样的 16 槽 CI 机同样中招。
 *
 * ⇒ 加一条**与深度正交**的闸:按已复制字节数封顶,撞顶 **fail loud**。
 *
 * ⚠️ 判据是「这一家归错侧了」,不是「这台机器盘小」—— 所以文案指向声明,不指向磁盘。
 * ⚠️ ❌ 不静默截断、❌ 不跳过大文件:半份配置根会冒充完整的一份(与深度闸同一条纪律)。
 * ⚠️ 阈值取 2 GiB:全仓今天唯一还在托管侧的 kimi 实测 178 MB,留一个数量级余量;
 *    真有一家正当地需要超过 2 GiB,那是**产品决定**,回到 owner,❌ 不由这一层悄悄放宽。
 */
const MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;

async function copyTree(
  src: string,
  dest: string,
  depth: number,
  budget: { copied: number; root: string; skip: ReadonlySet<string> },
  /** 相对配置根的路径(`/` 分隔),根本身是 `''` —— 判 `carryExclusions` 用的就是它。 */
  rel = ''
): Promise<void> {
  // 声明为「不是用户配置」的条目:**整棵跳过**,连 stat 都不做。
  // ⚠️ 判在最前面 —— 派生物目录动辄几十万条目,先 stat 再判等于白走一趟。
  if (rel !== '' && budget.skip.has(rel)) return;
  if (depth > MAX_COPY_DEPTH) {
    throw new Error(
      `独立 home 复制深度超过 ${MAX_COPY_DEPTH} 层(${src}) —— 多半是软链成环。` +
        `请先修好来源目录,❌ 咕咕不会截断复制:半份配置根会冒充完整的一份。`
    );
  }
  // `stat`(而非 `lstat`)= 跟着软链走,拿到它指向的真实类型。
  const stats = await fs.stat(src).catch((error: unknown) => {
    if (isEnoent(error)) return null; // 断链:没内容可复制,跳过
    throw error;
  });
  if (!stats) return;


  if (stats.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);
    for (const entry of entries) {
      await copyTree(join(src, entry), join(dest, entry), depth + 1, budget, rel ? `${rel}/${entry}` : entry);
    }
    return;
  }
  if (!stats.isFile()) return; // socket / fifo / 设备:不是配置,不复制
  budget.copied += stats.size;
  if (budget.copied > MAX_COPY_BYTES) {
    throw new Error(
      `独立 home 复制体量超过 ${Math.round(MAX_COPY_BYTES / 1024 / 1024)} MiB(来源 ${budget.root})` +
        ` —— 这一家多半归错了侧:托管配置根是给「上下文类配置只能落文件」的家用的,` +
        `不是给一整棵家目录用的。请核对它的 injectionMode 与 configRoot.userPath(见 #4834),` +
        `❌ 咕咕不会截断复制:半份配置根会冒充完整的一份。`
    );
  }
  // `COPYFILE_EXCL` = 目标已在就**不动它**(抛 EEXIST,这里咽掉)。
  // 咕咕这份里已经有的东西(引擎初始化的、物化刚写的 config.toml)优先级更高。
  await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return;
    throw error;
  });
}

/**
 * 把这一家声明的种子文件写进咕咕这份配置根 —— **只在首次铺的时候**,且已存在就不动。
 *
 * 为什么需要它:引擎的「首次运行」询问按**目标目录**记账,而咕咕这份是个新目标,于是
 * 那些问题会在独立 home 里重新问一遍;而默认答案往往是错的 —— kimi 的
 * 「Migrate from kimi-cli」默认停在「Migrate now」,选下去就是拿用户的旧 kimi-cli 配置
 * 盖掉咕咕刚写好的平台模型(实测:选「Never ask again」时 kimi 自己在**咕咕这份**
 * 配置根里写下一个零字节的 `.skip-migration-from-kimi-cli`,用户真 home 那份记录一字未动)。
 *
 * ⚠️ 内容由**各家自己声明**(`AgentConfigRoot.seedFiles`),这一层不认识任何一家的文件名 ——
 *    独立 home 不会只有 kimi 一家用。
 * ⚠️ 已存在就跳过:用户可能自己改过它,咕咕这份分了家之后就归他管。
 */
async function writeSeedFiles(home: ResolvedAgentHome): Promise<void> {
  for (const seed of home.seedFiles) {
    const target = join(home.configRoot, seed.path);
    await fs.mkdir(dirname(target), { recursive: true });
    // `wx` = 存在就抛 EEXIST(咽掉)。与 copyTree 的 `COPYFILE_EXCL` 同一条纪律:只补缺的。
    await fs.writeFile(target, seed.content, { flag: 'wx' }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return;
      throw error;
    });
  }
}

async function writeMarker(home: ResolvedAgentHome, seed: AgentHomeSeed): Promise<void> {
  const marker = {
    providerId: home.providerId,
    envVar: home.envVar,
    configRoot: home.configRoot,
    copiedFrom: seed === 'copied' ? home.userConfigRoot : null,
    seed,
    // ⚠️ 只是存根。机制**不读**它 —— 判据始终是「配置根在不在」。
    note: '咕咕为这一家持有的独立 home。与用户那份已分家:不同步、不合并、不回读。',
  };
  await fs
    .writeFile(join(home.shadowHome, AGENT_HOME_MARKER), `${JSON.stringify(marker, null, 2)}\n`)
    // 存根写不下去不该拦住会话 —— 它只是给人看的。
    .catch(() => {});
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (error: unknown) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}
