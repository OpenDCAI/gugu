import z from 'zod';
import { GUGU_PERMISSION_MODES, promptInputSchema } from '@gugu/session-core/acp/client';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';
import { sessionTitleSourceSchema } from './session-config';
import { linkedIssue } from '../linked-issue';

const initialQueuePromptSchema = z.object({
  text: z.string(),
  hiddenContext: z.string().optional(),
  origin: promptInputSchema.shape.origin.unwrap(),
});

const v1Schema = z.object({
  version: z.literal('1'),
  name: z.string(),
  linkedIssue: linkedIssue.asNested().optional(),
  initialSession: z
    .object({
      id: z.string(),
      provider: z.string(),
      title: z.string().optional(),
      /**
       * 标题的来历,口径见 `sessionTitleSourceSchema`。只有调用方**知道**标题是人起的时才带
       * `manual`(定时任务:会话名就是那条自动化的名字);缺席 = 首轮兜底,harness 自己起的名可以盖掉它。
       */
      titleSource: sessionTitleSourceSchema.optional(),
      /** 咕咕四档权限(规划/只读/编辑/完全访问);缺席按编辑档。 */
      permissionMode: z.enum(GUGU_PERMISSION_MODES).optional(),
      /**
       * 这个会话是怎么来的 —— **动词**,不是「带不带活」的开关(spec session-resume)。
       * `import` 是另一个动词:历史本来就在引擎侧,咕咕只是把它认领进来(第一次启动就 resume
       * 那条既有会话,而不是开新的),所以它**必须**显式说。
       *
       * `create` 只在**载荷里没有第一句话**时才需要写出来(首轮改走普通消息投递的那条路)——
       * 载荷带着它时,那就是这一轮的内容,再声明一遍只会等来两份不一致。两者都没有 = 参数错误,
       * 建不出来:没有首轮的会话在引擎侧什么都不是,重开时既恢复不了也重来不了。
       */
      origin: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('create'), firstUtterance: z.string() }),
          z.object({ kind: z.literal('import'), providerSessionId: z.string() }),
        ])
        .optional(),
      /** Product surface that originated this startup intent. */
      startupOrigin: z.enum(['chat-page', 'session-page']).optional(),
      /** Stable id for a startup-delivered first user message. */
      initialMessageId: z.string().optional(),
      /** gugu-dev#181: the chat whose composer dispatched this task — its first turn lands there as a task card. */
      taskChatId: z.string().optional(),
      /** System bootstrap compatibility only. Ordinary user text uses sendMessage. */
      initialPrompt: z.string().optional(),
      /** System bootstrap compatibility only. Ordinary user text uses sendMessage. */
      initialQueue: z.array(initialQueuePromptSchema).optional(),
      model: z.string().optional(),
      /** Reasoning-effort level picked alongside the model. Absent for effort-less models. */
      effort: z.string().optional(),
      /**
       * composer 里选中的「咕咕提供的模型」。**三态**,完整口径见
       * `@shared/core/agents/platform-model` 的 SessionPlatformModel:
       * 字段缺席 = 这条路径没有 composer 决策(回落 agent 级);null = 明确选了 harness;
       * 对象 = 平台模型。选平台模型时 `model`/`effort` 一并缺省(模型由网关 token 钉死)。
       */
      platformModel: z.object({ modelId: z.string() }).nullish(),
      /**
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
    })
    .optional(),
});

export const sessionConfig = defineVersionedSchema().initial('1', v1Schema).build();

export const sessionConfigSchema = sessionConfig.schema;
export type NewSessionConfig = typeof sessionConfig.Type;
