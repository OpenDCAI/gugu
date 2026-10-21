import type { SessionUpdate } from '@agentclientprotocol/sdk';
export function createCodexSubagents(options: {
  rootId(): string | null;
  emit(update: SessionUpdate): void;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  itemTool(item: Record<string, unknown>): Record<string, unknown> | null;
  reasoningText(summary: readonly string[], content: readonly string[]): string | null;
}): {
  onNotification(message: { method: string; params?: Record<string, unknown> }): boolean;
  replayItem(item: Record<string, unknown>): boolean;
  replayChildren(deadline?: number): Promise<void>;
  stop(id: string): Promise<void>;
};
