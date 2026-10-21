// @ 候选 / 斜杠命令框的落点:贴着触发字符(@ 或 /)那一行的上方、左边对齐那个字符。
// owner 2a:原来固定在输入框左上角,@ 打在一行中间时候选框离光标很远。
// 光标像素坐标由 textarea-caret(镜像 div 量)给出,这里只做坐标换算与夹边,纯函数可测。

export interface ComposerPopupPlacementInput {
  /** getCaretCoordinates(textarea, triggerIndex):相对 textarea 边框盒左上角。 */
  caret: { left: number; top: number }
  /** textarea 相对弹层定位容器(composer 根)的偏移。 */
  textareaOffset: { left: number; top: number }
  /** textarea 自身的滚动量(多行滚动后,字符的视觉位置要减掉它)。 */
  scroll: { left: number; top: number }
  /** 定位容器宽度;弹层左右各留 inset。 */
  containerWidth: number
  /** 定位容器高度;弹层用 bottom 定位,贴在那一行上方 gap 处。 */
  containerHeight: number
  popupWidth: number
  inset?: number
  gap?: number
}

export function placeComposerPopup({
  caret, textareaOffset, scroll, containerWidth, containerHeight, popupWidth, inset = 8, gap = 6,
}: ComposerPopupPlacementInput): { left: number; bottom: number } {
  const x = textareaOffset.left + caret.left - scroll.left
  // 那一行已经滚出 textarea 可视区时,贴在 textarea 顶边上方,不飘出去。
  const lineTop = Math.max(textareaOffset.top, textareaOffset.top + caret.top - scroll.top)
  const maxLeft = Math.max(inset, containerWidth - popupWidth - inset)
  return {
    left: Math.round(Math.min(Math.max(x, inset), maxLeft)),
    bottom: Math.round(containerHeight - lineTop + gap),
  }
}
