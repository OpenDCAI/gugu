export function resumeReplayRequest(params: unknown):
  | { replay: boolean }
  | { error: { code: number; message: string } };
export function replayHistoryWithinBudget(
  deadline: number,
  replay: () => Promise<string | null | undefined>,
  now?: () => number,
): Promise<{ status: 'known' } | { status: 'unknown'; reason: string }>;
export function historyUnknownError(sessionId: string, reason: string): {
  code: number; message: string; data: { kind: 'history_unknown'; sessionId: string; reason: string };
};
