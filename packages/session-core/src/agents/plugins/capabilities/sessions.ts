import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';

/** `ISessionsBehavior.forkSessionInStorage` 的入参 —— env 与起这一家时同一份(配置根跟着它挪)。 */
export interface SessionStorageForkContext {
  sourceProviderSessionId: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  homeDir: string;
}

export type ISessionsBehavior = {
  /** Return true when a stored provider session id looks valid and should be used for resume. */
  validateProviderSessionId?(id: string): boolean;
  /**
   * 终端腿的分叉由**宿主在这一家自己的会话存档上**做:复制出一份新 id 的存档、返回那个 id,宿主随后
   * 按普通续跑(`resumeFlag <新 id>`)起进程。与聊天面板腿的 `acp.forkSessionInStorage` 同一个意思。
   *
   * 用于命令行上没有任何分叉参数、但存档可以被安全复制的家(Antigravity `agy`:只有 TUI 里的 `/fork`)。
   * ⚠️ 必须不动来源那一份 —— 来源会话可能正开着。失败就抛,分叉整体失败,❌ 不退回别的路。
   */
  forkSessionInStorage?(ctx: SessionStorageForkContext): Promise<{ providerSessionId: string }>;
};

export const sessionsCapability = definePluginCapability<ISessionsBehavior>()(
  'sessions',
  z.object({
    kind: z.enum(['resumable', 'stateless']),
    /** The terminal (pty) leg only: present when Gugu's pty fork can invoke a verified CLI fork
     * that creates a fresh session from an existing session without mutating the source.
     * The ACP leg is never declared here — it is read from the provider's ACP fork hook or the
     * adapter's own `initialize` (desktop `fork-legs.ts`). */
    fork: z.enum(['supported']).optional(),
    childId: z.enum(['provider-minted', 'caller-assigned']).optional(),
    /**
     * 终端腿续跑时指名的是哪一条会话:`caller-id` = 咕咕起会话时交给它的 id(claude `--session-id`/`--resume`);
     * `provider-id` = 它自己铸、经 hook / 控制通道报回来的 id。缺席 = 续不回指定的那一条(按 cwd 找最近一条、
     * 弹选择器、或根本不能续)⇒ 闲置回收不停它的进程:停了再起就不是原来那条对话。
     * 与真实 argv 的一致性由 `tui-resume-declaration.test.ts` 逐家核。
     */
    tuiResume: z.enum(['caller-id', 'provider-id']).optional(),
    /**
     * 终端腿续跑**只认**它自己的原生 id:库里还没记着(首轮前就退了)⇒ 不算续跑,起一条新的。
     * ❌ 不退到按 cwd 找「最近一条」(`--last` / `-c` / `-C` 之类):同一个工作区里另一条咕咕会话的对话会被当成这一条续上,
     * 猜中猜不中都不是用户点的那条。缺席 = 没有原生 id 时照这一家自己的 argv 续(由 `resolveAgentSessionCommandArgs` 读)。
     */
    resumeNeedsProviderId: z.literal(true).optional(),
  })
);
