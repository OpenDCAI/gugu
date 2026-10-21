/**
 * @@@composer-size-invariance — 会话页 transcript、hero 与 composer 槽位共用的内容列宽度。
 * 新建任务和项目首页的创建卡片独立使用 sessionComposerWidthClassName，最大 672px。
 *
 * 宽屏那一档(#5141/#5168)不是为了好看:底排在 672 下**任何**视口都因为放不下而停在
 * 渐进披露档 1,agent 名字只剩一枚图标。放宽到 768 才把名字放回来。
 */
export const CHAT_CONTENT_MAX_WIDTH_REM = 42;

/** 宽屏档 = Tailwind `max-w-3xl`(--container-3xl)。 */
export const CHAT_CONTENT_MAX_WIDTH_WIDE_REM = 48;

/**
 * 切到宽屏档的断点 = Tailwind v4 的 `xl`(80rem / 1280px)。
 * 这棵树的 @theme 没有覆盖 --breakpoint-xl，采用默认值。
 */
export const CHAT_CONTENT_WIDE_BREAKPOINT_REM = 80;

export const CHAT_CONTENT_GUTTER_PX = 16;

/** The painted fade above a bottom composer also needs real reading clearance. */
export const CHAT_COMPOSER_EDGE_FADE_PX = 24;

/**
 * 非用户行左右各缩进的这一档(`row-metrics` 的同名常量)。嵌在别处画的一段转录(手机会话页的附件卡)
 * 要与宿主自己的正文对齐时,用它抵掉这一档。
 */
export { ROW_INSET_X } from './components/engine/row-metrics';
