/**
 * @@@ui-ruler — tokens.css 几何标尺的 JS 镜像。
 *
 * 只有需要参与算术的值才在这里出现(列宽要 clamp、要和可用宽度比大小);其余几何一律在 CSS 里消费
 * `var(--…)`。两边同名同值,由 tests/unit/desktop/styles/uiRulerParity.test.ts 钉住——改一边不改另一边会红。
 */
export const NAV_COLUMN_WIDTH = 240 // --nav-col-w
export const NAV_COLUMN_MIN_WIDTH = 200
export const NAV_COLUMN_MAX_WIDTH = 360
