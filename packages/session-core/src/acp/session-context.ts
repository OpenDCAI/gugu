/** 咕咕写进会话级背景(③)的块都以这几个标签开头(平台块 / 身份块 / 用户规则)。那不是人说的话。 */
const SESSION_CONTEXT_BLOCK = /^\s*<(gugu_platform|agent_identity|user_rules)\b/;

export function isSessionContextText(text: string): boolean {
  return SESSION_CONTEXT_BLOCK.test(text);
}
