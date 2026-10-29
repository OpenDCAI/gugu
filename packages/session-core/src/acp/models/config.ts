import { z } from 'zod';

export const liveSettingChannelSchema = z.enum([
  'acp-config-option',
  'acp-mode',
  'provider-thread-settings',
  'per-prompt',
  'reload-session',
  'unsupported',
]);
export type LiveSettingChannel = z.infer<typeof liveSettingChannelSchema>;

/** Wire-safe result returned after a live setting intent reaches the runtime authority. */
export const liveSettingResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    effectiveValue: z.string(),
    channel: liveSettingChannelSchema,
  }),
  z.object({
    status: z.literal('pending_next_turn'),
    requestedValue: z.string(),
    channel: liveSettingChannelSchema,
  }),
  z.object({
    status: z.literal('restart_required'),
    requestedValue: z.string(),
    channel: liveSettingChannelSchema,
  }),
]);
export type LiveSettingResult = z.infer<typeof liveSettingResultSchema>;

const configOptionBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

export const modelScoreSchema = z.object({
  value: z.number(),
  max: z.number(),
});
export type ModelScore = z.infer<typeof modelScoreSchema>;

export const modelOptionSchema = configOptionBaseSchema.extend({
  /** Optional model metadata used for ranking/display; absent when provider does not report it. */
  features: z
    .object({
      contextWindowSize: z.number().int().optional(),
      speed: modelScoreSchema.optional(),
      intelligence: modelScoreSchema.optional(),
    })
    .optional(),
});
export type ModelOption = z.infer<typeof modelOptionSchema>;
export type ModelChoice = ModelOption;

export const effortOptionSchema = configOptionBaseSchema;
export type EffortOption = z.infer<typeof effortOptionSchema>;

export const modeOptionSchema = configOptionBaseSchema;
export type ModeOption = z.infer<typeof modeOptionSchema>;

export const sessionCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** Distinguishes provider-advertised ACP commands from Gugu-owned skills. */
  source: z.literal('provider-command'),
  /** Optional provider hint for slash-command arguments, shown near the composer. */
  inputHint: z.string().optional(),
});
export type SessionCommand = z.infer<typeof sessionCommandSchema>;

/** Command facts retain native fields; the composer consumes only the optional input hint. */
export type SessionCommandDefinition = { name: string; description: string; input?: { hint?: string; type?: string } | null };


export const sessionConfigStateSchema = z.object({
  /** Model selector state; null when the provider has not exposed model configuration. */
  modelOptions: z
    .object({
      /** Provider-owned ACP config option id used when sending config updates. */
      configId: z.string(),
      selected: z.string().nullable(),
      available: z.array(modelOptionSchema),
    })
    .nullable(),
  /** Reasoning/effort selector state; null when unsupported by the provider. */
  efforts: z
    .object({
      /** Provider-owned ACP config option id used when sending config updates. */
      configId: z.string(),
      selected: z.string().nullable(),
      available: z.array(effortOptionSchema),
    })
    .nullable(),
  /** Permission/mode selector state; null when unsupported by the provider. */
  modeOptions: z
    .object({
      /**
       * Provider-owned ACP config option id used when sending config updates.
       *
       * null ⇔ 这组档位来自 ACP **稳定版** `session/new` 的 `modes` 字段(而不是 unstable 的
       * `configOptions[category=mode]`)。这种会话没有可用的 `session/set_config_option` 通道,
       * 档位切换走稳定版 `session/set_mode` —— cell.setMode 按「configId 为空 ⇒ setSessionMode」
       * 分路(#4655:gemini 只报稳定版 modes,此前这组状态恒 null,权限档在这些家上整个失灵)。
       */
      configId: z.string().nullable(),
      selected: z.string().nullable(),
      available: z.array(modeOptionSchema),
    })
    .nullable(),
  /** Slash commands currently advertised by the active ACP session. */
  availableCommands: z.array(sessionCommandSchema),
  /**
   * 这条会话的 agent 收不收 image 块 —— 来自 ACP `initialize` 的
   * `agentCapabilities.promptCapabilities.image`。
   *
   * ⚠️ 缺省 **false**,与协议默认一致:没声明就是不收。宿主据此决定图片附件走哪条路
   * (ACP 附件上传 / 退回正文里的绝对路径),❌ 不要不管三七二十一照发 —— 收不下的那一端
   * 会**静默**把它丢掉,产品面上看不出任何异常(#5269,owner 2026-09-09 实撞)。
   */
  acceptsImagePrompts: z.boolean(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const initialSessionConfigState: SessionConfigState = {
  modelOptions: null,
  efforts: null,
  modeOptions: null,
  availableCommands: [],
  acceptsImagePrompts: false,
};

export const sessionUsageSchema = z.object({
  /** Total context window capacity reported by the provider. */
  contextSize: z.number().int(),
  /** Tokens currently consumed in the active session context. */
  contextUsed: z.number().int(),
  /** Cumulative provider-reported cost, or null when the provider omits cost. */
  cost: z.object({ amount: z.number(), currency: z.string() }).nullable(),
  /**
   * The account's limit as the engine last reported it (G3; Claude: `_claude/rateLimit`, sent only when it changes, so a
   * report without one keeps the last). `resetsAt` is epoch ms; `window` the engine's name for it (`five_hour`, …).
   */
  rateLimit: z
    .object({
      status: z.enum(['allowed', 'allowed_warning', 'rejected']),
      resetsAt: z.number().nullable(),
      window: z.string().nullable(),
      utilization: z.number().nullable(),
    })
    .nullable()
    .optional(),
});
export type SessionUsage = z.infer<typeof sessionUsageSchema>;
