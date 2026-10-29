import { style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';
// Colocated chip-class styles — global selectors for TipTap-serialized HTML.
import './chip-classes.css';

// @@@composer-click-target 的第二段:宿主(chat-composer 的 `editorArea`)是 flex 列并留出了
// 高度,这三层要把它一路传到可编辑元素上,否则可编辑区仍旧只有一行高、下面全是死区。
// ⚠️ 只能 grow ❌ 不能 shrink:宿主 `max-height` 到顶后要靠它自己撑出滚动高度,允许收缩的话
//    长文本会被压回容器高度,可视区跟着一起塌。
export const editorWrapper = style({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  flexShrink: 0,
  width: '100%',
});

export const editorContent = style({
  display: 'flex',
  flexDirection: 'column',
  flexGrow: 1,
  flexShrink: 0,
  width: '100%',
  outline: 'none',
});

export const editorPlaceholder = style({
  pointerEvents: 'none',
  position: 'absolute',
  top: 0,
  left: 0,
  // @@@composer-three-tiers 的**第一档**:输入正文 = 消息正文那一档(#7333:16/24,`textTitle`),比底排整排大一号 ——
  // 差的这一档是"该读的东西"与"工具"之间的分界。真实输入与 placeholder 必须同一档。
  fontSize: tokenVars.textTitle,
  lineHeight: tokenVars.textTitleLineHeight,
  userSelect: 'none',
  // placeholder 说明这里能做什么,是信息:可读次级字(≥4.5);passive 在暗色 card 上只有 3.35。
  color: vars.foregroundMuted,
});

// These classes are assigned via TipTap editorProps.attributes.class
export const promptEditorContentClass = style({
  outline: 'none',
  whiteSpace: 'pre-wrap',
  // @@@composer-three-tiers 的**第一档**:输入正文 = 消息正文那一档(#7333:16/24,`textTitle`),比底排整排大一号 ——
  // 差的这一档是"该读的东西"与"工具"之间的分界。真实输入与 placeholder 必须同一档。
  fontSize: tokenVars.textTitle,
  lineHeight: tokenVars.textTitleLineHeight,
  color: vars.foreground,
  // 一行的高 = 行高(24px)。
  minHeight: '1.5rem',
  // @@@composer-click-target:一行文字撑不满宿主留出的高度,剩下的由它长满 —— 点在空白处
  // 就是点在可编辑元素上,ProseMirror 自己把光标落到最近的位置。
  flexGrow: 1,
  flexShrink: 0,
});
