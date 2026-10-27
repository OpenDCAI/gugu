export declare function runWithGuguToolInvocation<T>(
  extra: { requestId?: number | string; sessionId?: string; _meta?: Record<string, unknown> },
  connectionScope: string,
  run: () => T,
): T
export declare function currentGuguToolInvocation(): string | undefined
