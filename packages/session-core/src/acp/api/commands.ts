import { z } from 'zod';
import { attachmentRefSchema } from '../models/attachments';
import { GUGU_PERMISSION_MODES, permissionDecisionSchema } from '../models/permissions';
import { promptDraftUpdateSchema, promptInputSchema, queuedPromptSchema, queuedPromptEditSchema } from '../models/prompt';

// @@@sessionpage TASKPAGE-FUSION — loopback HTTP MCP server injected into session/new. Declared here,
// at the acpStartInput SSOT, so the field survives validation on every renderer → main → worker hop.
// The owner credential stays in the Gugu-spawned server; the harness receives only URL + capability.
export const acpMcpServerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    name: z.string(),
    url: z.string().url(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })),
  }).passthrough(),
  z.object({
    type: z.literal('stdio'),
    name: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    env: z.array(z.object({ name: z.string(), value: z.string() })),
  }).passthrough(),
]);

// @@@2503 平台额度注入信封 —— 随 session/new 与 session/load 一起发给适配器的 `_meta`。
//
// 为什么必须按**会话**走 `_meta`,而不是像 pty 那样进进程环境:Claude 的 ACP 合同把中转令牌
// 与指定模型绑定在 session/new | session/load 的调用上。每条会话虽然拥有自己的 adapter 进程，
// `_meta` 仍是 Claude 侧的会话级载体，能在重开时明确恢复这份选择。
//
// `settings` 是**文件路径**,不是内联文档:Agent SDK 把 `options.settings` 直接拼成
// `--settings <值>` 发给 claude CLI,内联就等于把这次会话的中转令牌写进命令行,而 argv 在进程表里
// 人人可读。0600 的会话级文件由签发方写、会话结束时删。
// Codex 的 ACP 适配器也需要会话级 `_meta`,但它的原生线程权限不是 Claude 的 options。
// 这个命名空间保持 provider-specific,让 capability bundle 的 thread/start 载荷能穿过
// renderer -> main -> runtime；不能把它塞进 `claudeCode` 伪装成另一家的形状。
const acpCodexSessionMetaSchema = z.object({
  permissionProfile: z.string().min(1),
  threadStart: z.object({
    approvalPolicy: z.string().min(1),
    sandbox: z.string().min(1),
  }).passthrough(),
}).passthrough();

export const acpSessionMetaSchema = z.object({
  claudeCode: z.object({
    options: z.object({
      settings: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      plugins: z.array(z.record(z.string(), z.unknown())).optional(),
      mcpServers: z.record(z.string(), z.unknown()).optional(),
    }).passthrough(),
  }).passthrough().optional(),
  guguCodex: acpCodexSessionMetaSchema.optional(),
  systemPrompt: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export type AcpSessionMeta = z.infer<typeof acpSessionMetaSchema>;

export const acpStartInputSchema = z.object({
  sessionId: z.string(),
  /** Persisted source used for identity/config lookup when conversationId is a runtime view id. */
  sourceSessionId: z.string().optional(),
  /** Provider session to fork through ACP session/fork. Never persisted under conversationId. */
  forkFromProviderSessionId: z.string().optional(),
  projectId: z.string(),
  providerId: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  providerSessionId: z.string().nullable(),
  /** Origin and stable message identity for a startup user turn. */
  startupOrigin: z.enum(['chat-page', 'session-page']).optional(),
  initialMessageId: z.string().optional(),
  model: z.string().nullable(),
  /** Reasoning-effort level picked before the session existed; applied right after the model. */
  effort: z.string().nullable().optional(),
  /** Permission choice made before the ACP session exposed its provider-owned mode ids (咕咕的档位). */
  permissionMode: z.enum(GUGU_PERMISSION_MODES).optional(),
  initialQueue: z.array(promptInputSchema).optional(),
  // @@@sessionpage TASKPAGE-FUSION — host-injected MCP servers for this session (the gugu MCP send tool).
  mcpServers: z.array(acpMcpServerSchema).optional(),
  // @@@2503 平台额度注入信封;只有走平台额度的会话才有,BYOK/默认会话为 undefined(什么都不注入)。
  sessionMeta: acpSessionMetaSchema.optional(),
  /**
   * 宿主能力包注入的**会话级系统提示词**。main 信任边界会剥掉 renderer 输入后再写回可信值。
   *
   * ⚠️ 上一版这里写的是「首轮隐藏上下文」——那是 #3701 之前的形态,今天已经不对:
   *    它走的是系统位(`_meta.systemPrompt.append`),不骑在任何一条用户消息上。
   *    过期注释会把下一个人引到一条已经不存在的路上(本次就发生过)。
   */
  sessionPrompt: z.string().min(1).optional(),
  /**
   * 上面那段字节走**哪根管子**进 agent —— behavior `agent-context-injection` 的 ② 与 ③。
   *
   * - `'system'`(缺省)= ②:走系统位。
   * - `'session-context'` = ③:这家没有系统位可坐,以**用户级载体**进到首轮的输入里。
   *   ⚠️ 这不是降级,是那类 harness 的正常形态;呈现照样**不展示给用户**。
   *
   * ⚠️ 是**路由位**不是第二个载荷:同一段字节只去一个地方。写成两个字段,就会出现
   *    「两边都发了」或「两边都没发」而没人报错。
   */
  sessionPromptCarrier: z.enum(['system', 'session-context']).optional(),
});
export type AcpStartInputWire = z.infer<typeof acpStartInputSchema>;

export const sendPromptResponseSchema = z.object({ queued: z.boolean() });

export const startSessionCommandSchema = z.object({ input: acpStartInputSchema });
export const resumeSessionCommandSchema = z.object({
  input: acpStartInputSchema.extend({ providerSessionId: z.string() }),
});
export const stopSessionCommandSchema = z.object({ sessionId: z.string() });
export const sendPromptCommandSchema = z.object({
  sessionId: z.string(),
  prompt: promptInputSchema,
  /**
   * spec session-injection:next-tool-call 档的 mid-turn 支——忙时同一条标准 session/prompt
   * 立即发进当前 turn(不落机器队列)。档位由会话上那家 harness 的
   * descriptor 声明决定,调用方按声明带旗。
   */
  steerIfBusy: z.boolean().optional(),
});
export const queuePromptCommandSchema = z.object({
  sessionId: z.string(),
  prompt: promptInputSchema,
  /** Optional first-start facts let runtime create the starting machine before admitting the prompt. */
  startInput: acpStartInputSchema.optional(),
});
export const editQueuedPromptCommandSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
  input: promptInputSchema,
  /** Present while reserving/updating an edit; null commits or cancels it. */
  queueEdit: queuedPromptEditSchema.nullable().optional(),
});
export const deleteQueuedPromptCommandSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
});
export const changeQueuePromptOrderCommandSchema = z.object({
  sessionId: z.string(),
  ids: z.array(z.string()),
});
/**
 * #6574 排队提示的「立即发送」在能插话的家上:这一条出队、插进在飞的那一轮(不取消)。
 * 没有可插的那一轮 ⇒ 挪到队首。调用方按这家声明的 acp 注入档位决定走不走这条。
 */
export const steerQueuedPromptCommandSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
});
export const cancelTurnCommandSchema = z.object({ sessionId: z.string() });
/** #5117 停一个后台任务;`taskId` 是派发它那次调用的 tool_use id(或供应商的 task id)。 */
export const stopBackgroundTaskCommandSchema = z.object({
  sessionId: z.string(),
  taskId: z.string(),
});
export const setModelOptionCommandSchema = z.object({
  sessionId: z.string(),
  dimension: z.enum(['model', 'effort']),
  value: z.string(),
});
export const setModeOptionCommandSchema = z.object({
  sessionId: z.string(),
  value: z.string(),
});
export const resolvePermissionCommandSchema = permissionDecisionSchema.extend({
  sessionId: z.string(),
});
export const setPromptDraftCommandSchema = z.object({
  sessionId: z.string(),
  draft: promptDraftUpdateSchema,
});
export const exportAcpTranscriptCommandSchema = z.object({ sessionId: z.string() });
export const exportRawAcpLogCommandSchema = exportAcpTranscriptCommandSchema;

export const uploadAttachmentCommandSchema = z.object({
  originalPath: z.string().optional(),
});
export const uploadAttachmentResponseSchema = attachmentRefSchema;
export const downloadAttachmentCommandSchema = z.object({ id: z.string() });
export const deleteAttachmentCommandSchema = z.object({ id: z.string() });

export { queuedPromptSchema };
