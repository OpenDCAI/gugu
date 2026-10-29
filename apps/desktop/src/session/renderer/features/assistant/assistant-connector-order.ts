// #7199「连接应用 → 云端」的先后:中文用户先看到国内常用的(飞书、钉钉、企业微信、腾讯文档、滴答、高德地图、邮箱),国外的排在后面;
// 别的语言照目录原来的先后。目录本身由那台机器给(老版本也一样排),所以在这里排,❌ 改目录。纯函数,单测在同名 .test.ts。

const CHINESE_FIRST = ['feishu', 'dingtalk', 'wecom', 'tencent-docs', 'tencent-meeting', 'dida', 'amap', 'didi', 'tencent-mobility', 'luckin', 'qq-mail', 'netease-mail', 'enterprise-mail'] as const

export function connectorOrder<T extends { id: string }>(items: readonly T[], language: string): T[] {
  if (!language.toLowerCase().startsWith('zh')) return [...items]
  const rank = (id: string) => {
    const at = (CHINESE_FIRST as readonly string[]).indexOf(id)
    return at === -1 ? CHINESE_FIRST.length : at
  }
  // 同一档里保持目录原来的先后(sort 是稳定的)。
  return [...items].sort((a, b) => rank(a.id) - rank(b.id))
}
