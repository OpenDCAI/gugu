/**
 * 平台模型在下拉里的组头文案，放在一个**没有任何 import** 的模块里。
 *
 * 刻意零依赖(同 `session/shared/extensions/scheme.ts` 的理由):它原本住在
 * `session-config/platform-model-options.ts`，而那个文件经 `@renderer/*` / `@shared/*` 别名
 * 拉进整张 renderer 模块图 —— 黑盒 e2e 想引用这个字面量就得连那张图一起加载，
 * 在 Playwright 的 transform 下当场 `exports is not defined in ES module scope`。
 *
 * 于是只剩两条路:把字符串**抄一份**进 spec，或者把它挪到两边都能引的地方。抄一份的代价不是
 * 「多写一行」—— 产品改文案时那条 spec 会静默退化成「一家都没列出咕咕模型」，
 * 而那正好落进它自己的阳性对照里,报错指向错误的方向。⇒ 单一事实源，两边同引。
 */

/**
 * ⚠️ 2026-09-05:这里从前放的是**成品中文串**(`'咕咕提供的模型'` 等),被 composer 直接摆进
 * 下拉 —— 英文壳下于是漏中文。现在放的是**词表 key**,文案在 `messages.ts` 的
 * `composer.platformModel*`,两种语言各一份;这个模块的零依赖属性(给黑盒 e2e 引)不变。
 *
 * 分组名与计费口径,与「运行模型」面板(AgentAiModelPane)同一套说法。
 */
export const PLATFORM_GROUP_LABEL_KEY = 'composer.platformModelGroup'
export const PLATFORM_BILLING_LABEL_KEY = 'composer.platformModelBilling'

/**
 * 下拉里的**二级**分类那一格(一级是厂商)。spec 要求「选项旁必须明示是否消耗积分」——
 * 这句说一次就够,逐行再重复一遍只是噪声(条目本身只留模型名与倍率)。
 */
export const PLATFORM_GROUP_HEADING_KEY = 'composer.platformModelGroupHeading'

/** 带相对倍率的那一版描述(倍率 ≠ 1 时才有)。 */
export const PLATFORM_RATE_KEY = 'composer.platformModelRate'
