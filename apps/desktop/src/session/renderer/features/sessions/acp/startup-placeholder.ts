/** #5286: an engine-specific startup notice must not become the generic placeholder. */
export function startupPlaceholderKey(params: {
  historyLoading: boolean;
  noticeKey?: string;
}): string | null {
  if (!params.historyLoading) return null;
  const key = params.noticeKey?.trim();
  return key || null;
}
