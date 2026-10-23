import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { HarnessModelCredentialStatus } from '@gugu/session-core/agents/plugins';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { log } from '@renderer/utils/logger';
import { useLibraryHost } from '@renderer/features/library/library-host';

const MODEL_CREDENTIAL_QUERY_KEY = ['agents', 'modelCredential'] as const;

/**
 * 这一家所有模型的凭据读数 —— 登录动作之后要**整家**作废,❌ 不只当前那个 modelId:
 * 登录改变的是这家的整个凭据面。抽屉的「账号」行(#6100)与下面的 `refresh` 用的是同一把。
 */
export function harnessModelCredentialKey(providerId: string): readonly unknown[] {
  return [...MODEL_CREDENTIAL_QUERY_KEY, providerId];
}

/**
 * 「这家 harness 自报的某个自家模型,其 provider 在本机有没有凭据」—— composer 默认预选规则
 * (product spec「模型来源与 UI」,#4956)的渲染层读数。
 *
 * 三态语义:只有 `'uncredentialed'` 携带动作(默认预选挪到平台目录首条);`'credentialed'`
 * 与 `'unknown'` 都维持这家自家默认。读数在途(还没回来)时也按 `'unknown'` 报 ——
 * 「还不知道」与「判不出」的产品后果本来就相同,❌ 不为在途状态多造一个档。
 *
 * 通道失败(agent-config wire 不在 / runtime 掉线 / RPC 抛出)同样落 `'unknown'`:这条读数的
 * 诚实退化就是维持现状,与今天逐字节一致;失败本身在 queryFn 里就地捕获并记日志,❌ 不静默 ——
 * 靠 react-query 的 error 态兜不住:`retry: false` 下它一声不吭地停在那里。
 *
 * `refresh`:用户刚在登录终端里登完这家(auth.json 变了),凭据读数必须跟着作废 ——
 * 只刷目录不刷它,composer 会拿着一份陈的 'uncredentialed' 继续把默认按在平台上。
 */
export function useHarnessModelCredential(
  providerId: string | null | undefined,
  modelId: string | null | undefined
): { status: HarnessModelCredentialStatus; refresh: () => void } {
  const client = useQueryClient();
  // #6264 会话 / 新建框在别的机器上:凭据在那台机器上,问那台机器的 agent-config 运行时。
  const host = useLibraryHost().remote;
  const machine = host?.deviceId ?? null;
  const query = useQuery<HarnessModelCredentialStatus>({
    queryKey: [...MODEL_CREDENTIAL_QUERY_KEY, providerId ?? '', modelId ?? '', ...(machine ? ['remote', machine] : [])],
    // 那台机器没连上就不问(同 use-harness-model-catalog);连上时自己重取。
    enabled: !!providerId && !!modelId && host?.online !== false,
    retry: false,
    // 凭据在登录动作之后才会变;60s 内的重挂载不必重读盘。登录动作走下面的 refresh。
    staleTime: 60_000,
    // 与隔壁 use-harness-model-catalog 同一条理由:切个窗口就重读一遍 auth.json + 整份
    // models.dev 快照纯属浪费 —— 凭据只在登录动作后变,而那条路已由 refresh 覆盖。
    refetchOnWindowFocus: false,
    queryFn: async () => {
      try {
        const runtime = await getAgentConfigRuntimeClient(machine);
        const result = await runtime.modelCredential({
          providerId: providerId as string,
          modelId: modelId as string,
        });
        if (!result.success) {
          log.warn(
            `modelCredential(${providerId}, ${modelId}) 读数失败,按 unknown(维持自家默认)处理`,
            result.error
          );
          return 'unknown';
        }
        return result.data;
      } catch (error) {
        log.warn(
          `modelCredential(${providerId}, ${modelId}) 通道失败,按 unknown(维持自家默认)处理`,
          error
        );
        return 'unknown';
      }
    },
  });
  return {
    status: query.data ?? 'unknown',
    // 按 provider 前缀作废(该家所有模型的读数一起),❌ 不只作废当前 modelId:登录改变的是
    // 这家的整个凭据面。
    refresh: () => {
      void client.invalidateQueries({ queryKey: harnessModelCredentialKey(providerId ?? '') });
    },
  };
}
