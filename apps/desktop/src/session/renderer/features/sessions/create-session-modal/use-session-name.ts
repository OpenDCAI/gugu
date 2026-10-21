import { useCallback, useState } from 'react';
import { liveTransformSessionName } from '@renderer/utils/sessionNames';

export type SessionNameState = {
  /** The user's typed value — may be empty if they haven't typed anything yet. */
  sessionName: string;
  /** The generated name shown as placeholder when the input is empty. */
  placeholder: string;
  /** The name to use when creating: the user's value if non-empty, else the generated name. */
  effectiveSessionName: string;
  handleSessionNameChange: (value: string) => void;
  showSlugHint: boolean;
  isPending: boolean;
};

export function useSessionName(opts?: {
  generatedName?: string;
  isPending?: boolean;
  resetKey?: unknown;
  initialName?: string;
}): SessionNameState {
  const { generatedName, isPending = false, resetKey } = opts ?? {};
  const [sessionName, setSessionName] = useState('');
  const [showSlugHint, setShowSlugHint] = useState(false);
  const [prevResetKey, setPrevResetKey] = useState(resetKey);

  // Reset user input when the project/context changes.
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setSessionName('');
    setShowSlugHint(false);
  }

  const handleSessionNameChange = useCallback((value: string) => {
    const transformed = liveTransformSessionName(value);
    setSessionName(transformed);
    const hasDroppedChars = /[^a-z0-9\s-]/i.test(value);
    setShowSlugHint(hasDroppedChars);
  }, []);

  const placeholder = generatedName ?? '';
  const effectiveSessionName = sessionName.trim() || generatedName || '';

  return {
    sessionName,
    placeholder,
    effectiveSessionName,
    handleSessionNameChange,
    showSlugHint,
    isPending,
  };
}
