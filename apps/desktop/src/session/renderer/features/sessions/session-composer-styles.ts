// The new-session page caps its centered composer at 42rem (672px), including on wide screens.
export const sessionComposerWidthClassName = 'w-full max-w-2xl';

// 新建会话页、项目首页和对话页创建的输入框贴在底部,与会话页聊天的输入框同一个位置、同样宽(owner 2026-10-17:
// 「和正常 chatui 界面的输入框一样的位置……质感上也统一了」),从首页进到会话里输入框不跳。
// 数值同 packages/session-chat-ui:宽度档 = layout-geometry.ts 的 CHAT_CONTENT_*(42rem,≥80rem 时 48rem),
// 左右 16px(CHAT_CONTENT_GUTTER_PX)、离底边 8px(chat-root.css.ts 的 composerSlotInner)。
// 两边一致由 session-composer-styles.test.ts 钉住。
export const sessionComposerDockBandClassName = 'w-full shrink-0 px-4 pb-2';
export const sessionComposerDockedWidthClassName = 'mx-auto w-full max-w-2xl xl:max-w-3xl';
// 框里的几何:会话页、新建会话页、新任务框用的是同一个输入框(packages/session-ui 的 chat-composer),格子里的群框照它画
// (gugu-dev#181:原型里三处是同一个框)—— 文字离框内缘左右 22、上 14、下 8,编辑区空着 46 高(一行,含内距)、最多 200;
// 底排的按钮 32 见方,离框内缘 10,彼此隔 6。这几个数由 tests/browser/composer-empty-height.test.tsx 量真组件钉住。
export const sessionComposerBox = {
  textInsetPx: 22,
  textTopPx: 14,
  textBottomPx: 8,
  editorMinHeightPx: 46,
  editorMaxHeightPx: 200,
  toolbarInsetPx: 10,
  toolbarGapPx: 6,
  toolbarControlPx: 32,
} as const;
// 卡面:白底一圈细描边、没有投影,悬停 / 聚焦时描边加深 —— 会话输入框那张卡(session-ui chat-composer.css.ts 的
// composerShell)原样,格子里的群框照它(原型三处是同一个 `.cbox`:白底、圆角 24、1px 描边、无投影)。
export const sessionComposerCardClassName =
  'border border-solid border-[var(--em-border)] bg-[var(--em-surface-base-emphasis)] transition-colors hover:border-[var(--em-border-1)] focus-within:border-[var(--em-border-1)]';
// 空着时的高 = 编辑区 + 底排(按钮 + 离底)+ 上下边框各 1px = 90。
export const sessionComposerEmptyHeightPx =
  sessionComposerBox.editorMinHeightPx + sessionComposerBox.toolbarControlPx + sessionComposerBox.toolbarInsetPx + 2;

// ── Context tray ──────────────────────────────────────────────────────────────
// A full-width band behind the composer carrying 仓库 · 环境 · 分支, replacing the
// single-item tab. Geometry measured off Codex at its ORIGINAL capture resolution
// (3236px wide) and then scaled by the ratio of the two trays' widths — measuring on a
// 4.4×-downscaled copy is what produced the earlier wrong number (56px): downscaling
// smears the card's soft top shadow into the tray, so the boundary lands ~24px late.
//
// Codex, normalised to our 646px tray:
//   exposed strip 33px   ·   text 12.5px, sitting 12.5px below the tray's top edge
//   card 92px tall, 1.037× the tray's width (i.e. the 13px-per-side inset)
// The card pulls up 10px (sessionComposerFrameLiftClassName) to create the overlap, so
// exposed = tray height − 10, and pb must stay > 10 or the card clips the tray's text.
//
// ❌ 不给托盘描边:Codex 那条是纯填充,加了 border 会和卡片的 border 在接缝处叠成双线。
//
// ⚠️ 颜色必须走 --em-* 且用 arbitrary value,不能写 bg-background-secondary /
// text-foreground-muted 这类 color key。实测(CDP 读 computed style):嵌进 gugu 会话页的
// 子树里,--color-* 家族全部解析为空(包括 --color-background —— 这条曾被记成
// 「唯一还活着的」,复测已推翻),→ Tailwind v4 对未定义 color key 直接不出规则,
// 样式无声透明(托盘会和页面一样白,布局却是对的,极难一眼看出)。
// 改任何颜色后都得回真 app 读一次 computed style,别信截图。
export const sessionComposerTrayClassName =
  'mx-[13px] flex items-center gap-4 rounded-t-lg px-4 pt-1.5 pb-3 text-xs text-[var(--em-foreground-muted)]';

/**
 * 托盘填充 —— 走 inline style,不走 Tailwind。
 *
 * 要的是 #f8f8f8:Codex 那条灰和白卡片只差 7 级,几乎是一层薄雾。直接用
 * --em-surface-base-hover(≈#ececec)差 19 级、近三倍,那条灰会从版面里「跳」出来,
 * 读成一个独立控件而不是卡片的背衬 —— 这就是「灰框太重」的来源。
 *
 * 实测(在运行中的 app 里逐个读 computed value)排掉的路,别再走:
 *   --em-surface-base-emphasis → 「#fff」。变量有定义,但值就是白,托盘会变纯白。
 *   --color-background         → 「空」。上面那条旧注释说它是唯一还活着的 --color-*,
 *                                现在已经不成立;引用它会让整条 color-mix 失效 → rgba(0,0,0,0)。
 * 两次都是「布局全对、颜色无声消失」,截图上极难一眼看出,只有读 computed style 才现形。
 *
 * 现在这条是实测出颜色的:--em-surface-base(#fff)六成 + --em-surface-base-hover 四成
 * → srgb 0.9709 ≈ #f8f8f8,正好是 Codex 那条灰。两个变量都随主题走,暗色下自动变成
 * 「比画布深一点点」而不是被白色冲淡。走 inline style 是因为 Tailwind v4 对
 * arbitrary 的 color-mix() 不出规则(也实测过,同样是无声透明)。
 */
export const sessionComposerTrayStyle = {
  backgroundColor:
    'color-mix(in srgb, var(--em-surface-base) 60%, var(--em-surface-base-hover) 40%)',
} as const;

/** Read-only chip inside the tray (环境 / 分支) — not interactive, so no hover affordance. */
export const sessionComposerTrayChipClassName =
  'inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap';

/** 托盘里唯一可点的项(项目选择器)。@@@state-ladder-mix 悬浮走统一的 hover 档 —— 以前直接取
 *  surface-base-selected(选中档),比同一排里别的控件深一级。 */
export const sessionComposerTrayTriggerClassName =
  'inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-row-hover active:bg-row-press data-popup-open:bg-row-selected hover:text-[var(--em-foreground)]';
// @@@state-ladder-mix 「开着」这一档必须有:它按下即开弹层,真机上 `:active` 几乎立刻被
// data-popup-open 接管 —— 只写 active: 的话按下去看着像没反应(实测就是这样)。

/** Lifts the composer card over the tray so the tray only shows its top strip. */
export const sessionComposerFrameLiftClassName = 'relative z-10 -mt-2.5';

/**
 * 输入卡外面的这层 wrapper **不画任何东西**:描边、底色、投影、focus 变色全在里面那张卡
 * (session-ui `composerShell`)上,这里再画一遍就是第二层壳。
 *
 * 从前它是 `rounded-lg border bg-background`,和卡片同为 8px 圆角,两条 1px 描边完全重合,
 * 看不出是两层。#5185 把卡片圆角提到 20px(照抄 assistant-ui)之后,外层 8px 的方角就从
 * 里层圆角外面露出来,四个角各一截 —— owner 2026-09-07「怎么还重影了」圈的正是这四处。
 * 会话页没有这层壳(ChatComposer 直接落在 composerSlotInner 里),所以只有新建页重影。
 * ❌ 别改成 rounded-2xl 跟着对齐:那还是两层描边叠着,只是暂时看不见,下次调圆角又炸。
 */
export const sessionComposerFrameClassName = '';
