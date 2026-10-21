/**
 * P0 名单 —— **这是本仓唯一一份机器可读的记录**。
 *
 * ## 现行版本：owner 2026-08-25 定的**出货切口**
 *
 * owner 原话：「我觉得我这个 pr 如果保持目前 p1 的适配,基本不可能说有合的日期,我决定搞一个
 * p0档出来,加个qoder，和 kimi opencode mimocode 就这些.其他的如果已经完全适配的就加,
 * 如果没有适配的就先完全不加。」—— 随后他确认这份名单要跟着这个切口一起改。
 *
 * 于是名单 = 他点名的四家（qoder / kimi / opencode / mimocode）+ 已经完全适配的那几家
 * （claude / codex / copilot / qwen）= 8 家。判据不是「哪个厂商更商业化」，而是
 * **「今天真接通了没有」**。
 *
 * ## ⚠️ 这一版把 6 家挪出去了，欠账数字因此自动变小 —— 那不是干了活
 *
 * 挪出去的：antigravity / mistral / grok / hermes / cursor / pi。
 * 本卷所有「P0 里还欠多少」的棘轮都以 P0 名单为定义域，名单一短，读数就跟着降。
 * 这正是旧版抬头警告过的那种降法（「❌ 别为了让欠账数字好看，把某一家悄悄挪出名单」）。
 * 这次不是悄悄挪，是 owner 明确拍的；**代价是那 6 家从此不再被任何判据盯着**。
 * ⇒ 所以本次同时把各条棘轮**收紧到挪走之后的真实读数**，不留下名单缩短腾出来的空档 ——
 *   否则下一次真有人退步，棘轮还以为在预算内。
 *
 * ## 旧版本（owner 2026-08-24 的分层）—— 已被上面这一版取代，留档备查
 *
 * 那一版按「有没有基模 / 团队商业化程度」分三层，并加了一条「一个基模厂有多个 harness 时
 * P0 只取商业化程度最高的那一个」，于是 Google 三家只取 antigravity、阿里两家只取 qoder。
 * 11 家：claude / codex / antigravity / qoder / kimi / mimocode / mistral / grok / hermes /
 * cursor / pi。⚠️ 那一版的取舍理由是**产品定位**；现行版换成了**接通与否**，两者不是同一把尺，
 * ❌ 别把旧版的理由拿来解释新名单（比如「qwen 落选是因为同厂只排一个」在新版里不成立 ——
 * 它在名单里，因为它真接通了）。
 *
 * ⚠️ 这份名单是**产品决定，不是工程判断**：要增删得回到 owner。
 *    ❌ 尤其别为了让欠账数字好看，把某一家悄悄挪出名单 —— 挪出去欠账当然会降，
 *    而棘轮只认"变小"，拦不住这种降法。拦它的是 `P0_SIZE`。
 *
 * ## ⚠️ 别把它和 `SUPPORTED` 搞混（2026-08-25 真出过事）
 *
 * 支持档另有两张名单，都是**由 capabilities 推出来的读数**：
 * `SUPPORTED`（谁真达到了 claude code / codex 级别）与 `GUGU_INTEGRATED`（咕咕自己那套
 * 五维接没接进去）。这份 `P0_FAMILIES` 是 **owner 的产品决定**。
 * 现行版本恰好与 `GUGU_INTEGRATED` 同集合，但 ❌ **别把它改成从那里推导** ——
 * 那就成了「生产码证明自己」：接通判据一松，名单跟着松，而名单本该是外部标尺。
 * 它们同步是这一刻的事实，不是定义。
 *
 * （历史：那次模型接入调研照着 `SUPPORTED` 排的工，于是当时 P0 里五家从没被考过，
 * 而**没有任何判据会因此变红**。本卷那几条 P0 守卫就是补那个缺口加的。）
 */
export const P0_FAMILIES = [
  // owner 2026-08-25 点名的四家
  'qoder',
  'kimi',
  'opencode',
  'mimocode',
  // 「其他的如果已经完全适配的就加」——`GUGU_INTEGRATED` 五维全真的那几家
  'claude',
  'codex',
  'copilot',
  'qwen',
] as const;

/**
 * owner 2026-08-25 拍板时名单是 8 家（2026-08-24 那版是 11）。改名单必须**同时**改这个数
 * —— 这不是冗余，是逼出一次显式、进得了 diff、评审时看得见的动作，而不是在数组里少写一行
 * 就悄悄过去。**名单变短那次尤其要看这个数**：欠账棘轮会跟着自动放松，只有这里会变红。
 */
export const P0_SIZE = 8;

/**
 * Owner product decisions: Grok/Gemini withheld for #4757 (2026-09-02); Qoder withheld per #4735
 * and closed #4738 (no addressable sessionpage identity, so offering it cannot produce a session).
 * Cursor is explicitly withheld by #4833 until its adapter acceptance is complete. Its current
 * degraded capability units already keep it out; this list prevents a future capability upgrade from
 * silently changing the user-facing offer. Hermes left this list after its adapter acceptance
 * (gugu-base evidence/2026-09-28-hermes-adapter).
 *
 * Kimi withheld 2026-09-04 (owner: 「kimi 目前看来尚不可用,kimi 代码不删,只是功能属于内测,
 * 用户体验不到」). It stays in `P0_FAMILIES`, stays registered, and #4948/#4951 stay merged;
 * what keeps it off the offer is an architectural gap, not a capability unit: kimi's CLI reads
 * MCP config only from directory-scoped files (managed home / cwd), so two concurrent kimi
 * conversations overwrite each other's gugu MCP token in the shared per-provider home and the
 * later one's identity wins for both (the misattribution owner hit on 2026-09-04). Internal
 * testing reaches it through `GUGU_SHOW_UNSUPPORTED_AGENTS=1`; existing kimi conversations keep
 * running because `getPlugin(id)` never consults this list.
 *
 * 2026-09-21(#6097):openclaw / rovo / freebuff / jules / goose / letta / autohand / charm 八家
 * **整个插件被删掉**（结构上开不出会话,owner 拍板不适配),于是一并退出本名单 —— 名单只登记
 * 「注册了但不上架」的家,删掉的家没有注册面可扣留。⇒ 这次名单从 29 变 21 **不是放宽**。
 */
export const WITHHELD_FAMILIES = [
  'amp',
  'auggie',
  'cline',
  'codebuff',
  'commandcode',
  'continue',
  'cursor',
  'devin',
  'droid',
  'gemini',
  'grok',
  'junie',
  'kilocode',
  'kimi',
  'kiro',
  'mistral',
  'oh-my-pi',
  'qoder',
  'zero',
] as const;
