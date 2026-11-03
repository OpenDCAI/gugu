import { useLayoutEffect, useState } from 'react';
import { createComputed, createMemo, createRoot, createSignal } from 'solid-js';
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import { readSelfIdentityBridge } from '@/lib/selfIdentityBridge';
import type { TimelineRailOptions } from '@gugu/core/shared/timelineRail';
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
      const directory = readIdentityDirectoryBridge();
      const [identityRevision, setIdentityRevision] = createSignal(0);
      const refreshIdentity = () => setIdentityRevision((revision) => revision + 1);
      const offDirectory = directory?.subscribe(refreshIdentity);
      const offSelf = readSelfIdentityBridge()?.subscribe(refreshIdentity);
      const options: TimelineRailOptions = {
        resolveSenderType: (fromId) => {
          if (!fromId.startsWith('user:')) return null;
          const id = fromId.slice(5);
          const identity = directory?.getSnapshot()?.[id];
          if (!identity) directory?.ensure([id]);
          return identity?.type;
        },
      };
      // Streaming only reprojects the active turn, not the entire history.
      const committed = createMemo(() => {
        identityRevision();
        return timelineTurnsFromTranscript(transcript.state.committedTurns, selfIdentity(), options);
      });
      const active = createMemo(() => {
        identityRevision();
        const pending = session?.state.pendingPrompt;
        const turn = transcript.state.activeTurnSnapshot ?? (pending ? pendingPromptTurn(pending) : null);
        return timelineTurnsFromTranscript(turn ? [turn] : [], selfIdentity(), options);
      });
      const selected = createMemo(() => select([...committed(), ...active()]));
      createComputed(() => setSnapshot({ transcript, value: selected() }));
      return () => { offDirectory?.(); offSelf?.(); dispose(); };
    });
  }, [transcript, selfIdentity, select, session]);

  return snapshot.transcript === transcript ? snapshot.value : select([]);
}
