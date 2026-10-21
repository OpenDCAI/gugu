/**
 * 等这条会话已经排进写入者的写入全部落定 —— 落库、播出 'agent:status'、渲染层事件都在那一次写入里做完。
 *
 * 写入者按会话串行写(`inOrder`):在途的那一串记在 `writes` 里,写完出队。hook 事件与 provider 门 / 阻塞
 * 都是同步排进去的(`emitAgentEvent` 同步调到写入者),所以调完就可以等。等它出队,等的是写入者自己交出的事实;
 * 「这条事件不该写出状态」也只有在这之后数才算数(❌ 睡一段再数:慢机器上数的时候它可能还没处理)。
 */
export async function statusWritesSettled(writer: object, sessionId: string): Promise<void> {
  const { writes } = writer as { writes: Map<string, Promise<void>> };
  for (let inFlight = writes.get(sessionId); inFlight; inFlight = writes.get(sessionId)) {
    await inFlight;
  }
}
