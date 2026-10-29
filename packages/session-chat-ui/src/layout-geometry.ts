/** Shared transcript, hero and composer widths, using the Tailwind container scale. */
/** Tailwind `max-w-3xl` (--container-3xl). */
export const CHAT_CONTENT_MAX_WIDTH_REM = 48;

/** Tailwind `max-w-4xl` (--container-4xl). */
export const CHAT_CONTENT_MAX_WIDTH_WIDE_REM = 56;

/**
 * 切到宽屏档的断点 = Tailwind v4 的 `xl`(80rem / 1280px)。
 * 这棵树的 @theme 没有覆盖 --breakpoint-xl，采用默认值。
 */
export const CHAT_CONTENT_WIDE_BREAKPOINT_REM = 80;

export const CHAT_CONTENT_GUTTER_PX = 16;

/** The painted fade above a bottom composer also needs real reading clearance. */
export const CHAT_COMPOSER_EDGE_FADE_PX = 24;

/** Painted fade below a pinned question; source jumps need the same reading clearance. */
export const CHAT_PIN_FADE_HEIGHT_PX = 16;

/**
 * 非用户行左右各缩进的这一档(`row-metrics` 的同名常量)。嵌在别处画的一段转录(手机会话页的附件卡)
 * 要与宿主自己的正文对齐时,用它抵掉这一档。
 */
export { ROW_INSET_X } from './components/engine/row-metrics';
