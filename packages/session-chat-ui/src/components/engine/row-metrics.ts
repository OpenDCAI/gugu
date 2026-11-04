/**
 * Row geometry constants for the engine-level row layout.
 *
 * These values are fixed — they are not themeable. They live here, colocated
 * with the engine row infrastructure that owns them.
 */

/** Standard single-line row height (px) for tool/plan/diff/resource-link rows. */
export const ROW_H = 32;

/** Horizontal inset (px) applied to both sides of non-user-message rows. */
export const ROW_INSET_X = 16;

/**
 * Extra vertical space (px) added to body line-height to produce the
 * collapsible header row height.
 */
export const HEADER_ROW_EXTRA_H = 8;

/** Shared cap for a conversation's collapsed reply and running process viewport. */
export const CONVERSATION_PREVIEW_MAX_H = 252;

/** Execution viewport is independent of the reply preview cap. */
export const PROCESS_PREVIEW_MAX_H = 136;

/** Completed process disclosure in the approved replay design. */
export const PROCESS_COMPLETED_MAX_H = 352;
