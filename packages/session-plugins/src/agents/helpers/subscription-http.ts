import { EnvHttpProxyAgent, fetch } from 'undici';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';

/** A quota read uses the selected machine's proxy, never the renderer's network or credentials. */
export async function requestSubscriptionJson(
  ctx: Pick<AgentAuthContext, 'env'>,
  url: string,
  headers: Record<string, string>
): Promise<unknown> {
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: ctx.env.http_proxy ?? ctx.env.HTTP_PROXY ?? '',
    httpsProxy: ctx.env.https_proxy ?? ctx.env.HTTPS_PROXY ?? '',
    noProxy: ctx.env.no_proxy ?? ctx.env.NO_PROXY ?? '',
  });
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      dispatcher,
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    // Vendor bodies and request headers can contain credentials. Only publish status, not raw errors.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(response.status === 401 || response.status === 403
        ? `额度查询未通过认证（HTTP ${response.status}），请重新登录。`
        : response.status === 429 ? '厂商暂时限制额度查询，请稍后刷新。' : `额度查询失败（HTTP ${response.status}）。`);
    }
    return await response.json();
  } finally {
    await dispatcher.close();
  }
}
