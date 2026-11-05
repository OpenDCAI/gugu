import type { ModelStatus } from '@renderer/lib/text-model/model-registry';

interface FileTabLoadingState {
  isExternal: boolean;
  isExternalLoading: boolean;
  isTextModelFile: boolean;
  diskStatus: ModelStatus | undefined;
}

export function isFileTabLoading({
  isExternal,
  isExternalLoading,
  isTextModelFile,
  diskStatus,
}: FileTabLoadingState): boolean {
  if (isExternal) return isTextModelFile && isExternalLoading;
  return isTextModelFile && (diskStatus ?? 'loading') === 'loading';
}
