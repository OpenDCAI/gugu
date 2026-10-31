/**
 * 咕咕自己开的子窗口(spec session-page「一屏几块」:一整块、一个 App 单独成窗):`window.open('about:blank', 名字)`
 * 的名字带这个前缀,主进程认这个前缀放行、配窗口外观;别的 window.open 照旧交给系统浏览器。
 */
export const AUX_WINDOW_NAME_PREFIX = 'gugu-aux:';

/** 构建角标也要浮在原生网页视图之上,不参与宿主文档里的网页遮挡判定。 */
export const BUILD_TAG_WINDOW_NAME = `${AUX_WINDOW_NAME_PREFIX}build-tag`;

/**
 * 每次开角标那层都换一个名字:界面整页重载后再开时 ❌ 撞上旧的同名那层 —— Chromium 会直接把旧的交回来
 * (不经过主进程),旧内容还在里面。
 */
export function buildTagWindowName(): string {
  return `${BUILD_TAG_WINDOW_NAME}:${crypto.randomUUID()}`;
}

export function isBuildTagWindowName(frameName: string): boolean {
  return frameName.startsWith(`${BUILD_TAG_WINDOW_NAME}:`);
}

export function isAuxWindowRequest(url: string, frameName: string): boolean {
  return (url === 'about:blank' || url === '') && frameName.startsWith(AUX_WINDOW_NAME_PREFIX);
}

/**
 * #7274 / #77 agent 操作网页时盖在网页上的两层(主进程把它们装进那扇窗最上面的一层 view,❌ 另开窗,见 window-layers.ts):
 * agent 的鼠标(`cursor`,铺满网页那一块,只在 agent 操作时露出)、「agent 正在操作」小条(`badge`,只占小条那么大)。
 * 网页是画在界面之上的独立 view,界面自己的元素盖不住它。名字带这个前缀 + 哪一层 + 一个随机串 + 页签的 browserId:
 * 每次开的名字都不一样(界面重载、热更新之后也不会撞上还开着的旧层),请主进程关层时按名字关,❌ 关掉紧接着新开的那层。
 */
export const AGENT_OVERLAY_WINDOW_NAME_PREFIX = 'gugu-agent-overlay:';

export type AgentOverlayPart = 'cursor' | 'badge';

/** 名字带 agent 浮层的前缀(不管后面写得对不对):这种 window.open ❌ 交给系统浏览器。 */
export function isAgentOverlayWindowRequest(url: string, frameName: string): boolean {
  return (url === 'about:blank' || url === '') && frameName.startsWith(AGENT_OVERLAY_WINDOW_NAME_PREFIX);
}

export function agentOverlayWindowName(browserId: string, part: AgentOverlayPart): string {
  return `${AGENT_OVERLAY_WINDOW_NAME_PREFIX}${part}:${crypto.randomUUID()}:${browserId}`;
}

export function agentOverlayOfFrame(frameName: string): { browserId: string; part: AgentOverlayPart } | null {
  const match = /^([a-z]+):([^:]+):(.+)$/.exec(frameName.slice(AGENT_OVERLAY_WINDOW_NAME_PREFIX.length));
  if (!frameName.startsWith(AGENT_OVERLAY_WINDOW_NAME_PREFIX) || !match) return null;
  const [, part, , browserId] = match;
  return part === 'cursor' || part === 'badge' ? { browserId, part } : null;
}
