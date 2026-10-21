/**
 * 一次工具调用失败时,那条能说给人听的原因。
 *
 * ACP **没有**给工具调用留 error 字段:失败是靠一条 `status: 'error'` 的
 * `tool_call_update` 送来的,原因就在它的 `content` 里 —— 解码后落成 `outputText`
 * (供应商本意要给人读的那一路),`rawOutput` 是退而求其次的兜底。
 *
 * 之所以抽成一个函数:同一个 bug 在这个目录里出现过**三份**(#4981)。
 * `subagent` / `diff` / `file-op` 三个行族各自读一个**并不存在的** `item.error`,
 * 于是判断恒为 false,失败行永远只剩「失败」两个字,原因在界面上一个字都拿不到。
 *
 * ⚠️ 最坏的一点是它在 Storybook 里**看起来是好的** —— story 手工塞了
 * `error: '...'`(diff.stories / file-operation.stories),而产品路径从来不填。
 * 拿 story 验这条链路只会验出一个假绿。判据要判 presenter,不要判 story。
 *
 * 只在真失败时给值:没失败的调用即使有输出,那也是**结果**不是**原因**,
 * 把它染成一行红字是在造假。空串同样返回 undefined —— 一颗什么都不说的片比没有更坏。
 */
export function toolFailureReason(item: {
  status: string;
  outputText?: string;
  rawOutput?: string;
}): string | undefined {
  if (item.status !== 'error') return undefined;
  const reason = item.outputText ?? item.rawOutput;
  return reason ? reason : undefined;
}
