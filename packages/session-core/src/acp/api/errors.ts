import type { Serializable } from '@gugu/session-shared';
import { z } from 'zod';

/**
 * ⚠️ `data` 与 `code` 这两格**必须在** —— 少了它们,zod 会在**过线时把它们剥掉**。
 *
 * 出口校验在 dev 是 `'full'`、在生产是 `'inputs'`(见 acp runtime-process host)⇒ 少写这两格的话,
 * 「发送失败」那条 toast 在 `pnpm dev` 下只剩一句 message,而在打好的包里是完整的
 * 「message + code=… + 结构化负载」。**同一次失败在两种构建下说两句不同的话**,
 * 而这张票(#5858)的 A/B 读数恰恰要在 dev 上能复现。
 */
export const serializedErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  // `z.custom<Serializable>()` 而不是 `z.unknown()`:后者推出来的 `data` 是 `unknown`,
  // 与 `SerializedError.data`(`Serializable | undefined`)不兼容,消费方会整条类型不匹配。
  // 这里不做深校验 —— `toSerializedError` 在 catch 边界上已经只收一层原始值(见那一处注释)。
  data: z.custom<Serializable>().optional(),
  code: z.union([z.number(), z.string()]).optional(),
});

const plainTagErrorSchema = <T extends string>(type: T) =>
  z.object({ type: z.literal(type), message: z.string().optional() });

const failedErrorSchema = <T extends string>(type: T) =>
  z.object({
    type: z.literal(type),
    message: z.string().optional(),
    cause: serializedErrorSchema.optional(),
  });

export const providerUnsupportedErrorSchema = plainTagErrorSchema('provider_unsupported');
export const sessionNotFoundErrorSchema = plainTagErrorSchema('conversation_not_found');
export const invalidStateErrorSchema = plainTagErrorSchema('invalid_state');
export const sessionBusyErrorSchema = plainTagErrorSchema('session_busy');
export const spawnFailedErrorSchema = failedErrorSchema('spawn_failed');
export const initializeFailedErrorSchema = failedErrorSchema('initialize_failed');
export const newSessionFailedErrorSchema = failedErrorSchema('new_session_failed');
export const authRequiredErrorSchema = failedErrorSchema('auth_required');
export const providerSessionMissingErrorSchema = failedErrorSchema('provider_session_missing');
export const promptFailedErrorSchema = failedErrorSchema('prompt_failed');
export const cancelFailedErrorSchema = failedErrorSchema('cancel_failed');
export const stopFailedErrorSchema = failedErrorSchema('stop_failed');
export const stopTaskFailedErrorSchema = failedErrorSchema('stop_task_failed');
export const setConfigFailedErrorSchema = failedErrorSchema('set_config_failed');
export const setModeFailedErrorSchema = failedErrorSchema('set_mode_failed');

export const acpStartSessionErrorSchema = z.union([
  providerUnsupportedErrorSchema,
  authRequiredErrorSchema,
  providerSessionMissingErrorSchema,
  spawnFailedErrorSchema,
  initializeFailedErrorSchema,
  newSessionFailedErrorSchema,
  // #5047 the composer's model cannot be applied on the live connection — a start failure.
  setConfigFailedErrorSchema,
  invalidStateErrorSchema,
]);
export const acpResumeSessionErrorSchema = acpStartSessionErrorSchema;
export const acpStopSessionErrorSchema = stopFailedErrorSchema;
export const acpSendPromptErrorSchema = z.union([
  sessionNotFoundErrorSchema,
  invalidStateErrorSchema,
  sessionBusyErrorSchema,
  promptFailedErrorSchema,
]);
export const acpQueuePromptErrorSchema = z.union([
  sessionNotFoundErrorSchema,
  invalidStateErrorSchema,
]);
export const acpEditQueuedPromptErrorSchema = acpQueuePromptErrorSchema;
export const acpDeleteQueuedPromptErrorSchema = acpQueuePromptErrorSchema;
export const acpChangeQueuePromptOrderErrorSchema = acpQueuePromptErrorSchema;
export const acpSteerQueuedPromptErrorSchema = acpSendPromptErrorSchema;
export const acpResolvePermissionErrorSchema = acpQueuePromptErrorSchema;
export const acpSetPromptDraftErrorSchema = sessionNotFoundErrorSchema;
export const acpCancelTurnErrorSchema = z.union([invalidStateErrorSchema, cancelFailedErrorSchema]);
export const acpStopBackgroundTaskErrorSchema = z.union([
  sessionNotFoundErrorSchema,
  invalidStateErrorSchema,
  stopTaskFailedErrorSchema,
]);
export const acpSetModelOptionErrorSchema = z.union([
  sessionNotFoundErrorSchema,
  invalidStateErrorSchema,
  setConfigFailedErrorSchema,
]);
export const acpSetModeOptionErrorSchema = z.union([
  sessionNotFoundErrorSchema,
  invalidStateErrorSchema,
  setModeFailedErrorSchema,
]);
export const acpExportTranscriptErrorSchema = sessionNotFoundErrorSchema;
export const acpExportRawLogErrorSchema = sessionNotFoundErrorSchema;
export const acpAttachmentErrorSchema = invalidStateErrorSchema;
export const acpGetHistoryErrorSchema = z.never();

