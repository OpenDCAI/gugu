import { sessionConfigStateSchema, type SessionConfigState } from '@gugu/session-core/acp';
import type {
  SessionOptionDimension,
  SessionOptionGroup,
  SessionpageSessionOptions,
} from '@gugu/session-core/session-record/contract';
import { ReplicaState } from '@gugu/session-wire';
import { z } from 'zod';
import { peekAcpRuntimeClient } from '@main/core/acp/runtime-process/host';
import { sessionPlatformModel } from '@main/core/sessions/platform-model-selection';
import { recordLiveModelSwitch } from '@main/core/sessions/live-model-switch';
import { recordLiveSessionSetting } from '@main/core/sessions/record-live-session-setting';
import { log } from '@main/lib/logger';
import { platformModelIdFromNativeOption } from '@shared/platform-model-id';

/**
 * 会话选项（权限档 / 模型 / 推理档）—— 与待答审批同一个道理：**不在会话记录里**。
 *
 * 记录里躺着的是已经发生过的事；「这条会话此刻能选哪几档、现在选的是哪一档」是活运行时
 * 手里的状态（ACP 的 `session/new` 报 modes、unstable 通道报 configOptions），只有连着的那个
 * 客户端看得见。所以手机要改选项，只能经宿主问活运行时。
 *
 * ⚠️ 同样用 `peekAcpRuntimeClient()`：`getAcpRuntimeClient()` 会**为了看一眼把运行时进程拉起来**。
 * 进程没起来 ⇒ 这台机器上没有活着的 ACP 会话 ⇒ 没有任何可改的选项，把进程叫起来只是为了
 * 让它回答「没有」。
 */

export class SessionOptionsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SessionOptionsError';
    this.code = code;
  }
}

function toGroup(
  source: { selected: string | null; available: ReadonlyArray<{ id: string; name: string; description?: string }> } | null
): SessionOptionGroup | null {
  if (!source) return null;
  if (source.available.length === 0) return null;
  return {
    selected: source.selected,
    available: source.available.map((choice) => ({
      id: choice.id,
      name: choice.name,
      ...(choice.description !== undefined ? { description: choice.description } : {}),
    })),
  };
}

export function toSessionOptions(config: SessionConfigState): SessionpageSessionOptions {
  return {
    mode: toGroup(config.modeOptions),
    model: toGroup(config.modelOptions),
    effort: toGroup(config.efforts),
  };
}

/**
 * 与活运行时打交道的那两件事。抽成一个可替换的实现 —— 与仓里 `setSessionTimelineFactory`
 * 同一种做法：这条路上的守卫（值必须在可选清单里、改完要回读）只有在能捏住运行时应答时
 * 才验得动，而真运行时会把整个 ACP 宿主拖进来。❌ 不是产品内测试探针：产品路径走的
 * 永远是下面那份默认实现。
 */
export type SessionOptionsIo = {
  readConfig(conversationId: string): Promise<SessionConfigState>;
  apply(input: {
    conversationId: string;
    dimension: SessionOptionDimension;
    value: string;
  }): Promise<{
    success: boolean;
    /** 运行时的落定结局 —— 只有 `applied` 才写回会话记录(见 persistAppliedOption)。 */
    data?: { status: string; effectiveValue?: string };
    error?: { type: string; message?: string };
  }>;
};

let io: SessionOptionsIo | null = null;

export function setSessionOptionsIo(next: SessionOptionsIo | null): void {
  io = next;
}

function currentIo(): SessionOptionsIo {
  return io ?? defaultIo;
}

/**
 * 一次性读一份当前配置。读完就把副本拆掉 —— 这是问一句，不是订一条流。
 *
 * 读之前**先问这条会话在不在跑**：运行时只给活着的会话开 `session.config` 这条状态通道，
 * 对一条早就结束的会话直接去订，拿到的是 `Unknown live topic 'session.config|…'` ——
 * 那串东西会原样出现在手机屏幕上（实测），既看不懂，也把内部主题名泄了出去。
 * 真相很简单：**这条会话没在跑，所以没有选项可改**。
 */
async function readConfig(sessionId: string): Promise<SessionConfigState> {
  const client = await peekAcpRuntimeClient();
  if (!client) {
    // fail loud：区别于「有运行时、但这条会话什么都不可改」（那种回三个 null）。
    throw new SessionOptionsError('session_not_live', '这台机器上没有活着的 ACP 会话，改不了选项');
  }

  // 先看这条会话此刻的 lifecycle。`sessions.list` 里**有记录 ≠ 还活着** —— 已经结束的会话
  // 同样留在这张表里，只是 lifecycle 变成 closed（实测：拿「有没有记录」当判据会一路放行）。
  const live = new ReplicaState<Record<string, { lifecycle?: string }>>(
    client.sessions.state(undefined, 'list'),
    { schema: z.record(z.string(), z.object({ lifecycle: z.string().optional() }).passthrough()) }
  );
  try {
    await live.ready;
    const lifecycle = live.current()[sessionId]?.lifecycle;
    if (!lifecycle || lifecycle === 'closed') {
      throw new SessionOptionsError('session_not_live', '这条会话没在跑，跑起来才有选项可改');
    }
  } finally {
    live.dispose();
  }

  const replica = new ReplicaState<SessionConfigState>(
    client.session.state({ sessionId }, 'config'),
    { schema: sessionConfigStateSchema }
  );
  try {
    await replica.ready;
    return replica.current();
  } catch (error) {
    // 运行时对「没有活会话的那条 key」压根没注册主题，报的是
    // `Unknown live topic 'session.config|{...}'`。那串东西直接进了手机屏幕（实测），
    // 既看不懂又把内部主题名泄了出去 —— 它的真实含义就是上面那句人话。
    if (String((error as Error)?.message ?? error).includes('Unknown live topic')) {
      throw new SessionOptionsError('session_not_live', '这条会话没在跑，跑起来才有选项可改');
    }
    throw error;
  } finally {
    replica.dispose();
  }
}

const defaultIo: SessionOptionsIo = {
  readConfig,
  apply: async (input) => {
    const client = await peekAcpRuntimeClient();
    if (!client) {
      throw new SessionOptionsError('session_not_live', '这台机器上没有活着的 ACP 会话，改不了选项');
    }
    return input.dimension === 'mode'
      ? client.setModeOption({ sessionId: input.conversationId, value: input.value })
      : client.setModelOption({
          sessionId: input.conversationId,
          dimension: input.dimension,
          value: input.value,
        });
  },
};

export async function readSessionOptions(conversationId: string): Promise<SessionpageSessionOptions> {
  return toSessionOptions(await currentIo().readConfig(conversationId));
}

/**
 * 改一项。
 *
 * 改之前先核这一档**真的在可选清单里**：optionId 是 provider 自己的字符串，发一个它不认得的
 * 值过去，各家的表现从静默忽略到报一个看不懂的错都有 —— 而手机那头会显示成「改好了」。
 */
export async function setSessionOption(input: {
  conversationId: string;
  dimension: SessionOptionDimension;
  value: string;
}): Promise<SessionpageSessionOptions> {
  const ops = currentIo();
  const options = toSessionOptions(await ops.readConfig(input.conversationId));
  const group = options[input.dimension];
  if (!group) {
    throw new SessionOptionsError('option_unsupported', `这条会话没有可改的${input.dimension}`);
  }
  if (!group.available.some((choice) => choice.id === input.value)) {
    throw new SessionOptionsError('option_not_available', `${input.value} 不在可选清单里`);
  }

  const result = await ops.apply(input);
  if (!result.success) {
    throw new SessionOptionsError('set_option_failed', describeFailure(result.error));
  }
  if (result.data?.status === 'applied' && result.data.effectiveValue !== undefined) {
    await persistAppliedOption(input.conversationId, input.dimension, result.data.effectiveValue);
  }
  // 回读一份：provider 可能把这次切换归到另一档上（或者压根没接受）。
  // ❌ 不把入参当结果回给手机 —— 那是在报「我发出去了」，不是「它变成了什么」。
  return toSessionOptions(await ops.readConfig(input.conversationId));
}

function describeFailure(error: { type: string; message?: string } | undefined): string {
  // 原话优先,没有原话时至少把类型报出去 —— ❌ 不折成一句「改选项失败」:
  // 那样手机上看到的和什么都没说是一样的。
  if (!error) return '改选项失败（provider 没说原因）';
  return error.message ?? error.type;
}

/**
 * 手机上改的、provider 已确认生效的选项 → 会话记录。与会话页 composer 同一条纪律:
 * 不写回的话,下次重开按建会话时那一档重新下发,会话悄悄回退(权限会回退到更松的档)。
 *
 * 模型这一维要先知道**计费路**才写得对:平台模型的真值在 per-session 平台记录里,
 * harness 模型在 `config.model`。只在判得出的两种情况下写:
 *  · 会话明确跑在自家凭据上(平台记录为 `null`)⇒ 下发值就是 harness 模型 id;
 *  · 会话跑在平台上,且下发值带平台命名空间(`gugu-platform/<id>`)⇒ 它就是那条平台模型。
 * 其余(没做过决定、或平台会话上一个裸 id —— 可能是 harness 内置、网关白名单里没有的那种)
 * 这一侧判不出它是什么,猜错一次就是静默换计费路或重开时签不出票 ⇒ 只记一行,❌ 不猜。
 *
 * 写失败只记不抛:活会话上已经生效了,把一次成功的切换报成失败,手机会让用户再点一次。
 */
async function persistAppliedOption(
  sessionId: string,
  dimension: SessionOptionDimension,
  effectiveValue: string
): Promise<void> {
  try {
    if (dimension === 'mode') {
      await recordLiveSessionSetting(sessionId, { dimension: 'permission', modeId: effectiveValue });
      return;
    }
    if (dimension === 'effort') {
      await recordLiveSessionSetting(sessionId, { dimension: 'effort', value: effectiveValue });
      return;
    }
    const decision = await sessionPlatformModel(sessionId);
    if (decision === null) {
      await recordLiveModelSwitch({ sessionId, source: 'own', modelId: effectiveValue });
      return;
    }
    if (decision) {
      const modelId = platformModelIdFromNativeOption(effectiveValue);
      if (modelId) {
        await recordLiveModelSwitch({ sessionId, source: 'platform', modelId });
        return;
      }
    }
    log.warn('live-options: applied model change has no unambiguous billing route; record left unchanged', {
      conversationId: sessionId,
      effectiveValue,
      decided: decision !== undefined,
    });
  } catch (error) {
    log.warn('live-options: failed to record applied session option', { conversationId: sessionId, dimension, error });
  }
}

