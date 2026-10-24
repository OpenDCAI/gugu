import type { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2';
export function createCodexSubagents(options: {
  rootId(): string | null;
  emit(update: SessionUpdate, sessionId: string): void;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  itemTool(item: Record<string, unknown>): Record<string, unknown> | null;
  reasoningText(summary: readonly string[], content: readonly string[]): string | null;
}): {
  onNotification(message: { method: string; params?: Record<string, unknown> }): boolean;
  replayItem(item: Record<string, unknown>): boolean;
  replayChildren(deadline?: number): Promise<void>;
  stop(id: string): Promise<void>;
};
