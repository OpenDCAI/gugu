import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { type PromptLibraryPrompt } from '@shared/prompt-library';

/**
 * 提示词是**这台机器上**存的(#6264 整个资源库都分机器):资源库选了别的机器,读写的就是那台机器上的那一份;
 * 其余地方(输入框的「添加上下文」、聊天面板)用本机的。缓存按机器分开,两份不会互相盖。
 */
export function usePromptLibrary() {
  const queryClient = useQueryClient();
  const host = useLibraryHost();
  const promptLibraryQueryKey = ['promptLibrary', host.key] as const;
  const { data, isLoading, error } = useQuery({
    queryKey: promptLibraryQueryKey,
    queryFn: () => host.prompts.get(),
    staleTime: 5 * 60_000,
    // 那台机器离线就不问(问不到,只会挂满超时);有上次的读数照旧画。
    enabled: host.remote?.online !== false,
    ...(host.remote ? { retry: false } : {}),
  });

  const updateMutation = useMutation<
    void,
    Error,
    PromptLibraryPrompt[],
    { previousPrompts: PromptLibraryPrompt[] | undefined }
  >({
    mutationFn: (prompts) => host.prompts.update(prompts),
    onMutate: async (prompts) => {
      await queryClient.cancelQueries({ queryKey: promptLibraryQueryKey });
      const previousPrompts =
        queryClient.getQueryData<PromptLibraryPrompt[]>(promptLibraryQueryKey);
      queryClient.setQueryData(promptLibraryQueryKey, prompts);
      return { previousPrompts };
    },
    onError: (_error, _prompts, context) => {
      queryClient.setQueryData(promptLibraryQueryKey, context?.previousPrompts);
      void queryClient.invalidateQueries({ queryKey: promptLibraryQueryKey });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: promptLibraryQueryKey });
    },
  });

  return {
    value: data ?? [],
    update: updateMutation.mutate,
    isLoading,
    isSaving: updateMutation.isPending,
    error,
    hasData: data !== undefined,
    reload: () => void queryClient.invalidateQueries({ queryKey: promptLibraryQueryKey }),
  };
}
