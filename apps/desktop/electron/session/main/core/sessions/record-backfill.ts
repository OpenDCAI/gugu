/**
 * #980 把 agent 自己的记录里有、库里(`session_turns`)还没有的那几轮补进库。
 *
 * 会话页的历史以 agent 自己的记录为准,库只是缓存:编程模式(终端)里跑的轮、在咕咕外面直接用命令跑的轮、
 * #5381 之前建的会话(库是空的),都只在记录里。从前它们靠「重放 + 按条数对齐」补进来,而接回会话已经不再重放。
 *
 * 实现在下一个提交里;这里先立住会话页要调用的那个动词。
 */
export async function syncStoredHistoryFromRecord(_sessionId: string): Promise<{ inserted: number }> {
  return { inserted: 0 };
}
