import { useLayoutEffect, useState } from 'react';
import { createComputed, createMemo, createRoot } from 'solid-js';
import type { TranscriptApi } from '@gugu/session-chat-ui';
import { lastTurnSignInRequired } from '@renderer/lib/stores/harness-auth-expiry';

/**
 * #6264 这条会话最近一轮是不是因为「登录不能用了」失败的 —— 把 Solid 的转录桥进 React
 * (与 `useTranscriptTimeline` 同一个接法,只读已提交那几轮,流式输出不触发重算)。
 */
export function useLastTurnSignInRequired(transcript: TranscriptApi | undefined): boolean {
  const [value, setValue] = useState(false);
  useLayoutEffect(() => {
    setValue(false);
    if (!transcript) return;
    return createRoot((dispose) => {
      const needs = createMemo(() => lastTurnSignInRequired(transcript.state.committedTurns));
      createComputed(() => setValue(needs()));
      return dispose;
    });
  }, [transcript]);
  return value;
}
