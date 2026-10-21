import type { FontConfig } from '@session-chat/core/config';
import { MEASURED_SCROLLBAR_GUTTER_X, measureSoftWrap } from '@session-chat/core/measure/soft-wrap';
import type { ChatExecute } from '@session-chat/model';

/**
 * Scrollbar width pinned in execute.css so the off-screen measurer can name it.
 * Shared with every other row that measures its own wrap — see soft-wrap.ts for
 * why the number has to be pinned rather than read from the platform.
 */
export const EXECUTE_SCROLLBAR_GUTTER_X = MEASURED_SCROLLBAR_GUTTER_X;

export type ExecuteDisplayLine = {
  kind: 'command' | 'spacer' | 'output';
  text: string;
  visualLineCount: number;
  softWrapOffsets: number[];
};

function commandLines(command: string): string[] {
  return (command || '\u2026').split('\n');
}

function outputLines(outputText: string | undefined): string[] {
  if (!outputText) return [];
  return outputText.replace(/\r\n/g, '\n').split('\n');
}

/**
 * 表头那颗片上显示的命令 —— 一行,不带 `$`。
 *
 * 多行命令(heredoc、`&&` 换行写)压成一行:换行与连续空白都折成一个空格。片是**预览**,
 * 不是全文 —— 全文永远在展开后的 body 里一字不差,所以这里压扁不丢信息。
 *
 * 命令为空时返回 null,让表头退回只有标签的样子 —— ❌ 不拿 `…` 之类的占位符充数:
 * 一颗什么都不说的片比没有片更坏。
 */
export function executeCommandChipText(item: ChatExecute): string | null {
  const text = item.command?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

export function createExecuteLines(item: ChatExecute): ExecuteDisplayLine[] {
  const command = commandLines(item.command).map(
    (line, index): ExecuteDisplayLine => ({
      kind: 'command',
      text: `${index === 0 ? '$' : ' '} ${line}`,
      visualLineCount: 1,
      softWrapOffsets: [],
    }),
  );
  const output = outputLines(item.outputText).map(
    (line): ExecuteDisplayLine => ({
      kind: 'output',
      text: line,
      visualLineCount: 1,
      softWrapOffsets: [],
    }),
  );
  return output.length > 0
    ? [
        ...command,
        { kind: 'spacer', text: '', visualLineCount: 1, softWrapOffsets: [] },
        ...output,
      ]
    : command;
}

export function layoutExecuteLines(
  item: ChatExecute,
  contentWidth: number,
  fonts: FontConfig,
): ExecuteDisplayLine[] {
  const width = Math.max(1, contentWidth);

  return createExecuteLines(item).map((line) => {
    if (line.kind !== 'command') return line;
    return { ...line, ...measureSoftWrap(line.text, width, fonts.code.font) };
  });
}

export function executeBodyGeometry(
  lines: ExecuteDisplayLine[],
  codeLineH: number,
  isExpanded: boolean,
  collapsedMaxLines: number,
  expandedMaxLines: number,
): { bodyH: number; contentH: number } {
  const visualLineCount = lines.reduce((sum, line) => sum + line.visualLineCount, 0);
  const contentH = visualLineCount * codeLineH;
  const maxLines = isExpanded ? expandedMaxLines : collapsedMaxLines;
  const cap = maxLines * codeLineH;
  return { bodyH: Math.min(contentH, cap), contentH };
}

/**
 * True when the collapsed body is holding something back.
 *
 * `executeBodyGeometry` caps the body at `collapsedMaxLines` while collapsed and
 * `expandedMaxLines` while expanded, so a body already shorter than the collapsed
 * cap comes out **identical in both states** — same pixels, same lines, same
 * scrollbar. A single-line command that produced no output is the common case:
 * `createExecuteLines` emits the command line alone, one visual line against a
 * cap of two. Expanding such a row is a no-op the reader can see, so the row must
 * not offer the control.
 *
 * Counted against the *collapsed* cap alone, never the current state: the answer
 * has to be the same before and after a toggle, or the chevron would vanish under
 * the pointer that just used it.
 */
export function executeHidesContent(
  lines: ExecuteDisplayLine[],
  codeLineH: number,
  collapsedMaxLines: number,
): boolean {
  // No measure context, no body — `execute.def` renders nothing to reveal either.
  if (codeLineH <= 0) return false;
  const visualLineCount = lines.reduce((sum, line) => sum + line.visualLineCount, 0);
  return visualLineCount > collapsedMaxLines;
}
