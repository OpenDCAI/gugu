/**
 * 管家维护的那一段的头尾(开通、每次唤醒写进 CLAUDE.md,见管家的「助理」那一步)。
 * 10-15 起是中性标记(云电脑对用户不可见,助理读到标记也不该学会「云电脑」这个词);
 * 早先开通、还没醒过的机器上可能还是旧的那一对,两对都认。
 */
export const MANAGED_BLOCK_MARKERS: ReadonlyArray<{ start: string; end: string }> = [
  { start: '<!-- 咕咕管家', end: '<!-- /咕咕管家 -->' },
  { start: '<!-- 咕咕云电脑', end: '<!-- /咕咕云电脑 -->' },
];

export type InstructionsParts = {
  /** 管家那一段原文(连头尾标记);文件里没有 = null。 */
  managed: string | null;
  /** 管家那段之外人写的,前后两截合成一段。 */
  user: string;
};

export function splitInstructions(text: string): InstructionsParts {
  for (const marker of MANAGED_BLOCK_MARKERS) {
    const start = text.indexOf(marker.start);
    const endAt = start < 0 ? -1 : text.indexOf(marker.end, start);
    if (start >= 0 && endAt >= 0) return splitAt(text, start, endAt + marker.end.length);
  }
  return { managed: null, user: text.trim() };
}

function splitAt(text: string, start: number, end: number): InstructionsParts {
  const user = [text.slice(0, start), text.slice(end)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  return { managed: text.slice(start, end), user };
}

/**
 * 人改完「说明」要写回去的全文:管家那段照**此刻文件里的原文**留在最前面(❌ 用打开编辑框时读到的那份 —— 中间管家可能刚升级过),
 * 人写的接在后面。人写的清空 = 只剩管家那段(「留空可清除」)。
 */
export function composeInstructions(current: string, userText: string): string {
  const { managed } = splitInstructions(current);
  const body = userText.trim();
  if (!managed) return body ? `${body}\n` : '';
  return body ? `${managed}\n\n${body}\n` : `${managed}\n`;
}

