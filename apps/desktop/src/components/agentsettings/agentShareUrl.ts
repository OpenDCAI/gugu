// #1078 对外分享链接构造 helpers —— 纯逻辑,与组件分离(便于单测 + 满足 react-refresh)。

// 公开 web 基址(外部人点链接的落点)。来自构建期 env;未配置 = 公开 web 未部署。
export function externalShareBaseUrl(): string {
  const raw = (import.meta.env.VITE_GUGU_WEB_URL as string | undefined) ?? ''
  return raw.trim().replace(/\/+$/, '')
}

// 对外分享公开链接。base 为空(公开 web 未配置/未部署)→ null,由调用方 fail-loud(不展示死链接)。
// 形态对齐设计稿:<base>/join/agent/<id>(复用现有 AgentJoinPage 公开路由)。
export function buildAgentShareUrl(base: string, agentId: string): string | null {
  const b = base.trim().replace(/\/+$/, '')
  if (!b || !agentId) return null
  return `${b}/join/agent/${agentId}`
}
