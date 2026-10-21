/** @jsxImportSource solid-js */
/**
 * Restore-prompt: an arrow curving back to the left (「还回去」).
 *
 * ❌ 刻意**不用**上游 error-state 的 `RefreshCw`（循环箭头）与 stopped-run 的 `ArrowRight`
 * （向前箭头）：那两个图形分别读作「再跑一次」和「接着往下」，而这个按钮两件事都不做 ——
 * 它只把指令**送回**输入框。图标与文案必须说同一句话，否则图标会替按钮许下它兑现不了的承诺。
 */
export function IconRestorePrompt() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M5 3 L2 6 L5 9" />
      <path d="M2 6 h6.5 a3.5 3.5 0 0 1 0 7 H6" />
    </svg>
  );
}
