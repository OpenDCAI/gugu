import { isHarnessRuntimeMissing } from '@main/core/agents/ensure-agent-installed';
import { guguReasonInText } from '@gugu/session-core/session-record/contract';

/**
 * #6264 在这台机器上建会话 / 起会话失败时,原文 → 一个发起方认得出的原因码(`remoteFailureKind` 的输入)。
 *
 * 发起方(另一台桌面、手机)按原因码用自己的界面语言说人话;**原文只进这台机器的日志**。
 * 这里只认几类「人能照着做点什么」的失败,其余保持原来的码 —— 那一类在发起方统一说「没开起来,再试一次」。
 *
 * ⚠️ 按原文认人只在这一个地方:失败穿过 ACP 运行时进程时已经只剩一段文字(`JSON.stringify(error)`),
 * 没有别的结构可读。认错的代价是一句不够准的提示,❌ 不会改变任何行为(失败仍是失败)。
 */

/**
 * 连不上咕咕的模型服务:签平台额度那一趟(`model-access`)之外、没带原因码的网络原文 —— 这台机器上不了网、
 * 云端那一侧连不上网关(实测原文 `error sending request for url (http://gugu-newapi:3000/api/status) … dns error`)。
 * 只在**选了咕咕提供的模型**时才这么认:自带模型的会话不经过这一趟。
 */
const MODEL_SERVICE_UNREACHABLE =
  /model[- ]access|api\/status|error sending request for url|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo/i;

/** 这家 agent 在这台机器上没登录(claude 的原话是 `Not logged in · Please run /login`)。 */
const AGENT_SIGNED_OUT =
  /not logged in|please run \/login|auth(?:entication)?[_ ]required|invalid api key|unauthorized|\b401\b/i;

export const PLATFORM_MODEL_UNREACHABLE_CODE = 'platform_model_unreachable';
export const AGENT_SIGNED_OUT_CODE = 'agent_signed_out';

/** 这几个码的原文里才可能藏着上面几类(别的码本身已经说清楚了是哪一步)。 */
const CLASSIFIABLE = new Set([
  'model_rejected',
  'create_models_failed',
  'create_task_failed',
  'provision_failed',
  'session_start_failed',
  'send_failed',
]);

export function classifyCreateFailure(
  code: string,
  detail: string,
  context: { platformModel: boolean }
): string {
  if (isHarnessRuntimeMissing(detail)) return 'harness_runtime_missing';
  if (!CLASSIFIABLE.has(code)) return code;
  // 签咕咕额度被拒时宿主已经报了原因码(#7103):原样交给发起方,它按同一张原因表说话,❌ 一律说成「连不上」。
  const gugu = guguReasonInText(detail);
  if (gugu) return `gugu-models:${gugu}`;
  if (context.platformModel && MODEL_SERVICE_UNREACHABLE.test(detail)) return PLATFORM_MODEL_UNREACHABLE_CODE;
  if (AGENT_SIGNED_OUT.test(detail)) return AGENT_SIGNED_OUT_CODE;
  return code;
}
