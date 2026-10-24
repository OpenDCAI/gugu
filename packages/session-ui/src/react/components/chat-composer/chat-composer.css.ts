import { fallbackVar, globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';
import { durFast, durMed, easeStandard } from '@session-ui/styles/effects/animations.css';

export const composerRoot = style({
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  containerType: 'inline-size',
});

/**
 * @@@composer-card-radius — 输入卡片的圆角是 `tokenVars.radiusThread`(16px),**顶上接出来的
 * 每一条 band 都必须写同一个 token**(notice / permission / queued-prompts):不一致的话
 * 接缝处会露出一级台阶。
 *
 * 为什么不抽成共享常量(第一版就是那么写的,实测退回来了):`vanilla-extract-visual-guard`
 * 是**源码文本层**的尺子,只认 `tokenVars.X` 这种按名字判得出的取值。换成跨文件别名之后,
 * 那几处圆角全部落进「未判定」—— 守卫不是变红,是**看不见了**。
 *
 * ⚠️ 这一档超过本包基准圆角(radiusMd),在 design.md 的 shape 表里有自己的名字:
 * `--radius-thread`,语义是「主输入入口」(#7333 视觉规范:24px)。原来它叫 radius2xl(20px),
 * 改名之后它不再是特例,而是表里的一档。
 * ⚠️ 它**推翻了**同文件里那条「卡片与自己弹出的浮层同圆角」的旧判断:模板本身就是卡比浮层圆
 * (bar 24 / menu 16),圆角在这里表达的是"这是最外层的那张纸",不是"同一族控件"。浮层不动。
 */

export const noticeBand = recipe({
  base: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
    // 与卡片同圆角:band 是卡片顶上接出来的一段,两者圆角不一致时接缝处会露出台阶。
    borderRadius: `${tokenVars.radiusThread} ${tokenVars.radiusThread} 0 0`,
    border: '1px solid',
    borderBottomWidth: 0,
    paddingLeft: '0.75rem',
    paddingRight: '0.75rem',
    paddingTop: '0.5rem',
    paddingBottom: '0.5rem',
    fontSize: tokenVars.textSm,
  },
  variants: {
    variant: {
      error: {
        backgroundColor: vars.surfaceDestructive,
        borderColor: vars.surfaceDestructiveBorder,
        color: vars.surfaceDestructiveForeground,
      },
      warning: {
        backgroundColor: vars.surfaceWarning,
        borderColor: vars.surfaceWarningBorder,
        color: vars.surfaceWarningForeground,
      },
      info: {
        backgroundColor: vars.surfaceInfo,
        borderColor: vars.surfaceInfoBorder,
        color: vars.surfaceInfoForeground,
      },
    },
  },
  defaultVariants: { variant: 'info' },
});

export const noticeBandBody = style({ flex: 1 });

export const noticeBandHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
});

export const noticeBandTitle = style({
  // 带正文与标题同为 13px —— 原来是 13/12,一个像素分不出主次,只是看着糊。
  // 层级改由字重承担。
  fontSize: fallbackVar(tokenVars.textSm, '13px'),
  fontWeight: tokenVars.fontWeightSemibold,
  lineHeight: 1.375,
});

export const noticeBandMessage = style({ lineHeight: 1.375 });

export const noticeBandMessageIndented = style({
  marginTop: '0.25rem',
  opacity: 0.8,
});

export const noticeDismiss = style({
  marginLeft: '0.25rem',
  flexShrink: 0,
  opacity: 0.7,
  transition: `opacity ${durFast}`,
  selectors: {
    '&:hover': { opacity: 1 },
  },
});

export const noticeAnimWrapper = style({
  display: 'grid',
  transition: `grid-template-rows ${durMed} ${easeStandard}, opacity ${durMed} ${easeStandard}`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
});

export const noticeAnimVisible = style({ gridTemplateRows: '1fr', opacity: 1 });
export const noticeAnimHidden = style({ gridTemplateRows: '0fr', opacity: 0 });

export const noticeOverflowClip = style({ overflow: 'hidden' });

// ── Composer shell ────────────────────────────────────────────────────────────

/**
 * @@@no card shadow (2026-09-22,按 design.md 统一)
 *
 * 这里原来有一个 `CARD_SHADOW = '0 1px 3px rgba(0,0,0,.1), 0 1px 2px -1px rgba(0,0,0,.1)'`
 * ——「`shadow-sm` 的两层，一字不差」。两条 design.md 同时判它出局：
 *   · 「**Shadows are zeroed globally. Only a floating surface may lift.**」
 *     composer 是**钉在版面上的一张纸**，不是浮层：它不浮起来，也不会盖住别的东西。
 *   · 「A hairline is `border-foreground/10`. **Do not stack a border, a ring, and a shadow
 *     on one edge.**」静止态它已经是 1px border + 两层投影；拖文件进来时再加一道
 *     `0 0 0 1px` 的环，同一条边上三者齐全。
 *
 * 层级没有因此变平 —— 它本来就不是投影在撑：卡片有 `vars.surfaceBaseEmphasis` 这一阶实底
 * 顶着（原注释自己写的这句话，现在它是唯一的那一格）。拖拽态也不靠环表达，靠的是同一处
 * 早就存在的底色变化（下面 `dragActive` 里那条 `color-mix`）。
 */
export const composerShell = recipe({
  base: {
    // Host-overridable via `--composer-bg`; defaults to the elevated surface.
    backgroundColor: `var(--composer-bg, ${vars.surfaceBaseEmphasis})`,
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
    border: `1px solid ${vars.border}`,
    transition: `border-color ${durFast}`,
    selectors: {
      '&:hover': { borderColor: vars.border1 },
      '&:focus-within': {
        borderColor: vars.border1,
      },
    },
  },
  variants: {
    // 圆角见文件头 @@@composer-card-radius。
    hasBand: {
      true: { borderRadius: `0 0 ${tokenVars.radiusThread} ${tokenVars.radiusThread}` },
      false: { borderRadius: tokenVars.radiusThread },
    },
    dragActive: {
      true: {
        borderColor: vars.border1,
        // ❌ 这里原来还加一道 `0 0 0 1px` 的高亮环(叠在基础投影上)。2026-09-22 连同投影一起撤:
        // 见 @@@no card shadow —— 一条边上不叠 border + ring + shadow。拖拽态由描边提亮
        // (borderColor)与整卡淡蓝(下面那条 color-mix)两件事表达,已经够读出来了。
        // 上游 `ComposerBar[data-drag-active]` 的 bg-blue-500/4%:文件悬停在卡片上时整卡淡蓝。
        backgroundColor: `color-mix(in srgb, ${vars.foregroundInfo} 5%, var(--composer-bg, ${vars.surfaceBaseEmphasis}))`,
      },
      false: {},
    },
    // 这一框是一件事(gugu-dev#181「输入框」):新任务整张变橙 —— 描边换色,外面一圈同色的浅环。
    // 悬停 / 聚焦也留在这个色上(base 里那两条会把描边换回灰)。
    tone: {
      task: {
        borderColor: `color-mix(in srgb, ${vars.foregroundConflict} 35%, ${vars.border})`,
        boxShadow: `0 0 0 3px color-mix(in srgb, ${vars.foregroundConflict} 10%, transparent)`,
        selectors: {
          '&:hover, &:focus-within': { borderColor: `color-mix(in srgb, ${vars.foregroundConflict} 45%, ${vars.border})` },
        },
      },
    },
  },
  defaultVariants: { hasBand: false, dragActive: false },
});

/** 输入行最前面那枚标签(`leading`):和第一行字同高、居中,后面是编辑器本体(照旧长满,点空白就进输入)。 */
export const editorLeadRow = style({
  display: 'flex',
  gap: '0.5rem',
  flexGrow: 1,
  flexShrink: 0,
  minWidth: 0,
});

export const editorLead = style({
  display: 'flex',
  alignItems: 'center',
  flex: 'none',
  alignSelf: 'flex-start',
  height: tokenVars.textTitleLineHeight,
});

export const editorLeadBody = style({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  minWidth: 0,
});

// ── Attachments ───────────────────────────────────────────────────────────────
//
// chip 解剖照 assistant-ui `elements-composer` 的 `ComposerAttachmentChip` 逐值转写
// (#5269;上游源:r.assistant-ui.com/elements-composer.json)。几何一个不改,只把颜色换成
// 本仓 token:field → surfaceBaseSelected、bg-background → surfaceBase、foreground/45 →
// foregroundMuted、foreground/40 → foregroundPassive、red → foregroundError、
// emerald → foregroundSuccess、blue → foregroundInfo。
//
// 上游 `[data-slot=composer-attachment]` 是 `data-state` 驱动的:uploading 转圈 + 底边进度条,
// done 有 onRemove 显 ×、没有显 ✓,error 只把 meta 变红。

export const attachmentStrip = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.5rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingTop: '0.75rem',
});

// 整块 chip 是预览的触发器(#5269)——`data-viewable` 决定它长得像不像可点的东西。上游 runtime
// 车道的 tile 用 `cursor-zoom-in` + `active:scale-[0.96]` + focus 环,这里照搬,只把「放大镜」
// 留给真的能放大的那一种:图片 zoom-in,文本是打开一份内容 ⇒ pointer。
export const attachmentChip = style({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  overflow: 'hidden',
  // chip 按自己的内容宽,❌ 被容器压窄:手机输入框的附件条是一行横滑(attachment.aui.tsx),
  // 能缩的话三五枚就挤成窄条,名字、错误原因、重试、× 全被上面的 overflow 裁掉 —— 失败的那张看不见、
  // 重传不了、删不掉,发送又被它拦着。桌面的 attachmentStrip 折行,本来就不会压。
  flexShrink: 0,
  // 上游是 14px。14 不在 design.md 的 shape 表上(表是 0/6/6/8/10/12/16/9999),
  // chip 是压出来的控件 ⇒ 落到 `radiusMd`(= --radius-control,8px)。
  borderRadius: tokenVars.radiusMd,
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  paddingLeft: '0.375rem',
  paddingRight: '0.625rem',
  backgroundColor: vars.surfaceBaseSelected,
  selectors: {
    '&[data-viewable]': {
      cursor: 'pointer',
      outline: 'none',
      transition: `transform ${durFast} ${easeStandard}`,
    },
    "&[data-viewable='image']": { cursor: 'zoom-in' },
    '&[data-viewable]:hover': { backgroundColor: vars.surfaceBaseHover },
    '&[data-viewable]:active': { transform: 'scale(0.96)' },
    '&[data-viewable]:focus-visible': { boxShadow: `0 0 0 1px ${vars.border1}` },
  },
});

// 32px 图标格。图片型附件用缩略图填格(上游 runtime 车道的 `unstable_Thumb` 语义),
// 其余按 kind 取 image / text / archive 线图。点开预览是**整块 chip** 的事,不是这一格的。
export const attachmentIconCell = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: '2rem',
  height: '2rem',
  padding: 0,
  // chip 从 14px 落到 8px 之后,格子跟着降一档(上游是 chip 14 / 格 10 的嵌套关系),
  // 否则内外同圆角,嵌套关系就没了。
  borderRadius: tokenVars.radiusSm,
  overflow: 'hidden',
  color: vars.foregroundMuted,
  backgroundColor: vars.surfaceBase,
});

export const attachmentIcon = style({
  width: '1rem',
  height: '1rem',
});

export const attachmentThumbImg = style({
  width: '2rem',
  height: '2rem',
  objectFit: 'cover',
});

export const attachmentLabel = style({
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
});

export const attachmentName = style({
  maxWidth: '9rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  // 上游是 12px;本仓字阶只有 11/13/15/17/20(check-ui-visual-spec 闸),名字取 13、meta 取 11。
  fontSize: tokenVars.textSm,
  fontWeight: 500,
  lineHeight: 1.5,
  color: vars.foreground,
});

export const attachmentMeta = recipe({
  base: {
    fontSize: tokenVars.textTiny,
    lineHeight: 1.5,
    whiteSpace: 'nowrap',
    color: vars.foregroundPassive,
  },
  variants: {
    error: {
      // 语义 token 在 embedded 入口(theme.css)下有值;主 app 树 / 浏览器测试装置没加载 theme.css,
      // 那里退到 noticeBand 同款的 destructive 前景,别让红字静默变白。
      // 失败原因是一句话(「那台机器上的咕咕 server 版本太旧…」),允许折行、限宽,❌ 把 chip 撑成一整行。
      true: {
        color: fallbackVar(vars.foregroundError, vars.surfaceDestructiveForeground),
        whiteSpace: 'normal',
        maxWidth: '15rem',
      },
      false: {},
    },
  },
  defaultVariants: { error: false },
});

// 失败原因后面那段「重试」:句子里的一段强调色文字(与会话里状态行的「重新连接」同一个样子),❌ 另起一颗按钮。
export const attachmentRetry = style({
  padding: 0,
  border: 'none',
  background: 'none',
  font: 'inherit',
  color: vars.link,
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  selectors: {
    '&:focus-visible': { outline: `1px solid ${vars.border1}`, outlineOffset: '1px' },
  },
});

export const attachmentTrailing = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  flexShrink: 0,
  width: '1.25rem',
  marginLeft: '0.25rem',
});

export const attachmentCheck = style({
  width: '0.875rem',
  height: '0.875rem',
  color: fallbackVar(vars.foregroundSuccess, vars.foregroundMuted),
});

// 上游 `ghostButton` size-5:圆形、透明底、hover 起 6% 墨、按下缩 0.96。
export const attachmentRemove = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.25rem',
  height: '1.25rem',
  padding: 0,
  borderRadius: '9999px',
  color: vars.foregroundMuted,
  outline: 'none',
  transition: `background-color ${durFast}, color ${durFast}, scale ${durFast}`,
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&:active': { scale: '0.96' },
    '&:focus-visible': { boxShadow: `0 0 0 1px ${vars.border1}` },
  },
  '@media': {
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

export const attachmentRemoveIcon = style({
  width: '0.75rem',
  height: '0.75rem',
});

// 底边进度条:只在 uploading 时挂载;done 直接卸掉,不停在 100% 上。
export const attachmentProgress = style({
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 0,
  height: '2px',
  backgroundColor: vars.foregroundInfo,
  opacity: 0.7,
  transition: `width 300ms ${easeStandard}`,
});

// ── Editor area ───────────────────────────────────────────────────────────────

// paddingBottom 撑开的是「输入行 ↔ 底排」之间那段留白 —— 卡片总高对不上 Codex,差的几乎全在
// 这一段:Codex 是 27.5px,原来只有 18px。卡片被压矮三分之一,底排就贴到了文字上,整块看着挤。
// (量法:在 Codex 原分辨率截图上扫墨迹行,再按两边托盘宽度之比归一。)
export const editorArea = style({
  // @@@composer-click-target — 这块**整体**是输入区,不是「一行文字 + 一片死白」。
  //
  // owner 2026-09-09 圈的就是这个:min-height 把卡片撑到 66px,可编辑元素却只有一行(21px),
  // 剩下的 45px 加上四边内距全是死区 —— 点下去什么也不发生,得瞄准那一行才进得了输入。
  // 一个「看着是输入框、点了没反应」的区域比没有这块留白更糟。
  //
  // 两段合起来才补全:① 这里 flex 列 + 里面编辑器 flex-grow(prompt-editor.css.ts),
  // 让可编辑元素**长满内容盒**,点空白落在 ProseMirror 上、光标按原生规则就近落位;
  // ② 四边内距落不到编辑器身上,由 index.tsx 那个 onMouseDown 兜底聚焦。
  // cursor 一并跟上:整块读作可输入,鼠标就得是 I 字梁,❌ 别只让那一行是。
  display: 'flex',
  flexDirection: 'column',
  cursor: 'text',
  // @@@composer-input-min-height — 空 composer 也得有厚度。
  //
  // owner 2026-09-07 圈的是同一张卡:「不贴底啊,大片空白,框显得很宽,像个大嘴巴」。
  // 真机量过:卡片 766×92,**宽高比 8.33** —— 一条横躺的缝。人对"输入区"的预期是一块地方,
  // 不是一条线;而这张卡在宽屏(xl 起 max-w-3xl)只会更扁。
  //
  // 44px 是 assistant-ui composer 给输入本体的 `min-h-11`。加上本仓上下内距(12+20)= 76,
  // 卡片落在 ~116 高、宽高比 6.6(672 宽时 ~5.8)——**下限**而已,打字长了照常长高到 200 封顶。
  //
  // ❌ 别改成垂直居中:这是会长高的编辑器,居中在第二行出现之后就不成立;文字顶对齐、
  //    下面留出的空是「还能接着写」的余量,与模板同义。
  // ❌ 也别靠加 padding 补:padding 会把长文本的可视区一起顶掉,min-height 只在空的时候起作用。
  //
  // ⚠️ 这个数是**含内距**的(border-box),所以不是 44 而是 44 + 12 + 20 = 76px。
  //    写 44 的话它比现状(52)还小 —— 一条不起作用的声明,静默无效。
  //
  // ⚠️ 这个数是**含内距**的(border-box):一行文字(行高 24)+ 上下内距(14+8) = 46px —— 再低就是文字自己撑着,写了不起作用。
  // owner 2026-10-23「平时这个输入框是不是太高了一点」:空着时的编辑区从 66 降到一行,框空着 90 高。
  minHeight: '2.875rem',
  selectors: {
    [`${composerRoot}:not([data-mobile]):not([data-phone-shell] *) &`]: {
      // Restore the desktop editor's previous empty height; phones keep one line.
      minHeight: 'calc(2.875rem + var(--spacing-xl))',
    },
  },
  maxHeight: '200px',
  overflowY: 'auto',
  // 内距照 assistant-ui composer:那张卡是「外沿 10px + 输入自己再缩 12px」= 文字左缘 22px,
  // 底排按钮左缘 10px。两个数不相等是上游有意的 —— 按钮是方的、有自己的点击区,文字没有。
  paddingLeft: '1.375rem',
  paddingRight: '1.375rem',
  paddingTop: '0.875rem',
  paddingBottom: '0.5rem',
});

// ── Toolbar ───────────────────────────────────────────────────────────────────

export const toolbar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.375rem',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  // 上边距归 0:编辑区的 paddingBottom 已经是两者之间的那道缝(模板的 gap-2)。
  paddingTop: 0,
  // 底排到卡片下沿 = 卡片外沿 10px,与左右外沿同一个数(模板 p-2.5 四边等距)。
  paddingBottom: '0.625rem',
  // ❌ 不换行。换行的代价 owner 2026-09-05 圈过三条:卡片跟着某个标签的长度长高;
  // 左右两组各占一行、每行只用掉三分之二宽度;发送键离开右下角那个固定位置。
  // 放不下改由**渐进披露**承担(见 use-toolbar-disclosure.ts):先把有图标的标签收成图标,
  // 最后才让模型名用省略号收尾。
  flexWrap: 'nowrap',
});

// 左边是附件 · 权限 · toolbarExtra。
//
// ⚠️ 这里原来写 `flexShrink: 0`,理由是「全是短标签」—— **那个前提不成立**:`toolbarExtra` 里
// 装着 harness / platform 那两句提示,是长度不可控的外部串(主进程原样转达的失败原因、
// 厂商登录方式名),自带 `max-w-[22rem]`。一个宽 22rem 又不肯让位的左组,会把右边的
// [引擎 | 模型 | 发送] 一路顶出卡片 —— owner 2026-08-26 实测:切到 Qwen / Kimi / Qoder
// 都是这个形状,「模型 Defaul…」被窗口右沿切掉。
//
// ⇒ 左组可收缩,但**只有文字提示让位**:`role="status"` 之外的都是图标或短标签控件,
//   压扁它们等于把可点区域挤没。提示自己有 truncate,收缩时以省略号收尾,全文在 title 里。
export const toolbarLeft = style({
  display: 'flex',
  minWidth: 0,
  flexShrink: 1,
  alignItems: 'center',
  gap: '0.375rem',
});
// ⚠️ 只能用 globalStyle:vanilla-extract 的 `selectors` 要求 `&` 就是被选中的那个元素,
//    `'& > *'` 选的是子元素,构建期直接判非法。
globalStyle(`${toolbarLeft} > *:not([role="status"])`, {
  flexShrink: 0,
});
// 变长的是模型名(harness + 模型 + 强度都在这边),所以让位的应该是右边:
// minWidth:0 + 可收缩,里层 trigger 自己 ellipsis 截断,不会把发送键挤出卡片。
export const toolbarRight = style({
  display: 'flex',
  alignItems: 'center',
  // 与 toolbarLeft 同一个数:两组间距不等的话,一排读起来不是"左一组右一组",
  // 而是"六个东西间距忽宽忽窄"(模板两组都是 gap-1.5)。
  gap: '0.375rem',
  // 在最后一档之前**不让位**:让位就没有溢出信号,阶梯走不起来(见文件末尾)。
  // 到了最后一档才开可压缩,由模型名的 ellipsis 收尾。
  flexShrink: 0,
});

/**
 * 权限那颗要跟 `agentTrigger` 长成同一族(同高、同圆、同内距、同色阶)。
 *
 * `&&` 是为了压过 ComboboxPopover 自带的 `trigger` —— 两者都是单类,谁赢取决于 VE 的输出
 * 顺序,那是随 import 顺序漂的。翻倍选择器把它钉死。❌ 别改 combobox 的 `trigger`:
 * 那一份管着全 app 9 个下拉,底排的形状不该外溢出去。
 */
export const permissionModeTrigger = style({
  selectors: {
    '&&': {
      height: '2rem',
      // 形见 agentTrigger 抬头的 @@@bottom-row-shape。
      borderRadius: tokenVars.radiusMd,
      paddingLeft: '0.75rem',
      paddingRight: '0.75rem',
      color: vars.foregroundMuted,
      transition: `color ${durFast}, background-color ${durFast}`,
    },
    '&&:hover': { color: vars.foreground },
    '&&[data-popup-open]': { color: vars.foreground },
  },
});

// 颜色继承触发器(见 agentTrigger 抬头的三档),只有"会造成破坏"的那一档自己染色 ——
// ❌ 别在这里写 `vars.foreground`:那正是从前让整排跟正文一样黑的那一手。
export const permissionModeContent = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  color: 'inherit',
  fontSize: tokenVars.textSm,
  lineHeight: 1.25,
});

// ❌ 这里原来有个 `permissionModeContentSelected`(选中时给正文色),已撤:
// 底排整排退成次级灰之后,唯独"已选中"那颗变黑,它就成了整排最跳的东西 ——
// 而它并不比旁边的模型名更该被先读到。选中与否由触发器的填充表达,不由字色。

/**
 * 完全访问档:整排压灰之后,这抹橙是**整张卡里唯一的彩色**,颜色单独就够当记号了。
 * `&&` 压过 permissionModeContent 的 `color: inherit`。
 */
export const permissionModeContentDestructive = style({
  selectors: { '&&': { color: vars.foregroundWarning } },
});

// ❌ permissionModeItem 同样并入 @@@composer-panel-row(composerPanelItemText)。

// ❌ 这里原来有 permissionModeItemName / permissionModeItemDescription,
// 已并入 @@@composer-panel-row 那一族 —— 两套写法正是"三个面板三种长相"的来源。

// @@@task-fusion (#2802) — agent 行的动作(目前只有「安装」)。
// 静息 opacity: 0 —— 32 个没装的 agent 各挂一枚同样的标签是噪声不是信号(owner 判过一次
// 「设计不行」)。指到哪行才把动作显出来;正在安装的那行(data-busy)则一直显示,因为那是
// 一个真在发生、需要被看见的瞬时状态,不是常驻装饰。
export const agentRowAction = style({
  flexShrink: 0,
  marginLeft: 'auto',
  paddingLeft: '0.5rem',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textSm,
  whiteSpace: 'nowrap',
  opacity: 0,
  transition: 'opacity var(--dur-fast) ease',
  selectors: {
    '[data-highlighted] &': { opacity: 1 },
    '&[data-busy]': { opacity: 1 },
  },
})

/**
 * 名字后面的发布阶段标(目前只有「Beta」,#6335)。与宿主 renderer 的 `Badge variant="outline"` 同一套口径:
 * 墨色描边、不上色(ui-visual-spec ② Chrome is ink —— 彩色类别徽标是 design.md Reject 列表点名的)、
 * `radiusSm`(6px,半径表里徽标那一档,❌ 不是胶囊)、`textTiny`(11px,字阶最小一档)。
 * ⚠️ 与 `agentRowAction` 不同,它**常驻** —— 它说的是「这一家是什么」,不是「指到这行能做什么」。
 */
export const agentRowBadge = style({
  flexShrink: 0,
  marginLeft: '0.375rem',
  paddingLeft: '0.25rem',
  paddingRight: '0.25rem',
  border: `1px solid ${vars.border}`,
  borderRadius: tokenVars.radiusSm,
  color: vars.foregroundMuted,
  fontSize: fallbackVar(tokenVars.textTiny, '11px'),
  lineHeight: fallbackVar(tokenVars.textTinyLineHeight, '1rem'),
  fontWeight: 500,
  whiteSpace: 'nowrap',
});

// ── Agent trigger ─────────────────────────────────────────────────────────────

export const agentTrigger = style({
  display: 'flex',
  // ⚠️ 这里**故意不写** `minWidth: 0`。写了它就常开可压缩,行于是永远塞得下,
  // `scrollWidth > clientWidth` 这个信号永远不出现 —— 阶梯一档都不会走,
  // 模型名会抢在「收标签」之前先被压成省略号(2026-09-05 实测:档位恒为 0)。
  // 可压缩只在最后一档打开,见本文件末尾的 @@@composer-toolbar-disclosure。
  // @@@composer-three-tiers — assistant-ui composer 的清爽不是靠控件少,是靠**三档拉开**:
  //   一档 输入正文  15px + `vars.foreground`      ← 全卡唯一该被读的东西
  //   二档 底排整排  13px + `vars.foregroundMuted` ← 静止时退成背景,悬浮/展开才提到正文色
  //   三档 发送键    唯一的实心圆
  // ⚠️ 从前这里是 `color: vars.foreground` —— 与输入正文同色同字号。于是「Claude」「Opus」
  // 跟用户打的字一样黑,一排六个控件全在喊,眼睛没有落点,读成一串(owner「像是下饺子」)。
  // **病根是色阶没拉开,不是控件太多** —— 别靠删控件治它。
  //
  // 字号仍是 13px:模板那档是 12.5px,但咕咕字阶只有 11/13/15/17/20,且 `check-ui-visual-spec`
  // 把 12px / 14px / 半像素字号定成硬闸。所以这一档靠**颜色**拉开,不靠字号。
  //
  // @@@bottom-row-shape (2026-09-22,按 design.md 统一) —— 底排的触发器类(agent / 模型 /
  // 权限 / 附件)全部退回 `radiusMd`(8px)。原裁决是「全圆 + 2rem 高:与附件键、发送键同高同形,
  // 一排读成同一族」。被推翻的是**形**这一半:design.md 的 shape 表把 `--radius-capsule`(9999)
  // 只发给「switch, avatar, status dot」,并明写「Marketing CTAs are 8px rectangles. Never pills.」;
  // 而「一排读成同一族」这件事由**同高(2rem)+ 同色阶(二档灰)**保住,不需要药丸。
  // 发送键不动 —— 它是一枚 ink 实心点,语义就在 status dot 那一格。
  height: '2rem',
  alignItems: 'center',
  gap: '0.375rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  borderRadius: tokenVars.radiusMd,
  border: '1px solid transparent',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textSm,
  outline: 'none',
  transition: `color ${durFast}, background-color ${durFast}`,
  selectors: {
    // @@@state-ladder-mix 三态各归各档。以前 hover 与 popup-open 同取 surfaceBaseSelected(选中档),
    // 结果是:①悬浮直接跳到选中那一档,比同一排里的 `+`/用量圈(surfaceHover)深一倍;②菜单开着和
    // 单纯悬浮长得一模一样,开没开看不出来。
    '&:hover': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&[data-popup-open]': { backgroundColor: vars.surfaceSelected, color: vars.foreground },
    '&:active:not(:disabled)': {
      backgroundColor: `var(--em-surface-press, ${vars.surfaceSelected})`,
      color: vars.foreground,
    },
  },
});

/** Send button override — fully rounded pill shape. */
// flexShrink:0 —— toolbarRight 现在可收缩,发送键必须是那个不让位的,
// 否则长模型名会把它压成一条缝(该截断的是模型名,不是这颗按钮)。
/**
 * 附件键 —— 静止时退到次级灰(与同排触发器同一档,见 `agentTrigger` 抬头)。
 * ghost 变体本身不定颜色,不写这一条它就继承正文色,在整排压灰之后反而成了最黑的那个。
 *
 * ⚠️ 形见 @@@bottom-row-shape:2026-09-22 起它不再是正圆,与同排触发器一起走 `radiusMd`。
 * (导出名里的 `Round` 是那一版留下的,改名要动消费点,留着并在这里注明。)
 */
export const attachButtonRound = style({
  borderRadius: tokenVars.radiusMd,
  selectors: {
    '&&': { color: vars.foregroundMuted },
    '&&:hover': { color: vars.foreground },
  },
});

/** Send / stop 共同的形状 —— 正圆。 */
export const sendButtonRound = style({ borderRadius: tokenVars.radiusFull, flexShrink: 0 });

/**
 * 发送键的配色(三档里的第三档)：**全卡唯一的实心圆**。
 *
 * 走 `foreground` / `surfaceBase` 而不是 primary 那对强调色 —— 这是模板的 ink:能发时是一颗
 * 与正文同色的实心圆,亮暗自动对调。咕咕的 accent 在 owner 那台机器上是中灰(实测 #7d7d7d),
 * 当"整排唯一的落点"太弱。
 *
 * 不能发时**不用 opacity 压暗**:半透明的深色圆看着像"能点但坏了"。换成"比卡片高一阶的浅底 +
 * 惰性前景",一眼是"还不能按",不是"按了没反应"。两个都取 token 而不是百分比硬编码:
 * 暗色下卡片自己就是深的,固定百分比会糊成一片。
 *
 * ❌ 不给停止键用这套:停止是 destructive,红色是它在说"这会中断正在跑的东西"。
 */
export const sendButtonInk = style({
  selectors: {
    '&&': {
      backgroundColor: vars.foreground,
      color: vars.surfaceBase,
      borderColor: 'transparent',
    },
    // @@@state-ladder-mix 实心圆走透明度阶梯 hover .88 → 按下 .78,与全产品的填充钮同一配方
    // (以前 hover 是 .9、且**没有按下态** —— 整排里唯一的落点按下去毫无反应)。
    '&&:hover': { backgroundColor: vars.foreground, opacity: 0.88 },
    '&&:active:not(:disabled):not([data-disabled])': {
      backgroundColor: vars.foreground,
      opacity: 0.78,
    },
    '&&:disabled, &&[data-disabled]': {
      opacity: 1,
      // @@@state-ladder-mix 这里要的是「比卡片高一阶的**中性**浅底」。以前取 surfaceBaseSelected,
      // 而统一阶梯后 selected 在浅色下带蓝 tint —— 蓝色的禁用圆读起来像"选中了",不像"还不能按"。
      // 换成中性的那一档(press 档 = 5% 中性叠色),深浅与原来相当,但不带色相。
      backgroundColor: `var(--em-surface-press, ${vars.surfaceBaseSelected})`,
      color: vars.foregroundPassive,
    },
  },
});

// 按钮从 1.5rem 长到 2rem,方块跟着从 0.5rem 到 0.75rem —— 模板的停止是 size-3。
// 不跟着长的话,大圆里嵌一个小方块会看着像没画完。
export const stopIcon = style({
  width: '0.75rem',
  height: '0.75rem',
  borderRadius: '0.0625rem',
  backgroundColor: 'currentColor',
});

// ── Context usage indicator ────────────────────────────────────────────────────

/**
 * 触发器上那行读数 —— 直接写「用了多少 / 一共多少」。
 *
 * 2026-09-22 按 design.md 统一。原来这里是一枚**百分比圆环**(SVG donut,
 * `strokeDasharray={pct} 100`)。design.md 的 Reject 列表逐字点名了这个形式:
 * 「The stock chat idiom inside our chat: … a percentage context ring」——
 * 它被否的不是配色(那是干净的中性灰 + 警戒橙),是**这个形式本身**:
 * 一圈弧线要人换算才读得出「还剩多少」,而同一份数字写出来就是答案。
 * 圆环删掉之后,弹层里那条线性条成了这个分数唯一的图形表达(从前两者并存)。
 *
 * mono:design.md 里 mono 的一份工作就是 **a count**(见 usageTokenCount 那条)。
 * `tabular-nums` —— 流式推进时数字每秒都在跳,等宽数位让这行不左右抖。
 */
export const usageReading = style({
  fontFamily: tokenVars.fontMono,
  fontSize: tokenVars.textTiny,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1.25,
  color: vars.foregroundMuted,
  whiteSpace: 'nowrap',
});

/** 读数的警戒档(>= 90% 满) —— 与弹层里那条线性条同一个色。 */
export const usageReadingWarn = style({
  color: vars.surfaceWarningForeground,
});

/** Provider-reported cost. Rendered only for an explicitly known BYOK route. */
export const usageCostRow = style({
  marginTop: '0.625rem',
  fontSize: tokenVars.textTiny,
  color: vars.foregroundMuted,
});

export const usagePopoverBody = style({
  width: '16rem',
});

export const usageStatsRow = style({
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '1rem',
  fontSize: tokenVars.textTiny,
});

export const usagePercent = style({
  fontWeight: 500,
  color: vars.foreground,
});

/**
 * `12.3k / 100k tokens` —— mono。design.md 给 mono 的工作里就有 **a count**
 * (「a command, a package name, a path, an identifier, a version, a count」),
 * 这一处正是那一格;2026-09-22 之前它走的是普通字体。
 */
export const usageTokenCount = style({
  fontFamily: tokenVars.fontMono,
  fontVariantNumeric: 'tabular-nums',
  color: vars.foregroundMuted,
  whiteSpace: 'nowrap',
});

export const usageBarTrack = style({
  marginTop: '0.5rem',
  height: '0.375rem',
  overflow: 'hidden',
  borderRadius: tokenVars.radiusFull,
  backgroundColor: vars.border,
});

export const usageBarFill = style({
  height: '100%',
  borderRadius: tokenVars.radiusFull,
  backgroundColor: vars.foreground,
});

export const usageBarFillWarn = style({
  backgroundColor: vars.surfaceWarningForeground,
});

// ── Effort row (footer inside the model popover) ───────────────────────────────

/**
 * 设置面板里的一行(模型 / 推理强度):左标签、右当前值 + ›,点开向右飞出二级。
 * 两行共用这一套样式 —— Codex 里它们是并列且同构的,不是「列表 + 页脚」的主次关系。
 */
export const settingRow = style({
  display: 'flex',
  width: '100%',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  fontSize: fallbackVar(tokenVars.textSm, '13px'),
  color: vars.foreground,
  background: 'transparent',
  border: 'none',
  cursor: 'default',
  outline: 'none',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover },
    // @@@state-ladder-mix 开着的下拉是「持久选中」语义,必须比悬浮深一档,否则开没开看不出来。
    '&[data-popup-open]': { backgroundColor: vars.surfaceSelected },
    '&:active:not(:disabled)': {
      backgroundColor: `var(--em-surface-press, ${vars.surfaceSelected})`,
    },
  },
});

/**
 * 模型清单里那条「去登录」。
 *
 * ⚠️ **2026-08-28 从一枚标签改成一条菜单项**:它现在排在自家模型之后、与它们并列
 * (渐进披露,见 `ComposerModelUnlock`),所以它该长得像清单里的一条,
 * ❌ 不再是塞在行右侧值位上的那枚药丸 —— 那个形状是给「占住模型行」用的,那一版已撤。
 *
 * 只改文字色:用 token 里现成的 info 前景,让它跟旁边的模型条目一眼可分(是动作不是取值),
 * 又不至于变成一块自创配色的彩片。❌ 不加边框/底色 —— 菜单项自己有 hover 态。
 */
export const settingRowUnlock = style({
  color: vars.surfaceInfoForeground,
  whiteSpace: 'nowrap',
});

/** 二级列表:模型/档位多了自己滚,不外溢出面板。 */
export const settingSubContent = style({
  minWidth: '11rem',
  maxHeight: '18rem',
  overflowY: 'auto',
});

// ── Model trigger（底排右侧「5.6 Sol 轻度 ∨」）─────────────────────────────────

export const modelTriggerLabel = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: 1.25,
});

export const modelTriggerEffort = style({
  flexShrink: 0,
  color: vars.foregroundMuted,
  lineHeight: 1.25,
});

// ❌ 这里曾有 modelTriggerChevron —— 底排三枚下拉箭头一并撤,见
// composer-model-menu.tsx 的 @@@composer-no-chevron。样式跟着它的唯一消费方一起删,
// 留着就是下一个人以为「还有个箭头没接上」的来源。

// ── Model / effort 条目（#4981 A3，照 elements-model-selector 的解剖）─────────────
//
// 上游一条模型是「名字一行 + 灰色说明一行」，我们原来只有名字、说明折进 title。
// 说明是插件真声明过的数据（`ComposerModelOption.description`），折在 title 里等于
// 只有把鼠标停上去的人才看得见 —— 换成上游那种两行，信息回到眼前。
// ❌ 仍不给列表配搜索框：owner 定的，声明模型的 5 家最多 6 个，搜索是凭空的复杂度。

// ── 渐进披露:放不下时按档收标签(见 use-toolbar-disclosure.ts)──────────────────
//
// 只收「图标已经说得清」的那两个:agent 有品牌图形,权限有形状 + 颜色编码的图标。
// ❌ 不收「编程 | 通用」——owner 2026-08-21 定过选不了的那一头要留在原地并说明原因,
//    而且它是两段各有名字的分段控件,收成图标就退回只给一头起名的旧形态。
// 收起的名字仍在触发器的 title 里,悬浮可见。

export const agentTriggerLabel = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

export const permissionModeLabel = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

/**
 * @@@composer-permission-icon 的配对规则 —— 图标与名字**互补**,永远只显示一个。
 *
 * 档 0/1:名字在 → 图标是重复,藏掉(owner 2026-09-07「感叹号图标也没必要」)。
 * 档 2/3:名字被下面那条收掉 → 图标是仅剩的身份,显出来。
 *
 * ⚠️ 这两条必须**一起看**:只加上面那条(藏图标)会让档 2 变成一个空药丸;
 * 只删 JSX 里的图标则连档 2 的补救都没有了。判据钉在
 * `apps/desktop/src/session/renderer/tests/browser/composer-permission-icon.test.tsx`。
 */
export const permissionModeIcon = style({ display: 'none' })

globalStyle(
  `[data-slot="composer-toolbar"]:is([data-disclosure="2"], [data-disclosure="3"], [data-disclosure="4"], [data-disclosure="5"], [data-disclosure="6"]) ${permissionModeIcon}`,
  { display: 'inline-flex' },
)

// 档 1:agent 名字让位。档 2 起:权限名字也让位。
// ⚠️ 每条都要把**比它高的档一起列进去**,否则再升一档时收起的东西会跑回来。
globalStyle(
  `[data-slot="composer-toolbar"]:is([data-disclosure="1"], [data-disclosure="2"], [data-disclosure="3"], [data-disclosure="4"], [data-disclosure="5"], [data-disclosure="6"]) ${agentTriggerLabel}`,
  { display: 'none' },
)
globalStyle(
  `[data-slot="composer-toolbar"]:is([data-disclosure="2"], [data-disclosure="3"], [data-disclosure="4"], [data-disclosure="5"], [data-disclosure="6"]) ${permissionModeLabel}`,
  { display: 'none' },
)

/** 上下文用量读数那颗(档 4 起让位)。 */
export const usageTrigger = style({})
/** 任务开始后换不了的 agent —— 静态的那颗图标(档 5 起让位;能选的那颗不收)。 */
export const agentLockedIndicator = style({})

// 档 4:用量读数让位。档 5:锁着的 agent 让位。档 6:模型名与强度让位,只剩厂商图形(没有图形的不收,靠 ellipsis)。
globalStyle(`[data-slot="composer-toolbar"]:is([data-disclosure="4"], [data-disclosure="5"], [data-disclosure="6"]) ${usageTrigger}`, { display: 'none' })
globalStyle(`[data-slot="composer-toolbar"]:is([data-disclosure="5"], [data-disclosure="6"]) ${agentLockedIndicator}`, { display: 'none' })

// 档 3 收的是「编程 | 通用」那个分段控件 —— 它自己按档位换渲染(见 session-view-control.tsx),
// 不在这里用 CSS 藏,因为藏掉一半就点不到那一半了,那是假控件。
//
// ❌ 试过「把三枚下拉箭头一起收掉」,owner 2026-09-05 看完实机对比判「箭头收了不合适」,已撤。
//
// 最后一档(= 档 6):该收的都收完还是放不下,才把「可压缩」打开,由模型名 ellipsis 收尾。
// ❌ 这两条必须钉在**最后一档**,别留在中间档:中间档一旦可压缩,行就塞得下了,
//    `scrollWidth > clientWidth` 消失,阶梯**再也爬不到下一档**(实测过,档位恒 0)。
//    加新档时这两条要跟着挪,否则新档是死的。
globalStyle(`[data-slot="composer-toolbar"][data-disclosure="6"] ${toolbarRight}`, {
  minWidth: 0,
  flexShrink: 1,
})
globalStyle(`[data-slot="composer-toolbar"][data-disclosure="6"] ${agentTrigger}`, {
  minWidth: 0,
})

// ── Model panel（照 assistant-ui 的「With search, provider filters + groups」）──
//
// owner 2026-09-05 令严格套用那一版。上游用的是 Tailwind + shadcn 的语义类
// (`border-b`/`text-muted-foreground`/`data-pressed:bg-accent`),本仓不收 shadcn 类名,
// 所以逐条换成 token —— 换的是**写法**不是**形状**:间距、圆角、字号、按下态的强弱关系
// 都按上游那份照抄。

/** 分档过滤条。上游:`flex flex-wrap gap-1 border-b px-3 py-2`。 */
export const modelFilterRow = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0.25rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
  borderBottom: `1px solid ${vars.border}`,
});

/**
 * 厂商过滤条本身:**一样大、各自分开**的几块(owner 2026-10-10:「按钮块的大小能保持一致,
 * 有时候智谱那块太小了,不好点」)。原来是一排按字宽收缩的药丸,`智谱` 两个字只有 40px 宽,
 * 旁边 `DeepSeek` 75px。
 *
 * ❌ 别做成一条底色里的分段控件:试过,owner 同日:「不同厂家怎么连在一块了」—— 几家共用一条底,
 * 看着像一个控件而不是几个能各自按下的开关。
 *
 * 为什么去掉每颗的描边:四颗都撑到最宽那颗(75px)要 312px,面板内容区只有 264px;
 * 每块 63px 时描边会贴着 `Anthropic` 的字,换成铺底就不显挤。
 * 列数由 tsx 按家数算(`providerFilterColumns`),这里只管格子等宽。
 */
export const modelProviderFilter = style({
  display: 'grid',
  flex: '1 1 auto',
  minWidth: 0,
  gap: '0.25rem',
});

/**
 * 一块过滤片:静息铺浅底,按下换成选中色。
 *
 * ⚠️ 按下态**必须比 hover 强**:hover 只把字压深,按下才换底 —— 底色取 surfaceSelected,
 * 与清单里**选中那一行**同一个色,整张面板里「选中」只有一种说法。
 *
 * 左右内距只留 2px:63px 的块里 `Anthropic`(11px)占 57px。放不下时省略号收尾,tsx 挂了全名的 title。
 */
export const modelFilterChip = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  borderRadius: tokenVars.radiusMd,
  border: 'none',
  paddingLeft: '0.125rem',
  paddingRight: '0.125rem',
  paddingTop: '0.1875rem',
  paddingBottom: '0.1875rem',
  fontSize: tokenVars.textTiny,
  lineHeight: 1.5,
  color: vars.foregroundMuted,
  backgroundColor: vars.surfaceHover,
  cursor: 'default',
  outline: 'none',
  transition: `color ${durFast} ${easeStandard}, background-color ${durFast} ${easeStandard}`,
  selectors: {
    '&:hover': { color: vars.foreground },
    '&:focus-visible': { outline: `1px solid ${vars.borderPrimary}`, outlineOffset: '-1px' },
    '&[data-pressed]': {
      backgroundColor: vars.surfaceSelected,
      color: vars.foreground,
    },
  },
});

/**
 * 底部「思考」那一段 —— 档位控件(owner 2026-09-17 指定)。
 *
 * ## 2026-10-10 缩小一号(下面那张实测表是 09-17 的原尺寸,形状照旧、只是整体变小)
 *
 * 模型行改成单行 30px 之后,owner:「思考那一块显得特别大,不够精致……前面那些都做得很精致,
 * 这里可以做得更统一一点」。原来整段 86px:13px 半粗读数一行、说明一行、24px 轨道配 24px 圆钮。
 * 现在:读数降到 11px(与标签、底部「管理模型」同一档字),说明跟在读数后面同一行,
 * 轨道 12px、圆钮 16px —— 由 24/28 按一半缩,保留胖轨道的形状。
 * ❌ 别再缩成一根线:试过 6/14(shadcn 的比例),owner 同日:「又改的太细了」。整段约 56px。
 * 填充收在圆心、圆钮比轨道高、刻点对圆心这三条不变,只是数换了。
 *
 * ## 尺寸来源:对着 owner 的两张原始截图**逐像素量的**,不是照着图估
 *
 * 截图 3840×2100 的 2× retina,下面都换算成 CSS px:
 *
 *   轨道      高 24(设备 130→178)、全圆角、底 #EBEBEB、外缘 1px #DDD
 *   圆钮      静止 **28**(设备 127→181),拖动时 **32**(设备 285→348),白,上下各探出轨道 2px
 *   填充      **铺到圆钮圆心底下**,被圆钮外那道 1px 亮环切出一条发丝缝 ——
 *             实测蓝色右缘沿圆钮的圆弧凹进去(295/291/288/286/285/284/284/285/287/289/292),
 *             与白色左缘始终隔 1–2 设备像素。⚠️ 第一版把填充**截在圆钮左缘**,
 *             于是圆头与正圆之间留下一块梭形空白 —— owner 2026-09-17 圈出来的就是它。
 *   刻点      直径 4、两端各缩进半个圆钮、等距;走过的是填充色掺白
 *   读数      14px 半粗,与填充同色系;下面一行 12px 灰
 *
 * ## 交互与动效(有出处,不是拍脑袋)
 *
 * Material 3「Sliders/Guidelines」:*The handle changes shape to indicate when it's pressed*;
 * *Slider with stop indicators: the handle snaps to the closest stop indicator while dragged*。
 * Smashing「Designing The Perfect Slider UX」:*we could also enlarge the handle … on tap and
 * when the slider is being dragged*、*change the color of the track*、以及最要紧的一条 ——
 * ***everything stays in sync … without noticeable lag; a slider should never freeze***。
 * ⇒ 所以 hover 只换颜色(不换形,与本包 hover 规约一致)、按下才变形;
 *   而**填充与圆钮必须同一条时间曲线**,拖动时更要一并关掉过渡(见 modelEffortIndicator)。
 *
 * ## 三处刻意不照抄
 *
 * ① **颜色不抄它的蓝。** 上游 #339CFF 是 accent 阶梯的**鲜亮档**;咕咕的
 *    `--composer-accent` 被宿主钉在 jade-12(近黑,发送键那颗),拿它铺 264px 会糊成一坨黑。
 *    按 Radix 阶梯各取各的:色块走 9、文字走 11。
 * ② **读数不抄它的对比度。** 上游 #339CFF 压白底只有 2.6:1,不合 WCAG AA;阶梯 11 是 4.56:1。
 * ③ **不抄它的居中。** 上游那张卡里只有这一个控件;咕咕这一段坐在一列左对齐的模型行下面。
 *
 * ## 已知取舍
 *
 * Smashing 那篇与 Microsoft 的 Win32 指南都说:**选项少于四个时滑杆不如单选按钮**
 * (*whenever only a few options are available, using a discrete slider … might feel a bit
 * awkward*)。咕咕已知的引擎都是 5–7 档,所以这里仍用滑杆;只有**恰好一档**时不画滑杆
 * (那是一条拖不动的死轨道,见 composer-model-menu.tsx 里 `effortItems.length > 1` 那道闸)。
 * 同文还建议关键刻点间距 ≥65px,264px 放 7 档只有 39px —— 我们靠**吸附**和键盘补偿,
 * 而不是把面板撑宽。
 */
export const modelEffortRow = style({
  display: 'flex',
  flexDirection: 'column',
  // ⚠️ 面板是 flex 列、清单那半边可滚。清单一长(实机 19 条模型)面板顶到 max-height 时,
  // 这一段作为 flex 项目会**被压扁**(实测同一份档位表在矮面板 73px、高面板 69.35px),
  // 读数那行的字先被挤掉。可滚的是清单,不是控件:这里钉死不缩。
  flexShrink: 0,
  // 三段之间的缝**不等宽**,因为它们不是三件并列的东西:
  // 「档名 + 它的说明」是同一句话的两半,贴紧(4px);滑杆是另一件事,离远一点(见下面的 marginTop)。
  // ⚠️ 原来三段一律 10px、上下各 10px 内边距 —— 整块 104px 里有 41px 是空白,
  // 而内容只有 63px(标题 20 + 说明 15 + 滑杆 28)。owner 2026-09-17:「再紧凑一点」。
  // 10-10 起说明并进了读数那一行,这里只剩「读数行」与「滑杆」两件(锁住时中间多一行原因)。
  gap: '0.375rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
  borderTop: `1px solid ${vars.border}`,
  // #5627 —— 这一行是清单的**兄弟节点**、排在清单之后,位置本来就对;但它没有底,
  // 于是可滚的清单(maxHeight 18rem + overflowY auto)从它**底下**滚过去,
  // 档位标签画在模型行上(owner 实测 8 对叠字)。用面板自己的背景 token,
  // ❌ 不新拍颜色、❌ 不用半透明、❌ 不动位置。
  backgroundColor: vars.surfaceBase,
});

/**
 * 读数那一行:`标签 读数 说明…… 复位`。
 *
 * ⚠️ **左对齐,不照抄上游的居中**(理由见抬头 ③)。标签与读数贴在一起而不是分居两端:
 * 「思考」是在说明「高」是什么,两个词离得越远这层关系越弱。
 *
 * 四个格子 `auto auto minmax(0,1fr) auto`:标签、读数按内容宽;**说明占 1fr**(它是被拉伸、
 * 也是被省略的那个 —— 档名比说明要紧);复位钮按内容宽贴最右。
 * `align-items: baseline` —— 文字三格按基线对齐;复位钮是纯图标、没有文字基线,
 * 它自己改回中线对齐(见 modelEffortReset)。
 */
export const modelEffortHeader = style({
  display: 'grid',
  gridTemplateColumns: 'auto auto minmax(0, 1fr) auto',
  alignItems: 'baseline',
  gap: '0.375rem',
  // ⚠️ 高度写死:档名是**会变的文字**,而中日韩字形的行盒比拉丁高 —— claude 活会话报的
  // 那份档位表恰好中英混排(`Default` / `低` / … / `UltraCode`),不写死就会在拖动时
  // 让整张面板抖 3.5px(实测)。1rem = 16px:11px 字 + 中日韩行盒放得下。
  height: '1rem',
});

export const modelEffortLabel = style({
  justifySelf: 'start',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundMuted,
});

/**
 * 当前档名 —— 这一段的主角:半粗、强调色的**可读档**(见抬头 ②)。
 * 10-10 起与标签同一档字号(原来大一档 13px,owner 嫌这一段「特别大」),主次靠字重和颜色分。
 */
export const modelEffortValue = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  fontWeight: 600,
  color: 'var(--composer-effort-text)',
  selectors: {
    // 一档都没生效时这里写的是「默认」——它**不是一个档位**,所以❌ 不给强调色:
    // 强调色在这一段里的意思是"当前生效的那一档",拿它去染一个占位词会把这层意思说没。
    '&[data-armed="false"]': { color: vars.foregroundMuted, fontWeight: 500 },
  },
});

/**
 * 当前这一档是干什么的 —— 插件/harness 自己写的那句说明;锁住时换成锁住的原因。
 *
 * 这一行是**换控件时补回来的信息**:旧的一排药丸七个档名同时看得见,滑杆一次只显示一个。
 *
 * ⚠️ **颜色是 `foregroundMuted` 不是 `foregroundPassive`。** 后者在本产品里映到 `neutral-8`
 * (#BBB),那是**边框那一档**,不是文字档 —— 压在面板底色上只有 1.89:1,远不到 AA 的 4.5:1
 * (对抗审查实测)。这一行同时承载"这一档多深"与"为什么改不了",是整段里最不该读不清的字。
 * ⚠️ 10-10 起它是读数行里的第三格(原来独占一行):读数行高度写死,所以拖过一个没说明的档
 * 也不会让面板跳 —— 原来「有一档带说明就恒占一行」那条规矩的目的,换个位置照样守住。
 */
export const modelEffortHint = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundMuted,
});

/**
 * 锁住时的原因 —— 单独一行。这句是**操作指引**(「创建任务时可以选」),挤进读数行会被省略号
 * 把最要紧的后半句吃掉 —— 用户被告知"不行",却没被告知"那该怎么办"。
 * 这一态整条会话不变,放它长到两行不会造成抖动。
 */
export const modelEffortLockedHint = style({
  maxHeight: '1.875rem',
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  fontSize: tokenVars.textTiny,
  // ⚠️ 写成定值而不是倍数:11px × 1.3 = 14.3px 落在 15px 的盒子里只剩 0.7px 余量,
  // 换一种中日韩字体行盒一高就会把字底裁掉。
  lineHeight: '0.9375rem',
  color: vars.foregroundMuted,
});

/**
 * 复位到模型默认档。
 *
 * ❌ 不常驻:没有覆盖(当前就是默认档)时整个不渲染 —— 一枚点了什么也不会发生的按钮
 * 就是仓规里零容忍的假控件。
 * ⚠️ 命中区 **24×24**(WCAG 2.5.8 AA 的下限),图标仍是 12 —— 靠负外边距把多出来的
 * 高度吃掉,免得顶坏 `modelEffortHeader` 那个写死的 1rem。
 */
export const modelEffortReset = style({
  justifySelf: 'end',
  // 这一行是 baseline 对齐(为了 11px 标签与 13px 读数);纯图标按钮没有文字基线,
  // 浏览器会拿它的下边缘当基线,于是图标被顶高 —— 它按中线对齐才对。
  alignSelf: 'center',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '1.5rem',
  height: '1.5rem',
  marginTop: '-0.25rem',
  marginBottom: '-0.25rem',
  // 图标 12px 装在 24px 的点击盒里,两边各内缩 6px;而轨道是贴着内容边的 ——
  // 不拉回来的话右边会比左边空一截。拉 6px 之后左右都与轨道齐平(实测各 0.00px)。
  // ⚠️ 这个数跟着**图标尺寸**走:图标改大改小,这里要跟着改,否则右边会重新歪出去
  //    (上一版按 14px 算的 5px 就留下了 1px 的错位)。
  marginRight: '-0.375rem',
  padding: 0,
  border: 'none',
  borderRadius: tokenVars.radiusSm,
  background: 'transparent',
  color: vars.foregroundMuted,
  cursor: 'default',
  transition: `color ${durFast} ${easeStandard}, background-color ${durFast} ${easeStandard}`,
  selectors: {
    '&:hover': { color: vars.foreground, backgroundColor: vars.surfaceHover },
    '&:focus-visible': { outline: `1px solid ${vars.borderPrimary}`, outlineOffset: '1px' },
  },
});

/** 圆钮比轨道大,需要一道投影把自己托起来。这是这颗控件唯一的投影,别再往别处加。 */
const EFFORT_THUMB_LIFT = '0 1px 2px 0 rgba(0, 0, 0, 0.18)';

/** 轨道 12、圆钮 16(按下约 18)—— 10-10 缩小后的数,原来的 24/28/32 见抬头那张实测表。 */
const EFFORT_TRACK_HEIGHT = '0.75rem';

/**
 * 圆钮直径。**这是唯一的真源**,连 tsx 里算填充宽度也从这个自定义属性取 ——
 * ⚠️ 别在别处再写一遍 1.75rem:填充末端必须落在圆钮**圆心**上,
 * 两处各写一个字面量的话,改直径时漏掉一处,owner 2026-09-17 圈的那块梭形空白当场复发。
 */
export const EFFORT_THUMB_VAR = '--composer-effort-thumb';
const EFFORT_THUMB_SIZE = `var(${EFFORT_THUMB_VAR})`;
/** 半个圆钮 = 刻点层左右的缩进,也是 `thumbAlignment="edge"` 下圆心的活动边界。 */
const EFFORT_THUMB_HALF = `calc(${EFFORT_THUMB_SIZE} / 2)`;

/**
 * 轨道底色也走自定义属性:圆钮那道环要**跟轨道同色**才隐形(它只该在填充那侧显形,
 * 切出上游那条发丝缝)。写死成 surfaceHover 的话,鼠标一停轨道变色、环不变,
 * 未填充那半圈就现出一道 1px 异色边(实测浅色 0.9386 vs 0.8868)。
 * 圆钮是轨道的子节点,所以在轨道上改这个变量,环会跟着变。
 */
// ⚠️ 与契约里的 `--composer-effort-track` **不能同名**:这一支是「轨道此刻是什么色」的
// 中转(hover 时改它,圆钮那道环跟着变),同名会变成 `--x: var(--x)` 的自引用而整支失效。
const EFFORT_TRACK_VAR = '--composer-effort-track-now';

/**
 * 动效时长同样走自定义属性,而不是靠选择器权重去覆盖。
 * ⚠️ 这是踩过的坑:位置过渡挂在 `:focus-within`(0,3,0)上之后,
 * `@media (prefers-reduced-motion)` 那条裸类规则(0,1,0)**永远赢不了**,媒体查询不加权重 ——
 * 于是"减少动态效果"被悄悄架空。自定义属性没有这个问题:元素**自己**声明的值
 * 永远压过从祖先继承来的值,与祖先那条规则的权重无关。
 */
const EFFORT_MOVE_VAR = '--composer-effort-move';
const EFFORT_PRESS_VAR = '--composer-effort-press';

/**
 * 档与档之间那一跳的时长与曲线。
 *
 * ⚠️ owner 2026-09-18:「按钮没有拖拽动画，很死板很僵硬」。第二个僵硬源就在这里 ——
 * 我原来在拖动期间把位置过渡**关掉**，注释写的理由是「跟手」。但这是**离散档位**的滑杆：
 * 圆钮只能落在 6 个点上，根本不可能待在手指底下。关掉过渡的结果不是"跟手"，
 * 是每跨一格**瞬移 47px**（实测档距）。
 * ⇒ 正确形态是让它在档与档之间**吸过去**：110ms + 轻微回弹的曲线，手感是磁吸而不是瞬移。
 * 曲线末端过 1 一点点（1.28）是刻意的，那一下轻微的"顶"就是"咔哒"感的来源；
 * 幅度实测 ≈ 3px，小于圆钮半径，所以填充的过冲整段藏在圆钮底下，看不见破绽。
 */
const EFFORT_SNAP_DUR = '110ms';
const EFFORT_SNAP_EASE = 'cubic-bezier(0.34, 1.28, 0.64, 1)';
/** 按下时放大到 32/28。⚠️ 用 scale 不用改宽高:`thumbAlignment="edge"` 拿**布局尺寸**算缩进,
 *  真把圆钮改大会让圆心当场平移,拖动中整条对不齐。 */
const EFFORT_THUMB_PRESS_SCALE = 1.143;

export const modelEffortSlider = style({
  display: 'block',
  width: '100%',
  vars: {
    [EFFORT_THUMB_VAR]: '1rem',
    // 位置过渡默认**关**:Base UI 头两帧还没量出圆钮宽度、位置是 0,
    // 常开的话每次打开面板圆钮都从最左滑到当前档(逐帧实测 13ms=0px → 164ms=61px),
    // 那是把库内部的一次布局补正演成了入场动画。
    [EFFORT_MOVE_VAR]: '0ms',
    [EFFORT_PRESS_VAR]: durFast,
  },
  selectors: {
    // 焦点进了滑杆,位置变化才真是人调出来的,这时候才值得演。
    '&:focus-within': { vars: { [EFFORT_MOVE_VAR]: EFFORT_SNAP_DUR } },
    // 拖动中**也要动** —— 见 EFFORT_SNAP_DUR 抬头:离散档位没有"跟手"可言,
    // 关掉过渡等于每跨一格瞬移。写在 focus-within 后面,同权靠源序压住它。
    '&[data-dragging]': { vars: { [EFFORT_MOVE_VAR]: EFFORT_SNAP_DUR } },
  },
});

export const modelEffortControl = style({
  display: 'flex',
  alignItems: 'center',
  width: '100%',
  // 比轨道高 4px —— 给探出来的那半圈圆钮留位置,❌ 别让它被行高裁掉。
  height: EFFORT_THUMB_SIZE,
  // 指针拖动期间别让浏览器把它当成滚动手势 —— 触控板横向滑动会把面板滚走。
  touchAction: 'none',
  // Smashing:*the safest option would be to use `pointer` … as the user grabs the handle,
  // we could change the cursor to `grab`, and as it then wanders across the track, `grabbing`*。
  cursor: 'pointer',
  selectors: {
    [`${modelEffortSlider}[data-dragging] &`]: { cursor: 'grabbing' },
    // @@@session-options-disabled —— 会话中途还改不了档位时:在、看得出、点不动。
    // ⚠️ 压暗**只压轨道那几件**(见 modelEffortTrack / Ticks / Indicator),
    // ❌ 不压整颗控件:那会把圆钮 —— 唯一能抓的东西 —— 压成全面板最淡的一块(实测 1.07:1)。
    '&[data-disabled]': { cursor: 'default' },
  },
});

export const modelEffortTrack = style({
  position: 'relative',
  width: '100%',
  height: EFFORT_TRACK_HEIGHT,
  borderRadius: tokenVars.radiusFull,
  vars: { [EFFORT_TRACK_VAR]: 'var(--composer-effort-track)' },
  backgroundColor: `var(${EFFORT_TRACK_VAR})`,
  // 上游轨道外缘有一道 1px 的深线(#DDD 压在 #EBEBEB 上)—— 它把"轨道"从面板底色里划出来。
  // 用内阴影而不是 border:border 会把圆钮的定位基准往里缩 1px,刻点就跟圆心对不齐了。
  boxShadow: `inset 0 0 0 1px ${vars.border}`,
  transition: `background-color ${durFast} ${easeStandard}`,
  '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
  selectors: {
    // hover **只换颜色不换形** —— 本包 hover 规约如此,而"变形"留给按下那一刻(见抬头)。
    // 改的是变量不是 background-color:圆钮那道环引用同一个变量,才跟得住。
    [`${modelEffortControl}:hover:not([data-disabled]) &`]: {
      vars: { [EFFORT_TRACK_VAR]: 'var(--composer-effort-track-hover)' },
    },
    // ⚠️⚠️ 置灰这里**绝对不能用 opacity**。DOM 是 Control > Track > [填充, 刻点, 圆钮],
    // opacity 是**组透明度**、作用于整棵子树 —— 压轨道等于把圆钮一起压暗,
    // 而圆钮是唯一说明"现在停在哪一档"的那一笔。2026-09-17 找茬审查抓到的就是这个:
    // 代码写 opacity: 0.55,注释却写着"❌ 不压圆钮",两边正好相反,而守卫它的断言
    // 读的是圆钮**自己**的 opacity(永远 1),看不见祖先的组透明度,所以一路绿着放行。
    // 现在改成**只去掉那道外缘线**:轨道变平,状态由"填充退成中性灰 + 刻点变淡"来说。
    [`${modelEffortControl}[data-disabled] &`]: { boxShadow: 'none' },
  },
});

/**
 * 走过的那一段。
 *
 * ⚠️ **宽度自己算,不用 `Slider.Indicator`**:它按纯百分比铺(`width: <value>%`),而
 * `thumbAlignment="edge"` 下圆钮走的是"缩进半个圆钮"之后的那一段,两者对不上。
 * 算式是 `(整宽 − 一个圆钮) × 档位比例 + 半个圆钮` —— **末端恒等于圆钮圆心**,于是填充
 * 整段躲在圆钮底下,由圆钮那道 1px 环切出上游那条发丝缝(见抬头的实测)。
 * 右端**不给圆角**:给了的话在轨道上下边缘处填充会比圆钮先收口,露出一个缺角。
 *
 * ⚠️ 过渡与圆钮**同一条曲线**,且 `[data-dragging]` 时一并关掉 —— 拖动要 1:1 跟手,
 * 点轨道/按方向键才滑过去。两者不同步就是 Smashing 点名的那条:
 * *everything stays in sync … a slider should never freeze*。
 */
export const modelEffortIndicator = style({
  position: 'absolute',
  insetInlineStart: 0,
  top: 0,
  bottom: 0,
  // 逻辑属性而不是物理四角:填充的**固定端**那头留圆角、活动端切平。
  // 写死 `9999 0 0 9999` 的话,从右往左的语言里两头正好调转。
  borderStartStartRadius: tokenVars.radiusFull,
  borderEndStartRadius: tokenVars.radiusFull,
  backgroundColor: 'var(--composer-effort-fill)',
  // 时长从变量取(默认 0ms,焦点进了滑杆才是 durMed)—— 开/关这件事在滑杆根上决定,
  // 见 modelEffortSlider。这里只负责"跟着那个时长走"。
  transition: `width var(${EFFORT_MOVE_VAR}) ${EFFORT_SNAP_EASE}`,
  // 「减少动态效果」:把变量设在**自己身上**。元素自己声明的自定义属性永远压过继承来的,
  // 所以无论根上那几条选择器权重多高,这里都关得掉(❌ 靠 @media 去覆盖高权重选择器是关不掉的)。
  '@media': { '(prefers-reduced-motion: reduce)': { vars: { [EFFORT_MOVE_VAR]: '0ms' } } },
  selectors: {
    // 锁住时填充**退成中性灰**:它不再表达"你调到了这里",只表达"当前停在这里"。
    // 这也是把"锁住"与"一档都没选"分开的那一笔 —— 两者此前都是一层半透明,像素几乎相同。
    [`${modelEffortSlider}[data-disabled] &`]: { backgroundColor: vars.foregroundPassive },
  },
});

/** 刻点层:左右各缩进半个圆钮,刻点才与圆心对齐(见 EFFORT_THUMB_HALF)。 */
export const modelEffortTicks = style({
  position: 'absolute',
  top: 0,
  bottom: 0,
  left: EFFORT_THUMB_HALF,
  right: EFFORT_THUMB_HALF,
  pointerEvents: 'none',
  selectors: {
    [`${modelEffortSlider}[data-armed='false'] &`]: { opacity: 0.5 },
    [`${modelEffortSlider}[data-disabled] &`]: { opacity: 0.55 },
  },
});

/**
 * 一档一个刻点。
 *
 * 走过的那几档翻成**填充色掺白**。上游实测那个亮点是 #77BBFF 压在 #339CFF 上 ——
 * 换算下来是白掺 **33%**((0x77−0x33)/(0xFF−0x33));我们用 **45%**,因为 33% 在上游
 * 自己身上也只有 1.41:1,几乎看不见。形照抄,看不清的地方不抄(与读数那条同一个取舍)。
 *
 * ⚠️ 掺的那个「白」取 `--composer-effort-knob` 而不是裸 `#fff`(2026-09-22,按 design.md
 * 「never write `#fff` …」)。它就是同一颗圆钮用的那枚纯白 token —— 刻点是「圆钮走过的痕迹」,
 * 与圆钮同源才是对的,两处各写一个字面量本来就是同一个值抄了两遍。
 */
export const modelEffortTick = style({
  position: 'absolute',
  top: '50%',
  width: '0.1875rem',
  height: '0.1875rem',
  borderRadius: tokenVars.radiusFull,
  transform: 'translate(-50%, -50%)',
  backgroundColor: vars.foregroundPassive,
  selectors: {
    '&[data-filled]': {
      backgroundColor:
        'color-mix(in srgb, var(--composer-effort-knob) 45%, var(--composer-effort-fill))',
    },
    // 锁住时填充是中性灰,亮点跟着退成白的一半,否则会在灰条上留几个绿点。
    [`${modelEffortSlider}[data-disabled] &[data-filled]`]: {
      backgroundColor: 'color-mix(in srgb, var(--composer-effort-knob) 55%, transparent)',
    },
  },
});

/**
 * 圆钮:静止直径 28,压在 24 的轨道上、上下各探出 2px —— 这是它区别于"开关拨钮"的那一笔。
 *
 * 那道 `0 0 0 1px` 的**轨道色环**不是装饰:填充铺到圆钮底下,靠它切出上游那条发丝缝
 * (实测 1–2 设备像素),缝没了就是"一条药丸直接撞上一个圆"。在未填充的一侧它与轨道同色、
 * 看不见,所以只在需要它的地方起作用。
 *
 * ❌ **不参与置灰**:圆钮是唯一能抓的东西,压暗它等于把控件的把手藏起来。
 */
export const modelEffortThumb = style({
  width: EFFORT_THUMB_SIZE,
  height: EFFORT_THUMB_SIZE,
  borderRadius: tokenVars.radiusFull,
  backgroundColor: 'var(--composer-effort-knob)',
  // 那道环要跟轨道**同色**才隐形 —— 它只该在填充那一侧显形,切出上游那条发丝缝。
  // 取的是轨道那个变量(圆钮是轨道的子节点,继承得到),所以 hover 轨道变色时它跟着变;
  // 写死颜色的话,鼠标一停,未填充那半圈就现出一道 1px 异色边。
  boxShadow: `0 0 0 1px var(${EFFORT_TRACK_VAR}), ${EFFORT_THUMB_LIFT}`,
  // 两段时长都从变量取:按下的形变一直开着(那是对当下这一下的回应),
  // **位置**默认 0ms —— 理由见 modelEffortSlider 上那段实测(开场从最左滑过来)。
  transition: `inset-inline-start var(${EFFORT_MOVE_VAR}) ${EFFORT_SNAP_EASE}, transform var(${EFFORT_PRESS_VAR}) ${EFFORT_SNAP_EASE}`,
  // 「减少动态效果」:位置与形变一起关,且设在**自己身上**才关得掉,理由见 modelEffortIndicator。
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      vars: { [EFFORT_MOVE_VAR]: '0ms', [EFFORT_PRESS_VAR]: '0ms' },
    },
  },
  selectors: {
    // M3 现行版原话是 *a vertical handle that narrows when pressed*
    // (m3.material.io/components/sliders/overview,2026-09-17 核)——形状随按压变,是这一类
    // 控件的通例。M3 那颗把手是竖条、按下变窄;咱们照的是 Codex/macOS 的圆钮,所以取的是
    // "按下要有形变"这条原则,不是它那个形状。上游实测静止 28 / 拖动 32。
    '&:active': { transform: `scale(${EFFORT_THUMB_PRESS_SCALE})` },
    [`${modelEffortSlider}[data-dragging] &`]: { transform: `scale(${EFFORT_THUMB_PRESS_SCALE})` },
    '&:focus-visible': { outline: `2px solid ${vars.borderPrimary}`, outlineOffset: '2px' },
  },
});

// ── 面板本体与行:数值取自上游**实测 computed style**,不是照着图估 ────────────────
//
//   面板  width 288px / border-radius 12px / padding 0
//   一行  padding 8px 36px 8px 12px / border-radius 8px / align-items flex-start / gap 8px
//
// 字号落到本仓的阶梯上(textSm 13px / textTiny 11px,上游是 14/12,本仓整体紧一档)——
// ❌ 不硬写 14px/12px:lint 有「禁止阶梯外字号」的闸,而且那会让这个面板比邻居大一号。

/**
 * 上游 `w-72 rounded-xl p-0`。定宽是设计的一部分:行是两段式,窄了第二行就开始换行。
 *
 * ⚠️ **只取宽度,不取圆角** —— 上游是 `rounded-xl`(12px),本仓所有浮层统一由 `--radius`
 * 钉住(composer-surface-3334 正拿真 computed style 断言它)。为一个面板破掉全仓浮层契约,
 * 换来的是它和身边每一个弹层都不一样。⇒ 圆角保咕咕的,这里不写。
 */
/**
 * 面板本体**自己不留内距** —— 内距归里面各段(搜索行 / 清单 / 底部行)自己。
 *
 * 原语默认给 2px,于是行离面板边缘是 2(面板) + 2(清单) = 4px,而模型面板是 0 + 2 = 2px。
 * 差这 2px 在一排里点开两个面板就看得出来(owner 2026-09-07 那条「布局」)。
 * 三个面板都用它,见 @@@composer-panel-row。
 */
export const composerPanelContent = style({ padding: 0 });

export const modelPanelContent = style({
  // ⚠️ **三条一起写**,只写 `width` 挡不住:primitive 的 `comboboxContent` 自带
  // `width/minWidth: var(--anchor-width)` + `maxWidth: var(--available-width)`,
  // 于是一个超长模型名会把面板按 max-content 撑开 —— 实测 1372px 的横幅
  // (`Some Vendor Very Long Model Name …` 那种 harness 真报得出的名字)。
  // 这个洞是 #5082 那条排版守卫移植过来之后当场抓到的,不是推理出来的。
  width: '18rem',
  minWidth: '18rem',
  maxWidth: '18rem',
  padding: 0,
});

/** 上游 `relative items-start gap-2 rounded-lg py-2 ps-3 pe-9`。`pe-9` 是给右侧对勾留的槽。 */
/**
 * @@@composer-panel-row — composer 底排**三个面板共用**的一行(模型 / agent / 权限)。
 *
 * owner 2026-09-07:「这俩组件和其他组件不搭,其他组件都是 assistantui 的,这个不是」。
 * 病根不在数值上(三个面板的容器圆角/内距量出来本来就一样),在**解剖**:模型面板照
 * assistant-ui Elements 重做过 —— 放大镜搜索行、行内 logo 列、名字 medium + 说明第二行;
 * 另外两个还吃着 combobox 原语的默认行(6/32/6/8、名字无字重)。同一排点开三个面板,
 * 三种长相。
 *
 * ⇒ 这一族从 `modelPanel*` 改名成 `composerPanel*`,由三个面板一起用。
 * ⚠️ 改名只动类名,**没有动 `data-slot`**(`composer-model-name` 等是对外契约,见 index.tsx
 * 抬头的 slot 词汇表)。
 * ⚠️ 行的内距挂在 `Combobox.Item` 自己身上,不是挂在里面那层 —— 挂里面会与原语的默认内距
 * 叠成双份。所以三个面板都要把这个类**传给 Item**(ComboboxPopover 走 `itemClassName`)。
 */
export const composerPanelItem = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
  paddingLeft: '0.75rem',
  paddingRight: '2.25rem',
  borderRadius: tokenVars.radiusMd,
});

export const composerPanelItemText = style({
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
});

/** 上游 `truncate font-medium`。 */
export const composerPanelItemName = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 500,
  fontSize: fallbackVar(tokenVars.textSm, '13px'),
  color: vars.foreground,
});

/** 上游 `text-muted-foreground truncate text-xs` —— 第二行,它才是这一行与别行的差别。 */
export const composerPanelItemDesc = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textTiny,
  lineHeight: 1.4,
  color: vars.foregroundMuted,
});

// ── 行内厂商图标 ─────────────────────────────────────────────────────────────
//
// 厂商是**二级**(owner 2026-09-06:一级是「谁的」)。它不做组头,只出现在两处:
// 顶部那排筛选药丸,和每行左边这枚 logo —— 没有组头之后,这枚 logo 就是行内认厂商的唯一线索,
// ❌ 不能省。

/**
 * 行内厂商 logo。上游 `ModelIcon` 实测 `size-3.5`(14px)+ `mt-[3px]`——
 * 那 3px 是把 logo 的视觉重心压到第一行的基线上(行本身是 `items-start`,不压就贴到行顶)。
 */
export const composerPanelItemIcon = style({
  display: 'flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  width: '0.875rem',
  height: '0.875rem',
  marginTop: '3px',
  color: vars.foreground,
});

// ── 模型面板:单行清单 + 悬浮详情卡(#7056,owner 2026-10-10 对齐 Cursor) ────────────────
//
// owner 看着 Cursor 的模型下拉:「表达密度可以更丰富、更紧凑一点,悬浮在上面能看到详细信息的 detail 模型卡片」。
// ⇒ 一行只放 logo + 名字 + 行尾一小格(咕咕的模型写倍率),说明、上下文、推理档挪进悬浮卡。
// ❌ 别再回到两段式行:那一版一屏只放得下五六条,说明行又被 288px 的面板截成省略号,两头都没讲清。

/** 单行模型条:在 `composerPanelItem` 之上把上下内距收紧、整行垂直居中。 */
export const modelPanelItemCompact = style({
  alignItems: 'center',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
});

// 单行之后 logo 跟名字同一条中线,`composerPanelItemIcon` 那 3px 下压只属于两段式的行。
globalStyle(`${modelPanelItemCompact} [data-slot="composer-model-icon"]`, { marginTop: 0 });

/** 名字占满中间;超长名字截成省略号。 */
export const modelPanelItemName = style([
  composerPanelItemName,
  { flex: '1 1 auto', minWidth: 0 },
]);

/** 悬浮详情卡本体。宽度随内容、但夹在一个窄区间里:卡跟着鼠标换行时不该忽宽忽窄得太厉害。 */
export const modelDetailCard = style({
  width: 'max-content',
  minWidth: '11rem',
  maxWidth: '16rem',
  padding: '0.625rem 0.75rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  color: vars.foreground,
});

export const modelDetailHead = style({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  minWidth: 0,
});

export const modelDetailName = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontWeight: 600,
  fontSize: fallbackVar(tokenVars.textSm, '13px'),
});

/** 「这条是谁的」那一句(组头原文),卡里的第二行。 */
export const modelDetailTier = style({
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundMuted,
});

export const modelDetailSummary = style({
  margin: 0,
  fontSize: tokenVars.textTiny,
  lineHeight: 1.45,
  color: vars.foreground,
});

/** 事实两列:标签灰、值正文色。 */
export const modelDetailFacts = style({
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: '0.75rem',
  rowGap: '0.125rem',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
});

export const modelDetailFactLabel = style({ color: vars.foregroundMuted });

/** 「开通会员后可用」那张卡里的模型名:一行一个,好扫。 */
export const modelDetailList = style({
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'grid',
  rowGap: '0.125rem',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
});

export const modelDetailFactValue = style({
  margin: 0,
  minWidth: 0,
  overflowWrap: 'anywhere',
});

/**
 * 清单底下那一行:「管理模型」在左,「升级解锁更多模型」在右(免费档才有)。
 * 与推理档那一段同一种分隔(上边线 + 面板底色),它也是清单的兄弟节点、不随清单滚。
 */
export const modelPanelFooter = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.25rem',
  paddingBottom: '0.25rem',
  borderTop: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceBase,
});

/** 底部那两枚是动作不是取值:纯文字按钮,悬停给底色,与菜单项同一种手感。 */
export const modelPanelFooterAction = style({
  appearance: 'none',
  border: 0,
  background: 'transparent',
  padding: '0.25rem 0.375rem',
  borderRadius: tokenVars.radiusMd,
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundMuted,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  selectors: {
    '&:hover, &:focus-visible': { backgroundColor: vars.surfaceHover, color: vars.foreground },
  },
});

/**
 * 「升级解锁更多模型」用 info 前景,与「去登录」同一色:一眼看得出是去路。
 * 面板是定宽(18rem):这一枚要能收窄、折行,❌ 跟着 nowrap 把自己撑到面板外被裁掉(#7123,英文
 * 「Manage models」+「Upgrade to unlock more models」比面板宽约 19px,裁成「…more mode」)。
 */
export const modelPanelUpgrade = style([
  modelPanelFooterAction,
  { color: vars.surfaceInfoForeground, whiteSpace: 'normal', textAlign: 'end', minWidth: 0 },
]);

/** 触发器上那枚,不需要 `mt` —— 触发器是单行、垂直居中。 */
export const modelTriggerIcon = style({
  display: 'flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  width: '0.875rem',
  height: '0.875rem',
  color: vars.foreground,
});

// 档 6(见 @@@composer-toolbar-disclosure):模型名与强度让位,只剩厂商图形。写在 modelTriggerIcon 定义之后 ——
// 模块按顺序求值,引用它的规则写在前面会读到未初始化的常量。
globalStyle(
  `[data-slot="composer-toolbar"][data-disclosure="6"] [data-testid="composer-model-trigger"]:has(${modelTriggerIcon}) :is(${modelTriggerLabel}, ${modelTriggerEffort})`,
  { display: 'none' },
)

// Touch targets belong to the shared composer, including its chat hosts.
globalStyle(`${composerRoot}[data-mobile] [data-slot="composer-toolbar"] button`, { minHeight: 44, minWidth: 44 });
