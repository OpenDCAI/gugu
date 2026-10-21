import { useLayoutEffect, useState } from 'react';
import { createComputed, createMemo, createRoot } from 'solid-js';
import { pendingPromptTurn, type ChatSessionState, type SelfIdentity, type TranscriptApi } from '@gugu/session-chat-ui';
import { timelineTurnsFromTranscript, type TimelineTurn } from './session-timeline-turns';

/** Bridge the existing Solid transcript into React, including text-only updates. */
export function useTranscriptTimeline<T>(
  transcript: TranscriptApi | undefined,
  selfIdentity: () => SelfIdentity | null,
  select: (turns: TimelineTurn[]) => T,
  /** 乐观行(发出了、真的那一轮还没开出)也算一格:刻度与左边那条车道从发出那一刻就在,交接时这一列不横移。 */
  session?: Pick<ChatSessionState, 'state'>,
): T {
  const [snapshot, setSnapshot] = useState<{
    transcript: TranscriptApi | undefined;
    value: T;
  }>({ transcript: undefined, value: select([]) });

  useLayoutEffect(() => {
    if (!transcript) return;
    return createRoot((dispose) => {
      // Streaming only reprojects the active turn, not the entire history.
      const committed = createMemo(() =>
        timelineTurnsFromTranscript(transcript.state.committedTurns, selfIdentity()),
      );
      const active = createMemo(() => {
        const pending = session?.state.pendingPrompt;
        const turn = transcript.state.activeTurnSnapshot ?? (pending ? pendingPromptTurn(pending) : null);
        return timelineTurnsFromTranscript(turn ? [turn] : [], selfIdentity());
      });
      const selected = createMemo(() => select([...committed(), ...active()]));
      createComputed(() => setSnapshot({ transcript, value: selected() }));
      return dispose;
    });
  }, [transcript, selfIdentity, select, session]);

  return snapshot.transcript === transcript ? snapshot.value : select([]);
}
