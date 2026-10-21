import z from 'zod';
import { sessionConfig } from '@shared/core/sessions/new-session-config';
import { workspaceConfig } from '@shared/core/workspaces/workspace-config';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

export const triggerConfigSchema = z.object({
  /** 5 段 cron(重复的那种)。一次性的这一格为空串,时间在 `at`。 */
  expr: z.string(),
  tz: z.string().optional(),
  /**
   * 一次性:到点的那一刻(epoch ms),跑过一次就不再排。只有 agent 给自己排的那一类会有(#7221)。
   * 建的时候按 `tz` 把「几号几点」换算成这一刻存下,`tz` 只留着给人看。
   */
  at: z.number().optional(),
});

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export const automationTriggerConfig = defineVersionedSchema()
  .unversioned(triggerConfigSchema)
  .build();

export const agentConfigSchema = z.object({
  prompt: z.string(),
  provider: z.string(),
  title: z.string().optional(),
  autoApprove: z.boolean(),
  /** Model to pass to the agent CLI. Absent or empty string means use the CLI default. */
  model: z.string().optional(),
  /** Reasoning-effort level for that model. Absent = the CLI's own default for it. */
  effort: z.string().optional(),
  /**
   * composer 里选中的「咕咕提供的模型」。**三态**,与新建会话那份文档
   * (`NewSessionConfig.initialSession.platformModel`)同一个口径,到点时原样交给同一个翻译点:
   * 字段缺席 = 这一维出现之前存下的旧记录,没有 composer 决策(回落 agent 级);
   * null = 明确选了 harness 自家模型;对象 = 平台模型(此时 `model` 缺省,模型由网关 token 钉死)。
   */
  platformModel: z.object({ modelId: z.string() }).nullish(),
  /**
   * 这条自动化开出来的会话跑成什么(`SessionRuntime`):`pty` 编程视角的原生 TUI / `acp` 通用视角的结构化面板。
   *
   * ⚠️ **这一格仍叫 `type`，是刻意的，❌ 别顺手改成 `runtime`。**
   *
   * 代码里其它地方都已经改口叫 `SessionRuntime` / `runtime`(#4915)，只有这里没跟——
   * 因为这是**已经落在用户机器上的载荷**，改字段名要 bump versioned-schema 版本 + 写升级步
   * 骤，动的是存量数据。owner 2026-09-03 拍板：**先不动存量用户的数据，这一半往后延。**
   *
   * 读出来之后立刻翻成 `SessionRuntime`(见 createSession.ts 的 `ic.type`)，所以这个旧名字
   * 到不了产品层。
   */
  type: z.enum(['pty', 'acp']).optional(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const automationAgentConfig = defineVersionedSchema()
  .unversioned(agentConfigSchema)
  .build();

const storedAutomationSessionConfigV1Schema = z.object({
  version: z.literal('1'),
  sessionConfig: sessionConfig.asNested(),
  workspaceConfig: workspaceConfig.asNested(),
});

export const storedAutomationSessionConfig = defineVersionedSchema()
  .initial('1', storedAutomationSessionConfigV1Schema)
  .build();

export const storedAutomationSessionConfigSchema = storedAutomationSessionConfig.schema;
export type StoredAutomationSessionConfig = typeof storedAutomationSessionConfig.Type;
