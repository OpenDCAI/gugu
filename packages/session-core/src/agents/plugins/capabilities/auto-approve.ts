import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';

/**
 * 一档的声明:`id` 是代表(选中该档就切到它),`aliases` 是同属这一档的其它原生 id。
 * `legs`:只有这几条腿兑现得了这一档(缺席 = 两条腿都行)。例:antigravity 的只读在聊天面板腿上是
 * `default`,终端腿的 `agy` 却没有能选它的旗标 ⇒ 只给 `['acp']`,终端腿的界面不摆这一档。
 */
const modeEntrySchema = z.object({
  id: z.string(),
  aliases: z.array(z.string()).optional(),
  legs: z.array(z.enum(['acp', 'tui'])).optional(),
});

/**
 * autoApproveDescriptor is used to describe the auto-approve that an agent supports.
 * @param kind - The kind of auto-approve descriptor.
 * @param kind: 'supported' - The agent supports auto-approve.
 * @param kind: 'none' - The agent does not support auto-approve.
 */
export const autoApproveCapability = definePluginCapability()(
  'auto-approve',
  z.object({
    kind: z.enum(['supported', 'none']),
    /**
     * 这个 harness 的原生档位 ↔ 咕咕三档(只读 / 编辑 / 完全访问)的对应表。
     *
     * ⚠️ 必须由 harness **自己声明**,❌ 不能按 id 名字猜:claude 的 `default` 是只读档
     * (官方原文「default (read-only)」),而同名的 `default` 在别家可能是可写档 ——
     * 名字不携带语义。claude 还有三个档都偏只读(default / plan / dontAsk),
     * 挑谁当代表也只有它自己知道,所以 `id` 是代表、`aliases` 是同属该档的其它 id。
     *
     * 没声明的档 = 这个 harness 没有那一档,composer 就不给这个选项。
     * ❌ 不要为了三档齐整而随手填:摆一个不生效的档位,用户以为锁住了 agent 其实没有,
     * 和 codex 那个空权限档是同一种错法。
     */
    modes: z
      .object({
        plan: modeEntrySchema.optional(),
        'read-only': modeEntrySchema.optional(),
        edit: modeEntrySchema.optional(),
        'full-access': modeEntrySchema.optional(),
      })
      .optional(),
    /**
     * `modes` 是否**完整**:没声明的档都已实测为「这家没有」。只有完整的表才让注册表把终端命令收到
     * 「不比所选更松」的已声明档、让 composer 藏掉没有的档;❌ 为了收紧随手标 —— 不完整的表
     * (只实测了一两档的 droid 等)照旧由各家命令构造器按原语义处理(#6231 逐家实测后再收)。
     */
    modesExhaustive: z.literal(true).optional(),
  }),
  { kind: 'none' }
);
