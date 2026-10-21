/** @jsxImportSource solid-js */
/**
 * Continue-turn: 一支向前的箭头 —— 上游 `elements-stopped-run` 的 `ArrowRightIcon`（`size-3`）。
 *
 * ⚠️ 这枚字形与 `IconRestorePrompt` 是**刻意分开**的两件事，别互相替代：
 * 「向前」= 在同一个还活着的会话里**接着往下跑**；
 * 「折回」= 把那条指令**送回输入框**、一个字节都不发。
 * `IconRestorePrompt` 的文件头当初写着「不用 stopped-run 的 ArrowRight，因为它读作接着往下」——
 * 那句话现在依然成立，只是「接着往下」这件事有了自己的按钮，于是这枚箭头回到了它该在的地方。
 */
export function IconContinueTurn() {
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
      <path d="M2.5 7 h8.5" />
      <path d="M7.5 3.5 L11 7 L7.5 10.5" />
    </svg>
  );
}
