import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';

/**
 * 首页精选按近期安装量排(owner 10-19「按建议」)。
 * 库里只有一张 `chat.app_installs`(一个账号第一次从市场装一个 App 记一行)和两个函数;客户端只经这两个函数读写,碰不到行。
 */
async function chatClient() {
  const token = await currentAccountAccessToken();
  if (!token) throw new Error('Not signed in, so the market install ranking cannot be read or written');
  return createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } });
}

/** 这个账号从市场装了这个 App(第一次):记一票。同一账号同一 App 再装、更新、换台电脑装,库里什么也不变。 */
export async function recordMarketInstall(appId: string): Promise<void> {
  const { error } = await (await chatClient()).rpc('record_market_install', { p_app_id: appId });
  if (error) throw new Error(error.message);
}

/** 每个 App 的近期安装分数(近 14 天去重账号、7 天减半;不到 3 个账号的不在里面),按 App id。 */
export async function readMarketRanking(): Promise<Map<string, number>> {
  const { data, error } = await (await chatClient()).rpc('market_install_ranking');
  if (error) throw new Error(error.message);
  return new Map(((data as { app_id: string; score: number }[] | null) ?? []).map((row) => [row.app_id, row.score]));
}
