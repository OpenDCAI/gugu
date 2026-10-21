/**
 * 「这个模型 id 指的是咕咕平台模型，还是 harness 自家的模型」—— 一份编解码，放在一个
 * **不经任何 app 别名 import** 的模块里（同 `platform-model-labels.ts` 的理由）;唯一的 import 是 session-core 那个同样零依赖的窄入口。
 *
 * 平台条目与 harness 条目共用**同一个 id 空间**，前缀是两者唯一的分界。这套编码原本只活在
 * composer 下拉那一侧（`session-config/platform-model-options.ts`），而那个文件经 `@renderer/*`
 * 别名拉进整张 renderer 模块图 —— 于是会话页主进程（另一次 esbuild）与咕咕主进程（另一次 rollup）
 * 想说同一件事时，只剩「各自抄一份前缀字面量」这一条路。
 *
 * 抄一份的代价不是多写一行:三份前缀里任何一份漂了，症状是**「以为选了自己的模型，实际按积分计费」**
 * 或反过来 —— 一类事后看日志才会发现的错账。⇒ 单一事实源，三条 bundle 同引。
 *
 * 原路径 `platform-model-options.ts` 继续 re-export 这三个符号，产品侧的 import 一个字不用改。
 *
 * 「平台模型在活会话上怎么寻址」那一组(`gugu-platform/` 前缀)住在 session-core —— runtime worker
 * 重开后断言模型也要问它(#6196),而 worker 够不着这个目录。这里原样转出(那个模块自身零依赖)。
 */
export {
  PLATFORM_NATIVE_OPTION_PREFIX,
  platformModelIdFromNativeOption,
  platformModelIdFromRuntimeOption,
  runtimeOptionForPlatformModelId,
} from '@gugu/session-core/acp/platform-model-address'

/** 平台条目的前缀 —— 与「运行模型」面板(AgentAiModelPane)的 `platform:` 值编码同一套写法。 */
export const PLATFORM_OPTION_PREFIX = 'platform:'

/** 把 `billing.platform_models.id` 编成下拉/工具面用的选项 id。 */
export function platformOptionId(modelId: string): string {
  return `${PLATFORM_OPTION_PREFIX}${modelId}`
}

/** 这个 id 是不是平台条目;不是就返回 null(那是 harness 自家模型 id)。 */
export function platformModelIdFromOption(optionId: string): string | null {
  if (!optionId.startsWith(PLATFORM_OPTION_PREFIX)) return null
  return optionId.slice(PLATFORM_OPTION_PREFIX.length) || null
}

/**
 * harness 自家的模型 id 撞上平台前缀 —— **两条用户面共用的唯一判定**。
 *
 * 两条面各自把这个 id 空间物化一次(composer 下拉的 `sanitizeHarnessModelOptions`、
 * 会话发现工具的 `session_list_models`),而撞名的后果两边一模一样:那条 harness 模型会顶着
 * 平台条目的身份被选中 ⇒ **「以为选了自己的模型,实际按积分计费」**,一类事后看日志才发现的错账。
 *
 * ⚠️ 判定只写在这里一处。❌ 别在任何一条面上照着再写一份 `startsWith` ——
 * 两份一开始一致,漂移要等到某天只改了其中一个才显形,而那天没有任何东西会提醒你。
 * 各面**自己决定怎么报**(渲染层的静态表在开发期直接抛;外部 harness 报上来的一律丢弃并记一条),
 * 那是处置,不是判定。
 */
export function platformNamespaceCollisions(ids: Iterable<string>): string[] {
  return [...ids].filter((id) => id.startsWith(PLATFORM_OPTION_PREFIX))
}
