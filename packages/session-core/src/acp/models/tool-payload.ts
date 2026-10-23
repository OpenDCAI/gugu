/** Shared display formatting for decoded tool payloads. */
export function serializePayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

export function toolOutputText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text.trim());
  return match ? match[1] : text;
}

/** Read the recorded answer, before display formatting strips a code fence. */
export function hasRecordedAnswers(output: string | null | undefined): boolean {
  if (output == null) return false;
  try {
    const answers = JSON.parse(output)?.answers;
    return answers !== null && typeof answers === 'object' && !Array.isArray(answers) && Object.keys(answers).length > 0;
  } catch {
    return false;
  }
}
