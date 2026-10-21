/**
 * 主进程抛的错经 Electron IPC 回到渲染层时会被包一层：
 *   Error invoking remote method 'sessionImport.importLocalSession': Error: 读不出这条会话的工作目录
 * 原样显示等于把 IPC 管道的内幕怼到用户脸上，真正那句人话还被挤到最后。
 * 这里只留最里层那句，前面的包装层与重复的 "Error:" 全部剥掉。
 *
 * 剥出来的那句是**原始诊断**，逐字保留、不翻译；只有一个字都没剥出来时才落到调用方给的兜底标签。
 * 兜底是 chrome，所以由调用方从 catalog 取好传进来 —— 这个函数保持纯，不去读当前 locale。
 */
export function humanizeRpcError(error: unknown, unknownLabel: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutChannel = raw.replace(/^Error invoking remote method\s+'[^']*':\s*/, '');
  const withoutErrorPrefix = withoutChannel.replace(/^(Error:\s*)+/, '').trim();
  return withoutErrorPrefix || unknownLabel;
}
