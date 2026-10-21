import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';

/**
 * 这家 harness 要不要**厂商账号**才跑得起来。
 *
 * 判据只有一条（owner 2026-08-25 定，见 spec `harness-vendor-account`）：
 * **给足三方 key 之后跑不跑得起来**。跑得起来的记 `not-required` —— 哪怕它自己也提供登录方式、
 * 哪怕它的文档写着需要订阅。
 *
 * ## ❌ 别用 `capabilities.auth` 代替这一维
 *
 * `auth` 建的是「怎么登」与「登没登」。它的 `api-key` 方法**判不出**这件事：
 *  · copilot 的 api-key 是一枚带 `Copilot Requests` 权限的 **GitHub PAT** —— 仍是厂商账号;
 *  · kimi 的 `KIMI_MODEL_API_KEY` 是**任意三方 key**。
 * 两者在 `auth` 里长得一模一样,而它们在这一维上是相反的。
 *
 * ## ⚠️ 只读文档会判错,必须实测
 *
 * copilot 的 README 白纸黑字写着「An active Copilot subscription」与「you'll be prompted to use
 * the `/login`」,照它写就会记成 `required`。实测(隔离 HOME/XDG + 假端点,**零厂商凭据**)只给
 * `COPILOT_PROVIDER_*` 它照样跑完一轮 ⇒ 那句订阅说的是**用它自家模型**,不是「不登录就不能跑」。
 *
 * ## 为什么默认是 `unverified` 而不是 `not-required`
 *
 * 「没测过」和「测过、不需要」是两件事。默认成后者,一家真的强制登录的 harness 只要没人管它,
 * 就会安安静静地表现为「切过去之后界面点不动」,而**没有任何判据会红**。
 * `unverified` 是显式的欠账,`conformance` 那卷据此列得出来。
 *
 * @param kind: 'required'     - 没有厂商账号完全跑不起来。切过去时给用户一次登录提示（见 spec）。
 * @param kind: 'not-required' - 给足三方 key 就能跑。
 * @param kind: 'unverified'   - 还没测。❌ 不等于 `not-required`。
 */
export const vendorAccountCapability = definePluginCapability()(
  'vendorAccount',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('required'),
      /** 实测依据，一句话说清是怎么测出来的。❌ 不收「文档写着」。 */
      evidence: z.string().min(1),
    }),
    z.object({
      kind: z.literal('not-required'),
      evidence: z.string().min(1),
    }),
    z.object({
      kind: z.literal('unverified'),
    }),
  ]),
  { kind: 'unverified' }
);
