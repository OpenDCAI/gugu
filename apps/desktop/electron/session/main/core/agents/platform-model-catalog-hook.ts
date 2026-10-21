// @@@4972 「咕咕提供的模型」在会话页这一侧的读取口 —— 与 emdash-platform-injector / emdash-pty-sessionpage-hook
// 同一个模式:这棵树拥有**钩子点**,咕咕宿主拥有**钩子返回什么**。
//
// 为什么必须是钩子:目录要账号态(签不签得出中转令牌)、引擎协议映射与会话页身份可寻址性,三样都住在
// 宿主 bundle(`sessionpage-platform-catalog.ts`)。会话页这边相对 import 过去会被 esbuild 复制一份、
// 模块级状态分家 —— `extension-bridge-relay` 就是这么把扩展的五个宿主动词全弄哑的。
//
// ⚠️ 宿主装的那一个,**就是 composer 那条 IPC 调的同一个函数**。这是本钩子存在的全部意义:
// agent 通过 `session_list_models` 看到的「咕咕提供的模型」,与用户在会话页 composer 下拉里看到的
// 那一组,是同一次计算的两个调用方 —— ❌ 不许在这一侧另算一份「哪些平台模型可用」。
//
// 没装钩子 → 平台那一组缺席,`session_list_models` 与改动前逐字节相同(只有 harness 自家模型)。

/** 问的是哪一格:某个引擎在某条腿上,咕咕的平台模型开了哪些。 */
export interface PlatformModelCatalogQuery {
  providerId: string;
  surface: 'acp' | 'tui';
}

export interface PlatformCatalogModel {
  /** `billing.platform_models.id`,如 `glm-5.2`。**不带** `platform:` 前缀。 */
  id: string;
  displayName: string;
  /** New API ModelRatio 的相对倍率,display-only;取不到 = null。 */
  creditMultiplier: number | null;
  contextWindow: number | null;
  /** 这个模型认的推理档(目录逐模型下发,#6447);null = 目录没有这条事实。 */
  reasoningEfforts: readonly string[] | null;
  /**
   * 这一档(免费档)用不了、要开会员(目录 `requires_membership`,#7056)。手机的模型菜单、
   * agent 的 `session_list_models` / `session_spawn` 都读它:列出来要说清,起会话要当场拒。
   */
  requiresMembership: boolean;
  /** 他在设置「模型」页关掉了这一条:手机的模型菜单不列它(#7056)。只管显示,❌ 不拦 agent 起会话。 */
  hidden: boolean;
}

export interface PlatformModelCatalogSnapshot {
  models: PlatformCatalogModel[];
  /**
   * 这一组取不到的原因(未登录 / 这家指不向中转 / 这条腿还没接通咕咕身份)。
   *
   * ❌ 空列表与「说得出口的原因」不是一回事。工具面必须能把后者原样转述给 agent ——
   * 否则「咕咕本来就没有模型」与「你这条腿用不了咕咕模型」在返回值里逐字节相同。
   */
  catalogError: string | null;
}

export type PlatformModelCatalogResolver = (
  query: PlatformModelCatalogQuery
) => Promise<PlatformModelCatalogSnapshot>;

let resolver: PlatformModelCatalogResolver | null = null;

export function setPlatformModelCatalogResolver(fn: PlatformModelCatalogResolver | null): void {
  resolver = fn;
}

export function getPlatformModelCatalogResolver(): PlatformModelCatalogResolver | null {
  return resolver;
}
