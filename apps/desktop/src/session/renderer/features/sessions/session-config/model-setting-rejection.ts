export type ModelSettingRejection = {
  kind: 'model-unavailable';
  requestedValue: string;
};

/** Read only the adapter's setting result, never classify arbitrary failure text. */
export function modelSettingRejection(error: unknown, depth = 0): ModelSettingRejection | null {
  if (depth > 3 || !error || typeof error !== 'object') return null;
  const record = error as { data?: unknown; cause?: unknown };
  const data = record.data;
  if (data && typeof data === 'object') {
    const candidate = data as Record<string, unknown>;
    if (candidate.kind === 'model-unavailable'
      && typeof candidate.requestedValue === 'string') {
      return { kind: 'model-unavailable', requestedValue: candidate.requestedValue };
    }
  }
  return modelSettingRejection(record.cause, depth + 1);
}
