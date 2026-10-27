// @@@2503 composer 平台模型 — 会话创建时选的模型来源,记在会话上。
//
// composer 是会话的唯一决策点:选了「咕咕提供的模型」这次会话就上平台 relay,选了 harness 自家模型
// 就是纯 BYOK。这个决定必须**跟着会话活下去**(重启后重新 spawn 还要按它跑),所以创建时落库,
// spawn 时读回来交给宿主(见 emdash-pty-sessionpage-hook 的 platformModel 字段)。
//
// 存在 kv 表而不是 sessions.config:config 是一份 zod versioned schema,未声明的键在解析时会被
// 静默丢掉,而那份 schema 属于渲染层共享目录。kv 是会话页自己的既有 metadata 面(account / prompt-library
// / view-state 都用它),同一个 SQLite 文件、同一次备份,不需要迁移。

import { KV } from '@main/db/kv';
import { getPlatformModelCatalogResolver } from '@main/core/agents/platform-model-catalog-hook';

/** composer 的选择:平台模型 = {modelId};harness 自家模型 = null。 */
export type SessionPlatformModel = { modelId: string; label?: string } | null;

/** 包一层对象,是为了让「记过、选的是 harness(null)」和「压根没记过」在读回来时分得开。 */
type PlatformModelRecord = { platformModel: SessionPlatformModel };

const platformModelKV = new KV<Record<string, PlatformModelRecord>>('sessionpage-platform-model');

/**
 * 从创建会话的载荷里读出 composer 的选择。**三态**,三个都不一样:
 *
 * - 字段**不存在** → `undefined`:这条创建路径上根本没有 composer(自动化任务、会话管理 MCP 派生的
 *   子会话、导入)。「没人做过决定」≠「决定是 BYOK」—— 记成后者会把这些会话永久钉死在 BYOK,而它们
 *   本来该沿用 agent 级默认(改动前的行为)。所以什么都不记,交给回退。
 * - 字段为 `null` → `null`:用户在 composer 里**明确**选了 harness 自家模型。记下来,启动路径据此
 *   一个平台变量都不注入,即使 agent 级配着平台模型。
 * - 字段为对象 → 该平台模型。
 *
 * 字段在、但值不成形(空 modelId 之类)也归 `null`:客户端确实做了决定,只是坏了 —— 让一个坏掉的
 * 决定退化成「用 agent 的平台模型」是最不该有的解释。
 *
 * 结构化读取而不是依赖类型:载荷类型属于渲染层共享目录,这一侧只认字段形状。
 */
export function composerPlatformModel(params: unknown): SessionPlatformModel | undefined {
  if (!params || typeof params !== 'object' || !('platformModel' in params)) return undefined;
  const value = (params as { platformModel?: unknown }).platformModel;
  // 显式写成 undefined 与没写等价:createSession 的载荷过一遍 JSON 序列化,undefined 值本来就会被丢掉,
  // 两条路径必须给出同一个答案。
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') return null;
  const modelId = (value as { modelId?: unknown }).modelId;
  return typeof modelId === 'string' && modelId.trim() ? { modelId: modelId.trim() } : null;
}

// @@@2503 这里曾有一道创建期的墙:ACP(Chat UI)会话选了咕咕的模型就当场抛错,理由是平台额度只在
// pty 启动路径上注入,收下也不会生效。现在 ACP 启动链自己带注入了(主进程 ACP start 拦截处按会话签发,
// 经 `_meta` 送进适配器),这道墙就成了「把一条已经能跑的通路继续挡死」,故拆除。
//
// 拆掉的是**会话类型一刀切**,不是那道判据本身:「这个引擎的这个界面还没接线」由引擎注入契约在启动时
// 响亮判定(engine-injection-contract 的 wired),因为只有那里才知道 provider 是谁。放在这里判不了 ——
// 这一侧属于会话页后端那棵树,够不着咕咕根目录的契约表(两边是分开打包的,靠钩子相连)。

/**
 * 给这个会话记下选择。**只有 composer 真做过决定才记** —— 记录的有无就是「这条会话有没有过
 * composer 决策」:没有记录(存量会话、自动化任务、派生子会话)就回退 agent 级 model_access。
 */
export async function recordSessionPlatformModel(
  sessionId: string,
  platformModel: SessionPlatformModel
): Promise<void> {
  // setOrThrow:记不下就等于这次会话的选择丢了,下一次 spawn 会按存量会话回退到 agent 级配置 ——
  // 那是「选了 harness 却上了平台」的静默错模型。宁可让创建响亮失败。
  await platformModelKV.setOrThrow(sessionId, { platformModel });
}

/** 这个会话记下的选择;`undefined` = 没有记录(存量会话)。 */
export async function sessionPlatformModel(
  sessionId: string
): Promise<SessionPlatformModel | undefined> {
  const record = await platformModelKV.get(sessionId);
  return record ? record.platformModel : undefined;
}

/** 会话没了就把记录一起收掉(会话 id 不复用,留着只是垃圾)。 */
export async function forgetSessionPlatformModel(sessionId: string): Promise<void> {
  await platformModelKV.del(sessionId);
}

/**
 * The decided Gugu model's name as the model menu shows it, filled in on first read: the platform catalog is asked once
 * per session and model and the name kept beside the id. A new decision (a switch, a rollback) writes a record without it,
 * so a stale name goes with the old model. Null for an engine's own model, for one the catalog does not list (kept as
 * '', not asked again), or when the catalog cannot answer (nothing kept: the next read asks again). A name the platform
 * later changes shows until the model changes.
 */
export async function sessionModelLabel(sessionId: string, decision: SessionPlatformModel | undefined, providerId: string | null, runtime: string | null): Promise<string | null> {
  // '' is「asked, the catalog has no name for it」: kept too, so a model the catalog does not list is not asked again.
  if (!decision || decision.label !== undefined) return decision?.label || null;
  const resolver = getPlatformModelCatalogResolver();
  if (!resolver || !providerId || providerId === 'unknown') return null;
  const catalog = await resolver({ providerId, surface: runtime === 'acp' ? 'acp' : 'tui' }).catch(() => null);
  if (!catalog) return null;
  const label = catalog.models.find((entry) => entry.id === decision.modelId)?.displayName ?? '';
  const now = await sessionPlatformModel(sessionId);
  if (now?.modelId === decision.modelId) await platformModelKV.set(sessionId, { platformModel: { ...now, label } });
  return label || null;
}
