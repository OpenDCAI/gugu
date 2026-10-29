import { setNativePromptPreparation, type NativePromptPreparation } from './prompt-preparation';

type Answer = { available: boolean; text?: string; beforeText?: string };

/**
 * The runtime side of native prompt preparation (#881): the host's preparation lives in another
 * process, so each provider request asks the host by event and waits for its answer. No answer in
 * time, or none available, delivers nothing; the host keeps its notice for the next turn.
 */
export function createHostPromptPreparation(deps: {
  request(event: { sessionId: string; requestId: string }): void;
  settle(event: { requestId: string; accepted: boolean }): void;
  timeoutMs?: number;
}) {
  const pending = new Map<string, (answer: Answer) => void>();
  let sequence = 0;
  function prepare(sessionId: string): Promise<NativePromptPreparation> {
    const requestId = `${Date.now().toString(36)}-${++sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => answer({ available: false }), deps.timeoutMs ?? 3000);
      function answer(value: Answer) {
        clearTimeout(timer);
        pending.delete(requestId);
        if (!value.available) return resolve({ text: '', accepted: async () => {} });
        resolve({
          text: value.text ?? '',
          ...(value.beforeText ? { beforeText: value.beforeText } : {}),
          accepted: async () => deps.settle({ requestId, accepted: true }),
          rejected: async () => deps.settle({ requestId, accepted: false }),
        });
      }
      pending.set(requestId, answer);
      deps.request({ sessionId, requestId });
    });
  }
  return {
    enable(): void { setNativePromptPreparation(prepare); },
    resolve(input: { requestId: string } & Answer): { ok: boolean } {
      const answer = pending.get(input.requestId);
      if (!answer) return { ok: false };
      answer(input);
      return { ok: true };
    },
    dispose(): void {
      setNativePromptPreparation(null);
      for (const answer of [...pending.values()]) answer({ available: false });
    },
  };
}
