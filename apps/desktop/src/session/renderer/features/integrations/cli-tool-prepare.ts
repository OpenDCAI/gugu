/**
 * 起命令行登录之前先把工具装好,一问一答、不绑在一次调用上。
 *
 * 远程机器(云电脑拉 GitHub 只有几十 KB/s)装一次要十来分钟。从前装和起登录是同一次 `cliLoginStart`:
 * 这期间到那台机器的链路只要断一次,在途调用全判失败,界面只能说「此刻连不上」,重点一次又从头等(2026-10-28 owner 在 Beta 上撞到)。
 * 现在先问 `cliToolPrepare`(每问最多 20 秒,装在那台机器后台跑),断了等链路回来接着问;装好了再起登录,那一步当场就回。
 * 那台机器还不认这一问(旧版本)就照旧直接起登录。
 */

export type CliToolPrepareResult = { status: 'ready' } | { status: 'installing' } | { status: 'failed'; error: string };

type CliToolPrepareApi<Start> = {
  cliToolPrepare?: (integrationId: string) => Promise<CliToolPrepareResult>;
  cliLoginStart: (integrationId: string) => Promise<Start>;
};

/** 连着答不上多久就放弃(链路断了在重连;回来了接着问)。只按「多久没答上」判,❌ 按总时长:慢下载要能下完。 */
export const CLI_PREPARE_LINK_BUDGET_MS = 90_000;
const RETRY_DELAY_MS = 2_000;

export async function prepareThenStartCliLogin<Start>(
  api: CliToolPrepareApi<Start>,
  integrationId: string,
  options: {
    /** 这一次被取消 / 取代了:不再问,也不再起登录。 */
    cancelled?: () => boolean;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<Start | { success: false; error: string } | null> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cancelled = options.cancelled ?? (() => false);
  if (api.cliToolPrepare) {
    let lastAnswer = now();
    for (;;) {
      if (cancelled()) return null;
      let result: CliToolPrepareResult;
      try {
        result = await api.cliToolPrepare(integrationId);
      } catch (error) {
        // 旧版本的那台不认这一问:照旧直接起登录(装和起登录还在同一次调用里)。
        if (doesNotKnowPrepare(error)) break;
        if (now() - lastAnswer >= CLI_PREPARE_LINK_BUDGET_MS) throw error;
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      lastAnswer = now();
      if (result.status === 'failed') return { success: false, error: result.error };
      if (result.status === 'ready') break;
    }
  }
  if (cancelled()) return null;
  return api.cliLoginStart(integrationId);
}

function doesNotKnowPrepare(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  return code === 'unknown_method' || message.startsWith('No handler registered for ');
}
