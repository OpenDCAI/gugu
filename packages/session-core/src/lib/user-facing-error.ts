const MAX_FAILURE_LINE_LENGTH = 280;

/** 拒绝方原话的第一行:保留它说的事,去掉路径、profile、令牌与栈。 */
export function safeFailureLine(message: string, connectionLost: () => string): string {
  const firstLine = message
    .split(/\r?\n/, 1)[0]!
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '')
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\s,)]+/g, '[path]')
    .replace(/(?:eyJ[A-Za-z0-9._-]+|(?<![A-Za-z0-9])(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+)/g, '[redacted token]')
    .trim();
  if (firstLine === 'Wire transport disconnected') return connectionLost();
  return firstLine.slice(0, MAX_FAILURE_LINE_LENGTH);
}

