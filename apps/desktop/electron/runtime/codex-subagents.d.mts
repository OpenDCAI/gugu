import type { SessionUpdate } from '@agentclientprotocol/sdk';
export type CodexChildUpdate = { sessionUpdate: 'subagent_spawned' | 'subagent_state_update' | 'subagent_stream'; subagentSessionId: string; update?: SessionUpdate; [key: string]: unknown };
export function createCodexSubagents(options: {
  rootId(): string | null;
  emit(update: CodexChildUpdate): void;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  itemTool(item: Record<string, unknown>): Record<string, unknown> | null;
  reasoningText(summary: readonly string[], content: readonly string[]): string | null;
}): {
  onNotification(message: { method: string; params?: Record<string, unknown> }): boolean;
  replayItem(item: Record<string, unknown>): boolean;
  replayChildren(deadline?: number): Promise<void>;
  stop(id: string): Promise<void>;
};
